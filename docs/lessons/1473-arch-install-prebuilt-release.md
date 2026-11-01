# Arch installer installs the release through pacman

`arch_install.sh` now repackages the latest release `.deb` with
`packaging/aur/PKGBUILD` and installs it with `pacman -U`. A source build needs
confirmation: the installer notifies, then prompts on `/dev/tty`; with no
terminal it stops unless `--yes` or `--source` was given.

`pacman -U --noconfirm` answers pacman's default "no" when the source and binary
packages conflict, so the transaction fails. `--print` skips that check and
cannot show it. A two-package fixture in a `fakeroot` pacman root showed the
failure, and `--ask=4` (`ALPM_QUESTION_CONFLICT_PKG`) replacing the package. The
option is absent from `pacman --help` and the man page.

`pacman -Q <name>` resolves through `provides`, so one query reports whichever
package is installed.

A digest mismatch exits rather than falling back to a build. Falling back would
turn corrupt or tampered bytes into a prompt whose natural answer is yes.

The release binary lacks the `avif` feature that the source PKGBUILD enables.

The first real run produced an 11 KB package that the stubbed tests accepted. A
sed range `/^sha256sums/,/)$/d` checks its end pattern only from the next line,
so the one-line `sha256sums_x86_64=(...)` opened a range to end of file and
deleted `package()`; makepkg then packaged nothing, successfully. Fresh checksums
are now appended instead, and the installer rejects a package without
`usr/bin/tauri-explorer`. Stubs cannot prove a package has contents: run the real
script as far as `sudo -v` after changing this route.
