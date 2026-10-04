# Arch installer authenticates before building

The installer invoked sudo only for the final `pacman -U`, so an unattended
build finished by waiting for a password. Validate credentials with `sudo -v`
before starting `makepkg`; an authentication failure must stop before any build
work. Keep building as the invoking user.

A startup validation alone can expire during a long build. Refresh the sudo
timestamp every 60 seconds with `sudo -n -v`, and use `sudo -n` for installation
so an expired or revoked credential fails instead of prompting at the end.
Stop the refresher and its active child when the installer exits, including
build failure and cancellation. Run both sleeping and validation as waited
background children so a slow validation cannot defer the cleanup signal.
Custom sudo policies that disable caching or scope timestamps to a parent PID
can still prevent unattended installation; the refresher shares the invoking
terminal's timestamp under the normal terminal-scoped policy.

An isolated command fixture executed the actual script. The original failed
because building began before authentication. The change passed startup
authentication, long-build refresh, authentication failure, build failure,
refresh failure, slow-validation cleanup, and cancellation checks; no live
refresher survived exit.
`bash -n` also passed. These checks do not install a real package.
