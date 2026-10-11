# Plugin profile ownership must release the lock explicitly

Dropping `File` closes one descriptor. A Linux `flock` remains held while a
forked helper retains the same open-file description; `O_CLOEXEC` only closes
that descriptor at exec. The profile owner therefore keeps a private file and
acquisition PID, and explicitly unlocks when the acquiring process drops it.
A forked child's guard drop must preserve the live parent's exclusion.

The native regression uses pipe acknowledgements to hold an inherited
descriptor during parent release. The original production code fails; the
guard permits immediate reacquisition while the child is still alive. A
separate case proves child drop cannot unlock the parent.

Release test children with an explicit byte, rather than EOF: parallel forks
can inherit each other's pipe writers. Verify a live child during the critical
phase, require successful normal exit, reap on assertion unwind, and clear
ownership when `waitpid` reaps or reports `ECHILD`.

Native contract output is the behavior evidence; it is not an application UI
screenshot.
