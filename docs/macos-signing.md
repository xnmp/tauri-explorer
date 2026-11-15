# macOS signing and notarization

Release DMGs are signed with a Developer ID Application certificate, use the
hardened runtime, and are notarized and stapled, so Gatekeeper opens a
downloaded copy without `xattr` (#1671).

## What runs where

- `scripts/macos-release-build.sh <target>` is the single owner. It runs
  `cargo tauri build`, which signs the `.app` (with `src-tauri/Entitlements.plist`),
  notarizes and staples it, then signs the DMG. The script then notarizes and
  staples the DMG itself, and verifies the result: Developer ID authority,
  hardened runtime, the Apple Events entitlement, stapled tickets, and
  `spctl` reporting `source=Notarized Developer ID` for the `.app`, the DMG and
  the `.app` inside the mounted DMG. The Tauri CLI only logs a warning when it
  skips notarization, so these checks, not the build's exit code, are the gate.
- `release.yml` calls it on the macOS matrix entry. With no credentials it
  builds an unsigned DMG and emits a warning; partial credentials fail.
- `macos-signing-check.yml` (manual dispatch) runs the same script with
  `REQUIRE_SIGNING=1` and uploads the notarized DMG as an artifact for 7 days,
  without tagging or publishing anything.

## Repository secrets

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12` (one line) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_API_ISSUER` | App Store Connect → Users and Access → Integrations → Team Keys: the Issuer ID |
| `APPLE_API_KEY` | that key's Key ID |
| `APPLE_API_PRIVATE_KEY` | the full contents of `AuthKey_<KeyID>.p8`, including the BEGIN/END lines |

## One-time setup

1. Enrol in the Apple Developer Program (individual is fine; the certificate
   then shows your personal name in Gatekeeper dialogs).
2. On a Mac, in Xcode → Settings → Accounts → Manage Certificates, add a
   **Developer ID Application** certificate (or create a CSR in Keychain Access
   and upload it at developer.apple.com → Certificates). Only the Account Holder
   can create Developer ID certificates.
3. In Keychain Access, export that certificate *with its private key* as a
   `.p12` and set a password.
4. In App Store Connect, create a Team API key with the **Developer** role and
   download the `.p8` (it can be downloaded only once).
5. Add the six secrets:
   ```bash
   gh secret set APPLE_CERTIFICATE < <(base64 -i DeveloperID.p12)
   gh secret set APPLE_CERTIFICATE_PASSWORD
   gh secret set APPLE_SIGNING_IDENTITY
   gh secret set APPLE_API_ISSUER
   gh secret set APPLE_API_KEY
   gh secret set APPLE_API_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
   ```
6. Run `gh workflow run macos-signing-check.yml --ref dev`, wait for it to pass,
   then download the `notarized-dmg` artifact *through a browser* on a Mac
   (so it is quarantined) and open it: it should launch with at most the
   standard "downloaded from the Internet" confirmation.
7. After the first signed release, remove the `xattr` instructions from
   `README.md`, `website/app.js` and `docs/alpha-testing.md`.

## Maintenance

- Developer ID certificates last five years; the membership renews yearly.
  A lapsed membership stops new notarizations, but already-notarized releases
  keep working. Rotate by replacing `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`, then rerun the
  check workflow.
- Every executable in the bundle must be signed. If a sidecar
  (`bundle.externalBin`) or bundled helper is added, confirm the check workflow
  still passes.
- New features that need a hardened-runtime entitlement or a privacy usage
  string (`src-tauri/Info.plist`) fail only in signed builds. Delete-to-Trash is
  the existing case: the trash crate's default Finder method sends Apple Events
  through `osascript`, which needs `com.apple.security.automation.apple-events`
  and `NSAppleEventsUsageDescription`.
- Changing the signing identity changes the app's identity for macOS privacy
  (TCC) grants. Users who granted the unsigned build Full Disk Access or Finder
  automation are asked again after their first signed update.
