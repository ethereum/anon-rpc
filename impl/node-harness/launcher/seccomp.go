package main

// Denying UDP with seccomp, because Landlock cannot here.
//
// Landlock's network rights are TCP-only from ABI 4 to ABI 9; UDP arrives in
// ABI 10, which is Linux 7.2. The current Ubuntu LTS ships 6.8 and its HWE
// kernel is 7.0, so ABI 10 is out of reach for most deployments for a while —
// UDP being open is the normal case, not a rare degraded one.
//
// seccomp cannot express the *address* policy (a BPF filter cannot dereference
// the sockaddr pointer that connect() takes), which is why the address rules
// live host-side. But it can express this one: socket(AF_INET, SOCK_DGRAM, …)
// is three scalar arguments, which is exactly what seccomp filters well. The
// filter denies creating an IP datagram socket at all, which is stricter than
// Landlock's ABI 10 rights — those govern bind and connect, not creation.
//
// In the bridged posture the worker has no legitimate use for UDP: the host
// resolves names and dials on its behalf, so the child needs no resolver.

import (
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/unix"
)

// seccomp_data field offsets (see linux/seccomp.h). Arguments are 64-bit; on a
// little-endian target the low word of arg N is at its base offset, which is
// all these comparisons need since domain and type are ints.
const (
	offNR   = 0
	offArch = 4
	offArg0 = 16 // domain
	offArg1 = 24 // type
)

const (
	afInet      = 2
	afInet6     = 10
	sockDgram   = 2
	sockTypeMask = 0xf // type carries SOCK_NONBLOCK/SOCK_CLOEXEC flags too
)

// auditArch reports the AUDIT_ARCH_* value this binary was built for. The
// filter checks it: without that check, a process could in principle enter a
// different syscall ABI where the same numbers mean different calls.
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

// denyUDPFilter returns a filter that fails socket(AF_INET|AF_INET6, SOCK_DGRAM)
// with EACCES and allows everything else.
//
// Jump offsets are counted in instructions from the one AFTER the jump, so the
// layout is written out explicitly rather than computed; a wrong offset here
// silently allows what it was meant to deny.
func denyUDPFilter(arch uint32) []unix.SockFilter {
	const (
		ld  = unix.BPF_LD | unix.BPF_W | unix.BPF_ABS
		jeq = unix.BPF_JMP | unix.BPF_JEQ | unix.BPF_K
		and = unix.BPF_ALU | unix.BPF_AND | unix.BPF_K
		ret = unix.BPF_RET | unix.BPF_K
	)
	allow := uint32(unix.SECCOMP_RET_ALLOW)
	// ERRNO returns a failure to the caller instead of killing it: a worker
	// that tries UDP gets EACCES and can carry on, which is the same shape as
	// Landlock's refusal and keeps the two indistinguishable to worker code.
	deny := uint32(unix.SECCOMP_RET_ERRNO | uint32(unix.EACCES))

	return []unix.SockFilter{
		// 0: arch must be the one this filter was written for, else kill.
		{Code: ld, K: offArch},
		{Code: jeq, K: arch, Jt: 1, Jf: 0},
		{Code: ret, K: unix.SECCOMP_RET_KILL_PROCESS},

		// 3: only socket(2) is interesting.
		{Code: ld, K: offNR},
		{Code: jeq, K: uint32(unix.SYS_SOCKET), Jt: 1, Jf: 0},
		{Code: ret, K: allow},

		// 6: domain must be AF_INET or AF_INET6.
		{Code: ld, K: offArg0},
		{Code: jeq, K: afInet, Jt: 2, Jf: 0},  // → type check
		{Code: jeq, K: afInet6, Jt: 1, Jf: 0}, // → type check
		{Code: ret, K: allow},                 // any other domain (AF_UNIX, …)

		// 10: type, masked free of SOCK_NONBLOCK/SOCK_CLOEXEC.
		{Code: ld, K: offArg1},
		{Code: and, K: sockTypeMask},
		{Code: jeq, K: sockDgram, Jt: 1, Jf: 0},
		{Code: ret, K: allow},
		{Code: ret, K: deny},
	}
}

// installDenyUDP loads the filter into the current process. It is irrevocable
// and inherited across execve, like the Landlock ruleset, so node and anything
// it could spawn (nothing: --permission denies that too) inherit it.
//
// PR_SET_NO_NEW_PRIVS must already be set; the kernel refuses an unprivileged
// filter otherwise. main() sets it before calling this.
func installDenyUDP() error {
	arch, err := auditArch()
	if err != nil {
		return err
	}
	filter := denyUDPFilter(arch)
	prog := unix.SockFprog{
		Len:    uint16(len(filter)),
		Filter: &filter[0],
	}
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
