// anon-rpc-launch applies a deny-by-default Landlock ruleset to itself, then
// execs a command — normally `node --permission worker-host.mjs`.
//
// This exists because a Node harness cannot confine its own worker process from
// inside Node: the Landlock syscalls need FFI or a native addon, and
// `--permission` denies both. So whatever installs the sandbox has to be a
// separate program that then *becomes* node. Landlock rules survive execve and
// cannot be revoked, so everything past the exec inherits them irreversibly.
//
// Two properties make this fit anon-rpc's capability model:
//
//   - Landlock governs *opening* paths, not existing file descriptors. The
//     harness opens the IPC socket (and a socketpair per KPS stream) before
//     spawning, and those keep working inside the sandbox while the filesystem
//     is otherwise shut. Handed-in fds become the only authority — the same
//     invariant the browser harness gets from a null-origin iframe.
//   - It needs no privilege: no root, no setuid, no namespaces, no daemon.
//
// Go rather than Rust so that CGO_ENABLED=0 yields one static binary per
// GOOS/GOARCH from a single build machine, with no libc coupling — a
// glibc-linked launcher would not run on an alpine-based image, which is
// exactly where this is likely to be deployed.
//
// Usage:
//
//	anon-rpc-launch [--ro PATH]... [--rw PATH]... [--restrict-net]
//	                [--connect-port N]... [--bind-port N]... -- CMD [ARGS]...
//
// The filesystem is deny-by-default always. The network is left ALONE unless
// --restrict-net is passed: a worker whose whole job is to reach an anonymizing
// network needs outbound sockets, and §6 does not deny it them. The flag exists
// so the cost of restricting it can be measured.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"

	"github.com/landlock-lsm/go-landlock/landlock"
	"golang.org/x/sys/unix"
)

type args struct {
	ro, rw       []string
	restrictNet  bool
	noUDP        bool
	noUnix       bool
	connectPorts []uint16
	bindPorts    []uint16
	cmd          []string
}

func usage(msg string) {
	fmt.Fprintf(os.Stderr, "anon-rpc-launch: %s\n", msg)
	fmt.Fprintln(os.Stderr, "usage: anon-rpc-launch [--ro PATH]... [--rw PATH]... [--restrict-net] [--no-udp] [--no-unix] "+
		"[--connect-port N]... [--bind-port N]... -- CMD [ARGS]...")
	os.Exit(2)
}

func parse(argv []string) args {
	var a args
	for i := 0; i < len(argv); i++ {
		next := func(name string) string {
			if i+1 >= len(argv) {
				usage(name + " needs a value")
			}
			i++
			return argv[i]
		}
		port := func(name string) uint16 {
			v, err := strconv.ParseUint(next(name), 10, 16)
			if err != nil {
				usage("not a port number for " + name)
			}
			return uint16(v)
		}
		switch argv[i] {
		case "--ro":
			a.ro = append(a.ro, next("--ro"))
		case "--rw":
			a.rw = append(a.rw, next("--rw"))
		case "--restrict-net":
			a.restrictNet = true
		case "--no-udp":
			a.noUDP = true
		case "--no-unix":
			a.noUnix = true
		case "--connect-port":
			a.connectPorts = append(a.connectPorts, port("--connect-port"))
		case "--bind-port":
			a.bindPorts = append(a.bindPorts, port("--bind-port"))
		case "--":
			a.cmd = argv[i+1:]
			i = len(argv)
		default:
			usage("unknown option " + argv[i])
		}
	}
	if len(a.cmd) == 0 {
		usage("no command given (did you forget `--`?)")
	}
	return a
}

// Landlock distinguishes directories from files, and naming a file with the
// directory helper is an error — so each grant is classified by what it is. A
// path that does not exist is fatal rather than skipped: silently dropping a
// grant would produce a sandbox that differs from the one that was asked for.
func rules(paths []string, dirs func(...string) landlock.FSRule, files func(...string) landlock.FSRule) ([]landlock.Rule, error) {
	var out []landlock.Rule
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			return nil, fmt.Errorf("grant %q: %w", p, err)
		}
		if st.IsDir() {
			out = append(out, dirs(p))
		} else {
			out = append(out, files(p))
		}
	}
	return out, nil
}

