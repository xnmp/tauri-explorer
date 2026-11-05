# #1520 — `timeout sudo apt-get` orphans apt and keeps the dpkg lock

**Symptom.** Build & Release for v1.21.0 failed in the Linux build's
"Install Linux dependencies" step: attempt 1 of the bounded apt install timed
out after 240s, then attempts 2 and 3 each failed with
`E: Unable to acquire the dpkg frontend lock … locked by another process`.

**Root cause.** `apt.sh` wrapped `timeout` around `sudo apt-get`. The hosted
runners' sudo uses `use_pty`: it runs the command in a separate session and
ignores signals sent from its own process group. timeout signals its process
group, so TERM went nowhere and the KILL escalation killed only sudo. apt-get
and dpkg kept running as orphans and kept the lock until they finished, so
#1371's retries never got another chance.

**Fix.** Run `sudo timeout … apt-get …`. timeout's process group now
contains apt-get, its download methods and dpkg, and a timed-out attempt
really stops before `dpkg --configure -a` and the retry run.

**Test.** `tests/ci-apt-install.test.ts` replaces sudo with a stub that
behaves like `use_pty` sudo (new session, group TERM not relayed). Its
apt-get stub holds a lock that a later live holder refuses. With the old
ordering the hung attempt outlives the step. With the fix, the retry
installs.
