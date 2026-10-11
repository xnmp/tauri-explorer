#!/usr/bin/env python3
"""Real isolated processes using the exact production Rust supervisor module.
Build test_support/process_supervisor_fixture first; no GUI, shell CLI or accounts.
"""
import ctypes
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

EXE = Path(sys.argv[1]).resolve()
MARKER = '--te-owned-process-supervisor-v1'
# Only this standalone fixture runner becomes a subreaper, keeping its own killed
# descendants out of PID1. The production host never changes global child policy.
if sys.platform.startswith('linux'):
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid:
                return
        except ChildProcessError:
            return


def stopped(pid):
    if sys.platform.startswith('linux'):
        try:
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].lstrip().startswith('Z')
        except FileNotFoundError:
            return True
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


def wait_stopped(pids):
    deadline = time.monotonic() + 3
    while not all(stopped(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(.01)
    assert all(stopped(pid) for pid in pids), f'Owned processes survived: {pids}'
    reap()


def report(path):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if path.exists():
            text = path.read_text()
            if len(text.split()) == 3:
                return list(map(int, text.split()))
        time.sleep(.01)
    raise AssertionError('Fixture CLI did not report owned descendants')


def run(mode):
    with tempfile.TemporaryDirectory(prefix='te-supervisor-case-') as root:
        path = Path(root) / 'pids'
        process = subprocess.Popen([str(EXE), mode, str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pids = []
        try:
            if mode not in ['success', 'nonzero', 'large-success', 'missing', 'reuse', 'stdin-digest', 'stdin-unread-exit']:
                pids = report(path)
            if mode == 'backend-death':
                # Kill the owning backend while its CLI tree is still running.
                backend = Path(str(path) + '.backend')
                deadline = time.monotonic() + 3
                while not (backend.exists() and backend.read_text()) and time.monotonic() < deadline:
                    time.sleep(.01)
                os.kill(int(backend.read_text()), signal.SIGKILL)
            output, errors = process.communicate(timeout=5)
            wait_stopped(pids)
            assert not errors, errors
            if mode == 'reuse':
                assert process.returncode == 0 and output == b'reused-command-success\n'
            elif mode == 'success':
                assert process.returncode == 0
                assert output == b'status=0\nstdout=exact-success:in-memory-only\n\nstderr=exact-stderr\n\n'
            elif mode == 'large-success':
                assert process.returncode == 0
                assert output == b'status=0\nstdout=' + b'x' * 65536 + b'\nstderr=\n'
            elif mode == 'nonzero':
                assert process.returncode == 0 and b'status=23\nstdout=exact-nonzero\n' in output
            elif mode == 'early-exit':
                assert process.returncode == 0 and b'status=0\nstdout=exact-early-success\n' in output
            elif mode == 'stdin-digest':
                # The leaf read exactly the 1 MiB input to EOF and echoed its digest.
                assert process.returncode == 0 and output == b'status=0\ndigest-match=true\n', output
            elif mode == 'stdin-unread-exit':
                # Unread input is an ordinary outcome: the leaf's own status stands.
                assert process.returncode == 0 and output.startswith(b'status=5\nstdout=exact-unread-exit\n'), output
            elif mode in ['cancel', 'backend-death', 'stdin-unread-cancel']:
                assert process.returncode == 2 and output.startswith(b'started-error=fixture cancelled'), output
            elif mode in ['overflow', 'stderr-overflow', 'stdin-unread-overflow']:
                assert process.returncode == 2 and output.startswith(b'started-error=') and b'exceeded its limit' in output, output
            elif mode == 'missing':
                # A spawn failure is classified as never having executed.
                assert process.returncode == 2 and output.startswith(b'not-started-error='), output
            else:
                assert process.returncode == 2
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for pid in pids:
                if not stopped(pid):
                    os.kill(pid, signal.SIGKILL)
            reap()
    print('PASS', mode, flush=True)


for mode in ['success', 'reuse', 'nonzero', 'large-success', 'early-exit', 'cancel', 'backend-death', 'overflow', 'stderr-overflow', 'missing',
             'stdin-digest', 'stdin-unread-exit', 'stdin-unread-cancel', 'stdin-unread-overflow']:
    run(mode)

with tempfile.TemporaryDirectory(prefix='te-supervisor-parent-death-') as root:
    path = Path(root) / 'pids'
    parent = subprocess.Popen([str(EXE), 'tree-hold', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pids = report(path)
    anchor = os.getpgid(pids[0])
    assert anchor not in pids and anchor != os.getpgid(0)
    assert all(os.getpgid(pid) == anchor for pid in pids)
    # SIGKILL bypasses all Rust Drop/cleanup paths in the actual caller process.
    parent.kill()
    parent.wait(timeout=3)
    wait_stopped(pids + [anchor])
    parent.stdout.close()
    parent.stderr.close()
    print('PASS real-parent-SIGKILL-kills-anchor-leaf-child-grandchild', flush=True)

with tempfile.TemporaryDirectory(prefix='te-supervisor-preexec-death-') as root:
    path = Path(root) / 'preexec-pid'
    parent = subprocess.Popen([str(EXE), 'preexec-hold', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + 3
    while (not path.exists() or path.stat().st_size != 4) and time.monotonic() < deadline:
        time.sleep(.01)
    pid = int.from_bytes(path.read_bytes(), sys.byteorder, signed=True)
    anchor = os.getpgid(pid)
    assert anchor != os.getpgid(0)
    parent.kill()
    parent.wait(timeout=3)
    wait_stopped([pid, anchor])
    parent.stdout.close()
    parent.stderr.close()
    print('PASS real-parent-SIGKILL-during-gated-pre-exec', flush=True)

for fd_kind in ['missing', 'regular', 'socket-invalid-handshake']:
    with tempfile.TemporaryFile() as file:
        left = right = None
        if fd_kind == 'regular':
            fd, inherited = file.fileno(), (file.fileno(),)
        elif fd_kind == 'socket-invalid-handshake':
            left, right = socket.socketpair()
            fd, inherited = right.fileno(), (right.fileno(),)
        else:
            fd, inherited = 999999, ()
        helper = subprocess.Popen([str(EXE), MARKER, str(fd)], pass_fds=inherited, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if right:
            right.close()
            left.sendall(b'X' * 40)
            left.close()
        output, errors = helper.communicate(timeout=3)
        assert helper.returncode == 64 and output == errors == b'', (fd_kind, helper.returncode, output, errors)
    print('PASS private-mode-refuses-' + fd_kind, flush=True)
print('19 process-supervisor outcome fixtures passed', flush=True)