func main() {
	a := parse(os.Args[1:])

	roRules, err := rules(a.ro, landlock.RODirs, landlock.ROFiles)
	if err != nil {
		fatal(err)
	}
	rwRules, err := rules(a.rw, landlock.RWDirs, landlock.RWFiles)
	if err != nil {
		fatal(err)
	}
	fsRules := append(roRules, rwRules...)

	// The best ABI this kernel supports, never BestEffort: best effort would
	// return success having quietly granted more than requested, and the
	// harness would claim an isolation it does not have. Here the config is
	// chosen to match the kernel and then applied strictly, so a failure is a
	// real failure — and a newer kernel is actually used rather than being
	// held down to the oldest version we know how to ask for.
	//
	// This matters for UDP specifically: network rights are TCP-only from ABI
	// 4 to 9, and only ABI 10 adds UDP bind and connect/send. Pinning V4 would
	// leave UDP open on every kernel, including ones that could close it.
	abi, cfg := bestConfig()

	// RestrictPaths governs the filesystem and leaves the network alone;
	// Restrict governs both. Choosing between them is what keeps outbound
	// sockets working by default — a V4 config applied to the network with no
	// ConnectTCP rules would deny every connection the worker needs.
	var err2 error
	if a.restrictNet {
		netRules := make([]landlock.Rule, 0, len(a.connectPorts)+len(a.bindPorts))
		for _, p := range a.connectPorts {
			netRules = append(netRules, landlock.ConnectTCP(p))
		}
		for _, p := range a.bindPorts {
			netRules = append(netRules, landlock.BindTCP(p))
		}
		err2 = cfg.Restrict(append(fsRules, netRules...)...)
	} else {
		err2 = cfg.RestrictPaths(fsRules...)
	}
	if err2 != nil {
		fatal(fmt.Errorf("landlock restrict: %w", err2))
	}

	// No setuid/setgid escalation from here on, for us or anything we exec.
	// Also a precondition for loading an unprivileged seccomp filter below.
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fatal(fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS): %w", err))
	}

	// The seccomp filter is ALWAYS installed: most of it denies syscalls that
	// act on the rest of the system (ptrace, io_uring, the keyring,
	// namespaces) and nothing legitimate needs those in either posture. The
	// socket rules within it are the conditional part.
	//
	// Applied after landlock, so a failure here cannot leave a half-configured
	// sandbox that still reports as enforced.
	if err := installSeccompFilter(a.noUDP, a.noUnix); err != nil {
		fatal(fmt.Errorf("seccomp: %w", err))
	}
	udpDenied := a.noUDP || (a.restrictNet && abi >= 10)

	// Read by the harness, which treats anything but this line as a hard error
	// rather than a log message. The detail after it says what the kernel could
	// actually enforce, so "no ambient network" is never reported as stronger
	// than it is: below ABI 10 it means no ambient TCP.
	net := "unrestricted"
	if a.restrictNet {
		net = "tcp"
		if udpDenied {
			net = "tcp+udp"
		}
	} else if udpDenied {
		net = "udp"
	}
	fmt.Fprintf(os.Stderr,
		"anon-rpc-launch: landlock fully enforced (abi %d, fs, net: %s, syscalls: %d denied)\n",
		abi, net, len(deniedCalls))

	bin, err := exec.LookPath(a.cmd[0])
	if err != nil {
		fatal(fmt.Errorf("exec %q: %w", a.cmd[0], err))
	}
	// Exec only returns on failure. The environment is passed through as-is:
	// scrubbing it is the harness's job at spawn time, since it is the harness
	// that knows what (if anything) the worker is meant to see.
	if err := syscall.Exec(bin, a.cmd, os.Environ()); err != nil {
		fatal(fmt.Errorf("exec %q: %w", bin, err))
	}
}

// ABI presets, indexed by version. go-landlock exposes one Config per ABI; a
// kernel newer than this table is capped at the newest we know how to ask for,
// which under-restricts rather than failing — the alternative would be that a
// future kernel cannot run this at all.
var abiConfigs = []landlock.Config{
	landlock.V1, landlock.V1, landlock.V2, landlock.V3, landlock.V4, landlock.V5,
	landlock.V6, landlock.V7, landlock.V8, landlock.V9, landlock.V10,
}

// The minimum this harness is willing to call confinement: ABI 4 is where
// network restrictions arrive, and without them a worker could dial the host's
// own loopback and LAN regardless of what the filesystem rules say.
const minABI = 4

func bestConfig() (int, landlock.Config) {
	v, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, unix.LANDLOCK_CREATE_RULESET_VERSION)
	if errno != 0 {
		fatal(fmt.Errorf("landlock unavailable: %w", errno))
	}
	abi := int(v)
	if abi < minABI {
		fatal(fmt.Errorf("landlock abi %d is too old (need %d+, i.e. linux 6.7+)", abi, minABI))
	}
	if abi >= len(abiConfigs) {
		abi = len(abiConfigs) - 1
	}
	return abi, abiConfigs[abi]
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "anon-rpc-launch: %v\n", err)
	if errors.Is(err, unix.ENOSYS) {
		fmt.Fprintln(os.Stderr, "  (this kernel has no Landlock support: 5.13+ required, 6.7+ for ABI 4)")
	}
	os.Exit(1)
}
