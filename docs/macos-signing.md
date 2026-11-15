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
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` as `security find-identity -v -p codesigning` prints it, without the surrounding quotes |
| `APPLE_API_ISSUER` | App Store Connect → Users and Access → Integrations → Team Keys: the Issuer ID |
| `APPLE_API_KEY` | that key's Key ID |
| `APPLE_API_PRIVATE_KEY` | the full contents of `AuthKey_<KeyID>.p8`, including the BEGIN/END lines |

## One-time setup

1. Enrol in the Apple Developer Program (individual is fine; the certificate
   then shows your personal name in Gatekeeper dialogs).
2. Create the **Developer ID Application** certificate. Only the Account
   Holder can. No Mac is needed: generate the key and CSR with OpenSSL, upload
   the CSR at developer.apple.com → Certificates → + → Developer ID Application
   (G2 Sub-CA), and download the `.cer`:
   ```bash
   openssl genrsa -out devid.key 2048
   openssl req -new -key devid.key -out devid.csr \
     -subj "/emailAddress=<apple-id-email>/CN=<Your Name>/C=<country code>"
   ```
   (On a Mac, Xcode → Settings → Accounts → Manage Certificates does the same.)
3. Bundle the certificate, its private key and Apple's intermediate into a
   password-protected `.p12`. `-legacy` keeps the encryption that older
   `security import` versions accept:
   ```bash
   curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   openssl x509 -inform DER -in developerID_application.cer -out devid.pem
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out g2ca.pem
   openssl pkcs12 -export -legacy -inkey devid.key -in devid.pem \
     -certfile g2ca.pem -out DeveloperID.p12
   openssl x509 -in devid.pem -noout -subject   # CN = the signing identity
   ```
   Keep `devid.key` / `DeveloperID.p12` somewhere safe and offline; anyone
   holding them can sign software as you.
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
6. Run `gh workflow run macos-signing-check.yml --ref dev` and wait for it to
   pass. Its `spctl` checks are Gatekeeper's own assessment on a real Mac
   runner. For hands-on confirmation, have someone with a Mac download the
   `notarized-dmg` artifact *through a browser* (so it is quarantined) and open
   it: it should launch with at most the standard "downloaded from the
   Internet" confirmation.
7. After the first signed release, set the repository variable
   `gh variable set MACOS_REQUIRE_SIGNING --body 1` so a later release fails
   rather than shipping unsigned if the secrets go missing, and remove the
   `xattr` instructions from `README.md`, `website/app.js` and
   `docs/alpha-testing.md`.

A failed staple after an accepted notarization is retried five times; if the
job still fails there, rerun it. Apple's ticket CDN can lag the acceptance.

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
