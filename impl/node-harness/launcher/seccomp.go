package main

// The seccomp layer: what Landlock cannot express, plus the syscalls a confined
// worker has no business making.
//
// Three jobs, in rising order of how obvious they are:
//
//  1. UDP. Landlock's network rights are TCP-only from ABI 4 to ABI 9; UDP
//     arrives in ABI 10, which is Linux 7.2. Ubuntu 24.04 LTS ships 6.8 and its
//     HWE kernel is 7.0, so UDP being open is the normal case, not a rare
//     degraded one.
//  2. Abstract unix sockets. They have no path for a Landlock filesystem rule
//     to match, and scoping them needs ABI 6. Path-bound unix sockets are
//     already covered, since reaching one requires a path that is not granted.
//  3. Syscalls that act on the rest of the system rather than on this process:
//     reading another process's memory, io_uring, the keyring, namespaces.
//     Several are closed on a typical host by sysctls — yama's ptrace_scope,
//     perf_event_paranoid, unprivileged_userfaultfd — but those are the
//     distro's choices, not ours, and a deployment may have set any of them
//     differently. A sandbox that depends on them has unknown properties.
//     Measured: with only Landlock and the socket rules, a probe inside the
//     sandbox reached exactly what the same probe reached outside it.
//
// What seccomp CANNOT do here is the address policy: a BPF filter cannot
// dereference the sockaddr pointer that connect() takes, so "which host may the
// worker reach" lives in the host process (see address-policy.ts). seccomp
// answers whether a facility exists, never what it is pointed at.
//
// This is still a deny-list — the one axis of this sandbox not expressed as an
// allow-list, since the filesystem and the network both are. README.md says why
// inverting it wants its own measured ladder rather than a guess.

