#!/usr/bin/env bash
# Build the macOS release bundles, signed with Developer ID and notarized
# (#1671, runbook: docs/macos-signing.md).
#
# Usage: scripts/macos-release-build.sh <rust-target-triple>
#
# Credentials (all or none; repository secrets in CI):
#   APPLE_CERTIFICATE           base64 Developer ID Application .p12
#   APPLE_CERTIFICATE_PASSWORD  its export password
#   APPLE_SIGNING_IDENTITY      "Developer ID Application: Name (TEAMID)"
#   APPLE_API_ISSUER            App Store Connect API issuer ID
#   APPLE_API_KEY               App Store Connect API key ID
#   APPLE_API_PRIVATE_KEY       contents of that key's AuthKey_<id>.p8
#
# With none set the build is unsigned and a workflow warning is emitted,
# unless REQUIRE_SIGNING=1. A partial set always fails. With all set, every
# artifact must pass the verification below: the Tauri CLI only warns when it
# skips notarization, so these checks are the gate, not the build's exit code.
set -euo pipefail

target=${1:?usage: $0 <rust-target-triple>}
bundle_dir="src-tauri/target/$target/release/bundle"

credential_vars=(
  APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY
  APPLE_API_ISSUER APPLE_API_KEY APPLE_API_PRIVATE_KEY
)
missing=()
for name in "${credential_vars[@]}"; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done

if (( ${#missing[@]} == ${#credential_vars[@]} )); then
  if [[ "${REQUIRE_SIGNING:-0}" == 1 ]]; then
    echo "::error::REQUIRE_SIGNING=1 but no Apple signing credentials are configured (docs/macos-signing.md)"
    exit 1
  fi
  echo "::warning::No Apple signing credentials configured; the macOS DMG is unsigned and Gatekeeper will block it (docs/macos-signing.md)"
  cargo tauri build --target "$target"
  exit 0
fi
if (( ${#missing[@]} > 0 )); then
  echo "::error::Incomplete Apple signing credentials; missing: ${missing[*]}"
  exit 1
fi

key_dir=$(mktemp -d)
mount_dir=''
cleanup() {
  if [[ -n "$mount_dir" ]]; then
    hdiutil detach "$mount_dir" -quiet || true
    rmdir "$mount_dir" 2>/dev/null || true
  fi
  rm -rf "$key_dir"
}
trap cleanup EXIT
export APPLE_API_KEY_PATH="$key_dir/AuthKey_${APPLE_API_KEY}.p8"
( umask 077; printf '%s\n' "$APPLE_API_PRIVATE_KEY" > "$APPLE_API_KEY_PATH" )

# Tauri imports APPLE_CERTIFICATE into a temporary keychain, signs the .app
# (hardened runtime, src-tauri/Entitlements.plist), notarizes and staples it,
# then signs the DMG. It does not notarize the DMG; that happens below.
cargo tauri build --target "$target"

# Must run under macOS's stock bash 3.2: no mapfile, no empty "${a[@]}".
only_match() {
  local pattern=$1 dir=$2 matches
  matches=()
  shopt -s nullglob
  # shellcheck disable=SC2206 # deliberate glob expansion of $pattern
  matches=("$dir"/$pattern)
  shopt -u nullglob
  if (( ${#matches[@]} != 1 )); then
    echo "::error::Expected exactly one $pattern in $dir; found ${#matches[@]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

fail() {
  echo "::error::$*"
  exit 1
}

require_output() {
  local description=$1 needle=$2 output=$3
  if ! grep -qF -- "$needle" <<<"$output"; then
    printf '%s\n' "$output"
    fail "$description: expected '$needle'"
  fi
}

verify_app() {
  local app=$1 details entitlements assessment
  codesign --verify --deep --strict --verbose=2 "$app"
  details=$(codesign --display --verbose=2 "$app" 2>&1)
  require_output "$app is not Developer ID signed" \
    "Authority=Developer ID Application:" "$details"
  require_output "$app lacks the hardened runtime" "(runtime)" "$details"
  entitlements=$(codesign --display --entitlements - --xml "$app" 2>/dev/null)
  require_output "$app lacks the Apple Events entitlement" \
    "com.apple.security.automation.apple-events" "$entitlements"
  xcrun stapler validate "$app" || fail "$app has no stapled notarization ticket"
  assessment=$(spctl --assess --type execute --verbose=4 "$app" 2>&1) ||
    { printf '%s\n' "$assessment"; fail "Gatekeeper rejects $app"; }
  require_output "Gatekeeper source for $app" \
    "source=Notarized Developer ID" "$assessment"
}

# Prints a top-level JSON string field from stdin, or nothing if unparseable.
json_field() {
  python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get(sys.argv[1], ""))
except Exception:
    print("")
' "$1"
}

notary_auth=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")

notarize_and_staple() {
  local artifact=$1 result status submission_id
  # The JSON status is the verdict; notarytool's exit code differs between
  # rejected submissions and transport/auth errors, so read both as output.
  result=$(xcrun notarytool submit "$artifact" "${notary_auth[@]}" \
    --wait --timeout 30m --output-format json) || true
  status=$(json_field status <<<"$result")
  if [[ "$status" != Accepted ]]; then
    printf '%s\n' "$result"
    submission_id=$(json_field id <<<"$result")
    [[ -n "$submission_id" ]] && xcrun notarytool log "$submission_id" "${notary_auth[@]}" || true
    fail "Notarization of $artifact finished with status '${status:-unknown}'"
  fi
  xcrun stapler staple "$artifact"
  xcrun stapler validate "$artifact"
}

app=$(only_match '*.app' "$bundle_dir/macos")
dmg=$(only_match '*.dmg' "$bundle_dir/dmg")

verify_app "$app"

# Notarize the outermost container too, so the downloaded DMG itself carries a
# ticket and opens without an online Gatekeeper lookup.
notarize_and_staple "$dmg"
dmg_assessment=$(spctl --assess --type open --context context:primary-signature \
  --verbose=4 "$dmg" 2>&1) ||
  { printf '%s\n' "$dmg_assessment"; fail "Gatekeeper rejects $dmg"; }
require_output "Gatekeeper source for $dmg" "source=Notarized Developer ID" "$dmg_assessment"

# The app users drag out of the DMG is what Gatekeeper evaluates at launch.
mount_dir=$(mktemp -d)
hdiutil attach "$dmg" -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" -quiet
verify_app "$(only_match '*.app' "$mount_dir")"

echo "Signed and notarized: $dmg"
