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
3. **Restart now** first saves the window's open tabs (a restart skips the
   close handlers that normally do), then installs and relaunches; the main
   window restores its tabs. Like quitting, it ends work in progress;
   interrupted file transfers go through the usual recovery path.
   - macOS / AppImage: the files are replaced and the app relaunches through
     the normal exit path. Every descriptor is marked close-on-exec first, so
     the relaunched copy does not inherit (and pin) the old AppImage mount.
   - Windows: the installer (`installMode: passive`, a progress window) takes
     over; the plugin exits the process directly, so the app's exit cleanup
     runs from the updater's `on_before_exit` hook. The NSIS installer is
     per-user. The MSI is per-machine: if its UAC prompt is declined after the
     app has exited, nothing is installed and the app must be reopened by hand.
4. **Later** keeps the download in memory for this session; the next daily
   check offers it again. If installation fails before the process exits, an
   error toast appears and **Restart now** stays available.

## Which installs self-update

Decided at runtime by `src-tauri/src/update_check/eligibility.rs`. The bundle type
that the Tauri bundler embeds in the binary is not enough: the AUR `-bin` package
repacks the `.deb`, and the source `PKGBUILD` and Nix builds are `--no-bundle`.

| Install | Self-updates? | Why |
| --- | --- | --- |
| Windows NSIS `-setup.exe` / MSI | yes | |
| macOS `.app` in a writable location | yes | not from a mounted DMG or App Translocation |
| Linux AppImage | yes, when running from it and its directory is writable | the executable must lie in `$APPDIR` (an inherited `$APPIMAGE` alone could name another app's image) |
| Linux `.deb` / `.rpm` | no, notify only | the package manager owns them; `dpkg -i` cannot pull new dependencies and the plugin's password fallbacks end in a terminal `sudo` |
| Arch (`PKGBUILD`, AUR `-bin`), Nix, dev builds | no, notify only | the system package manager owns the files |

The manifest still publishes `linux-x86_64-deb`/`-rpm` entries; only the app's
policy declines them, so enabling them later needs no release-format change.

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
  the bundles and signatures. The script verifies every signature against
  `plugins.updater.pubkey` first: tauri-cli only warns when the signing secret
  does not match the embedded key, and such a release would be rejected by
  every install.
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

## Known limitations

- The verified download stays in memory until restart (over 100 MB for an
  AppImage).
- A session that stays open past a newer release keeps offering the update it
  already downloaded; the next launch picks up the newer one.
- Each check runs from the window that performs it; the job itself is shared,
  so other windows wait for, and reuse, the same download.

## Testing

- Policy: `cargo test --lib update_check` (eligibility matrix, macOS bundle paths).
- Manifest and signature verification: `bunx vitest run tests/updater-manifest.test.ts`
  (fixture signed by the real tauri-cli with a throwaway key).
- Frontend contract (mock backend): `npx playwright test e2e/auto-update.spec.ts`.
- End-to-end on Linux: build an AppImage with an overlay that points
  `plugins.updater.endpoints` at `http://127.0.0.1:<port>/latest.json` with
  `dangerousInsecureTransportProtocol: true`, then build a version-bumped
  AppImage, serve a `latest.json` for it, and run the old AppImage under
  a private Xvfb display and D-Bus session with private `XDG_*` directories
  (the single-instance plugin would otherwise hand off to a running copy).
  After **Restart now**, check that the AppImage file's hash changed, the new
  version is running, and the old `/tmp/.mount_*` is gone.
