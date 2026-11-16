# Automatic updates (#1679)

Tauri Explorer replaces itself with signed releases when **Settings → Behavior →
Install Updates Automatically** is on (the default) and the install can do so
safely. Otherwise it keeps the notify-only notice from #185 ("X is available —
View release").

## What the user sees

1. About 5 s after startup, at most once a day, the app checks for a release.
2. On a self-updatable install the update is downloaded and its signature
   verified in the background; the notice then reads *"X is ready to install —
   Restart now / Later"*.
3. **Restart now** installs and relaunches. On Windows the installer
   (`installMode: passive`, a progress window) takes over the process. Linux
   deb/rpm installs ask for the administrator password (pkexec).
4. **Later** keeps the download for this session; the next daily check offers
   it again. If installation fails (e.g. the password prompt is cancelled) an
   error toast appears and **Restart now** stays available.

## Which installs self-update

Decided at runtime by `src-tauri/src/update_check/eligibility.rs`. The bundle type
that the Tauri bundler embeds in the binary is not enough: the AUR `-bin` package
repacks the `.deb`, and the source `PKGBUILD` and Nix builds are `--no-bundle`.

| Install | Self-updates? | Why |
| --- | --- | --- |
| Windows NSIS `-setup.exe` / MSI | yes | |
| macOS `.app` in a writable location | yes | not from a mounted DMG or App Translocation |
| Linux AppImage (run as an AppImage) | yes | `$APPIMAGE` is set; the image file is replaced |
| Linux `.deb` / `.rpm` | only if `dpkg-query -S` / `rpm -qf` owns the executable | pkexec `dpkg -i` / `rpm -U` |
| Arch (`PKGBUILD`, AUR `-bin`), Nix, dev builds | no, notify only | the system package manager owns the files |

## Release pipeline

`release.yml`:

- Each build job fails fast without `TAURI_SIGNING_PRIVATE_KEY`, then builds with
  `--config src-tauri/tauri.updater.conf.json` (enables
  `bundle.createUpdaterArtifacts`, so every bundle gets a `.sig`, and macOS also
  gets `tauri-explorer.app.tar.gz`). The overlay keeps local and other CI bundle
  builds working without the key.
- On macOS, `scripts/macos-release-build.sh` rebuilds the updater archive after
  stapling the notarization ticket, re-signs it, and verifies the archived app.
- The release job renames the macOS archive to
  `tauri-explorer_<version>_aarch64.app.tar.gz`, runs
  `scripts/updater-manifest.mjs` to produce `latest.json`, and uploads it with
  the bundles and signatures.
- Installed apps fetch
  `https://github.com/xnmp/tauri-explorer/releases/latest/download/latest.json`
  (`plugins.updater.endpoints` in `tauri.conf.json`). Platform keys are
  bundle-specific (`linux-x86_64-deb`, `windows-x86_64-nsis`, …) and the
  manifest deliberately has no generic `linux-x86_64` entry.

Releases published before this feature have no `latest.json`. The app then logs
`Update(self-update-unavailable)` and falls back to the notify-only notice.

## Signing key custody

- The updater keypair is a minisign key made with `cargo tauri signer generate`.
  Its public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
  Every installed copy trusts **only** that key.
- Repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- The maintainer's copy lives in `~/.tauri/tauri-explorer-updater.key`, with
  `.key.password` and `.key.pub` beside it. **Back these up offline.** If the
  private key is lost, existing installs cannot verify any future release. They
  then fall back to the notice, and users must reinstall manually once to
  pick up a new key.
- Rotation: publish one last release signed with the old key whose
  `tauri.conf.json` already carries the new public key, then switch the
  secrets to the new key.

## Testing

- Policy: `cargo test --lib update_check` (eligibility matrix, macOS bundle paths).
- Manifest: `bunx vitest run tests/updater-manifest.test.ts`.
- Frontend contract (mock backend): `npx playwright test e2e/auto-update.spec.ts`.
- End-to-end on Linux: build an AppImage with an overlay that points
  `plugins.updater.endpoints` at `http://127.0.0.1:<port>/latest.json` with
  `dangerousInsecureTransportProtocol: true`, then build a version-bumped
  AppImage, serve a `latest.json` for it, and run the old AppImage under
  `dbus-run-session` + `xvfb-run` with private `XDG_*` directories (the
  single-instance plugin would otherwise hand off to a running copy).
