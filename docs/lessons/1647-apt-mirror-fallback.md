# #1647 — hosted runners' Azure Ubuntu mirror outage

Hosted Ubuntu 24.04 runners resolve apt sources through
`mirror+file:/etc/apt/apt-mirrors.txt`, which lists `azure.archive.ubuntu.com`.
When that host stops answering, every InRelease fetch logs `Ign:` until the
bounded refresh times out. Re-running the job does not help, because each rerun
gets the same mirror.

`apt.sh update` therefore rewrites the image's mirror-list and Azure URIs to
`APT_FALLBACK_MIRROR` (the canonical archive) after its bounded attempts fail,
then retries within the same bounds. It only rewrites those sources: a failure
with no image-mirror source fails without trying elsewhere. The recovered
attempt failures are warnings, so a green step carries no error annotation.
