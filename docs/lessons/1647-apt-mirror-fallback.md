# #1647 — hosted runners' Ubuntu mirror outage

Hosted Ubuntu 24.04 runners resolve apt sources through
`mirror+file:/etc/apt/apt-mirrors.txt`, which lists `azure.archive.ubuntu.com`.
On 2026-11-11 that host stopped answering: every InRelease fetch logged `Ign:`
until the bounded refresh timed out. Re-running the job did not help, because
each rerun got the same mirror. The canonical `archive.ubuntu.com` also failed
from runners ("Temporary failure resolving"). A fallback inside ubuntu.com DNS
alone was therefore not enough.

`apt.sh update` now rewrites the image's mirror-list and Azure URIs to each of
`APT_FALLBACK_MIRRORS` in turn after its bounded attempts fail: the canonical
archive, then `mirrors.edge.kernel.org`. Each mirror gets
`APT_FALLBACK_ATTEMPTS` bounded tries. Any mirror is safe because apt verifies
InRelease against the Ubuntu archive keyring. Only the image's own mirror
sources are rewritten: a failure with no such source fails without trying
elsewhere. Recovered attempt failures are warnings, so a green step carries no
error annotation. The rust-suite index refresh step's timeout covers the
worst case (6 + 2 × 2 × 2 minutes; the step allows 16).