import (
	"fmt"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// seccomp_data field offsets (see linux/seccomp.h). Arguments are 64-bit; on a
// little-endian target the low word of arg N sits at its base offset, which is
// all these comparisons need — domain, type and pid are all ints.
const (
	offNR   = 0
	offArch = 4
	offArg0 = 16
	offArg1 = 24
)

const (
	afUnix       = 1
	afInet       = 2
	afInet6      = 10
	sockDgram    = 2
	sockTypeMask = 0xf // type carries SOCK_NONBLOCK/SOCK_CLOEXEC too
)

// Denied outright. Nothing node needs at startup or in steady state is in here;
// the e2e and probe/run.mjs are what establish that rather than assumption, so
// a change to this list should be re-run against both.
//
// Numbers come from x/sys/unix, which is per-GOARCH, so each cross-compiled
// binary gets its own arch's numbering — and the filter pins the arch before
// trusting any of them.
var deniedCalls = []uintptr{
	// Reading or steering another process. The worst outcome in this threat
	// model is the worker reading the HOST's memory, where an embedding
	// wallet's keys live, which §6 forbids by name. On this host yama's
	// ptrace_scope=1 already refuses it; on a host set to 0 it would not.
	unix.SYS_PTRACE,
	unix.SYS_PROCESS_VM_READV,
	unix.SYS_PROCESS_VM_WRITEV,
	unix.SYS_PIDFD_OPEN,
	unix.SYS_PIDFD_GETFD, // takes descriptors straight out of another process
	unix.SYS_PIDFD_SEND_SIGNAL,

	// io_uring is an alternate submission path for file and network work, and
	// is blocked by Docker's and Chrome's sandboxes as an escape class. libuv
	// probes it for some fs operations and falls back when it fails.
	unix.SYS_IO_URING_SETUP,
	unix.SYS_IO_URING_ENTER,
	unix.SYS_IO_URING_REGISTER,

	// Kernel facilities gated by sysctl on a typical host, which is not the
	// same as gated by us.
	unix.SYS_PERF_EVENT_OPEN,
	unix.SYS_BPF,
	unix.SYS_USERFAULTFD,
	unix.SYS_KEYCTL,
	unix.SYS_ADD_KEY,
	unix.SYS_REQUEST_KEY,

	// Namespaces and mounts: rearranging the view of the system that the
	// Landlock ruleset was written against.
	unix.SYS_UNSHARE,
	unix.SYS_SETNS,
	unix.SYS_MOUNT,
	unix.SYS_UMOUNT2,
	unix.SYS_PIVOT_ROOT,

	// A file handle reaches a file without walking a path, which is how
	// path-based rules are stated. Both need privilege today; denying them
	// costs nothing and drops the dependency on that staying true.
	unix.SYS_NAME_TO_HANDLE_AT,
	unix.SYS_OPEN_BY_HANDLE_AT,

	// Anonymous memory that can be mapped executable, which is a standard step
	// in an exploit chain. Denying it is only worth anything alongside the
	// exec denial --permission already provides, and neither node nor V8 needs
	// it — the e2e is what confirms that.
	unix.SYS_MEMFD_CREATE,
}

// auditArch reports the AUDIT_ARCH_* value this binary was built for. The
// filter checks it first: syscall numbers are per-ABI, so a filter that did not
// pin the arch could be sidestepped by entering a different one.
func auditArch() (uint32, error) {
	switch runtime.GOARCH {
	case "amd64":
		return unix.AUDIT_ARCH_X86_64, nil
	case "arm64":
		return unix.AUDIT_ARCH_AARCH64, nil
	default:
		return 0, fmt.Errorf("no seccomp filter for GOARCH=%s", runtime.GOARCH)
	}
}

/* --- a tiny assembler --------------------------------------------------- */

// Classic BPF counts jump offsets in instructions from the one AFTER the jump,
// and an offset landing one instruction early silently allows exactly what it
// was written to deny — which happened once while writing this file. So jumps
// name their target and the offsets are computed.
type asmIns struct {
	code   uint16
	k      uint32
	jt, jf string // "" means fall through to the next instruction
	label  string // this instruction's own label, if any
}

func assemble(prog []asmIns) ([]unix.SockFilter, error) {
	at := map[string]int{}
	for i, in := range prog {
		if in.label == "" {
			continue
		}
		if _, dup := at[in.label]; dup {
			return nil, fmt.Errorf("duplicate label %q", in.label)
		}
		at[in.label] = i
	}
	out := make([]unix.SockFilter, len(prog))
	for i, in := range prog {
		off := func(target string) (uint8, error) {
			if target == "" {
				return 0, nil
			}
			idx, ok := at[target]
			if !ok {
				return 0, fmt.Errorf("instruction %d jumps to unknown label %q", i, target)
			}
			d := idx - (i + 1)
			if d < 0 || d > 255 {
				return 0, fmt.Errorf("instruction %d: jump to %q out of range (%d)", i, target, d)
			}
			return uint8(d), nil
		}
		jt, err := off(in.jt)
		if err != nil {
			return nil, err
		}
		jf, err := off(in.jf)
		if err != nil {
			return nil, err
		}
		out[i] = unix.SockFilter{Code: in.code, Jt: jt, Jf: jf, K: in.k}
	}
	return out, nil
}

/* --- the program -------------------------------------------------------- */

type filterOpts struct {
	noUDP  bool
	noUnix bool
	ownPID uint32
}

func buildFilter(arch uint32, o filterOpts) ([]unix.SockFilter, error) {
	const (
		ld  = unix.BPF_LD | unix.BPF_W | unix.BPF_ABS
		jeq = unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K
		and = unix.BPF_ALU | unix.BPF_AND | unix.BPF_K
		ret = unix.BPF_RET | unix.BPF_K
	)
	// ERRNO rather than KILL_PROCESS: a worker that probes a denied facility
	// gets a failure it can handle, the same shape Landlock's refusal has, and
	// a diagnosable error rather than a process that vanished. KILL is kept for
	// the arch mismatch, which legitimate code does not do.
	deny := uint32(unix.SECCOMP_RET_ERRNO | uint32(unix.EACCES))
	allow := uint32(unix.SECCOMP_RET_ALLOW)

	prog := []asmIns{
		{code: ld, k: offArch},
		{code: jeq, k: arch, jf: "kill"},
		{code: ld, k: offNR},
	}
	for _, nr := range deniedCalls {
		prog = append(prog, asmIns{code: jeq, k: uint32(nr), jt: "deny"})
	}

	prog = append(prog,
		// Signals to self are allowed, to anything else denied. Self-signalling
		// has to work: glibc's abort() raises SIGABRT via tgkill and node uses
		// abort() for fatal errors, so denying it outright would turn a clean
		// crash into a hang. The pid is known here because execve does not
		// change it — the launcher and the node it becomes are one process.
		asmIns{code: jeq, k: uint32(unix.SYS_KILL), jt: "self"},
		asmIns{code: jeq, k: uint32(unix.SYS_TGKILL), jt: "self"},
		asmIns{code: jeq, k: uint32(unix.SYS_SOCKET), jt: "sock"},
		asmIns{code: ret, k: allow},

		asmIns{label: "self", code: ld, k: offArg0},
		asmIns{code: jeq, k: o.ownPID, jt: "allow", jf: "deny"},
	)

	// socket(): the domain decides. The child never legitimately creates a
	// socket of any kind — its IPC channel is an inherited descriptor, and a
	// bridged socket is *received* on that channel rather than created.
	unixTarget, dgramTarget := "allow", "allow"
	if o.noUnix {
		unixTarget = "deny"
	}
	if o.noUDP {
		dgramTarget = "deny"
	}
	prog = append(prog,
		asmIns{label: "sock", code: ld, k: offArg0},
		asmIns{code: jeq, k: afUnix, jt: unixTarget},
		asmIns{code: jeq, k: afInet, jt: "socktype"},
		asmIns{code: jeq, k: afInet6, jt: "socktype"},
		asmIns{code: ret, k: allow},

		asmIns{label: "socktype", code: ld, k: offArg1},
		asmIns{code: and, k: sockTypeMask},
		asmIns{code: jeq, k: sockDgram, jt: dgramTarget},

		asmIns{label: "allow", code: ret, k: allow},
		asmIns{label: "deny", code: ret, k: deny},
		asmIns{label: "kill", code: ret, k: unix.SECCOMP_RET_KILL_PROCESS},
	)
	return assemble(prog)
}

// installSeccompFilter loads the filter into the current process. Like the
// Landlock ruleset it is irrevocable and inherited across execve, so node — and
// anything it could contrive to run — inherits it.
//
// PR_SET_NO_NEW_PRIVS must already be set; the kernel refuses an unprivileged
// filter otherwise. main() sets it before calling this.
func installSeccompFilter(noUDP, noUnix bool) error {
	arch, err := auditArch()
	if err != nil {
		return err
	}
	filter, err := buildFilter(arch, filterOpts{
		noUDP:  noUDP,
		noUnix: noUnix,
		ownPID: uint32(os.Getpid()),
	})
	if err != nil {
		return err
	}
	prog := unix.SockFprog{Len: uint16(len(filter)), Filter: &filter[0]}
	if _, _, errno := unix.Syscall(
		unix.SYS_SECCOMP,
		uintptr(unix.SECCOMP_SET_MODE_FILTER),
		0,
		uintptr(unsafe.Pointer(&prog)),
	); errno != 0 {
		return fmt.Errorf("seccomp(SET_MODE_FILTER): %w", errno)
	}
	return nil
}
