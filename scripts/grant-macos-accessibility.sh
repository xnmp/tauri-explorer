#!/usr/bin/env bash
# CI-only TCC setup, adapted from appium/appium-mac2-driver's
# scripts/ci/grant-accessibility.sh (Apache-2.0):
# https://github.com/appium/appium-mac2-driver/blob/master/scripts/ci/grant-accessibility.sh
# Some disposable hosted runners disable SIP; fail closed unless confirmed.
set -euo pipefail

if [[ $# -ne 1 || ! -f $1 ]]; then
  echo "usage: $0 ABSOLUTE_EXECUTABLE_PATH" >&2
  exit 1
fi
target=$1
if [[ $target != /* ]]; then
  echo "Accessibility grant target must be absolute" >&2
  exit 1
fi
if ! sip_status=$(csrutil status); then
  echo "::error::Could not determine SIP status; native XCTest Accessibility grant unavailable" >&2
  exit 1
fi
if [[ $sip_status != *"System Integrity Protection status: disabled."* ]]; then
  echo "::error::SIP is not confirmed disabled; native XCTest Accessibility grant unavailable" >&2
  exit 1
fi

target_sql=${target//\'/\'\'}
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" <<SQL
INSERT OR REPLACE INTO access
  (service, client, client_type, auth_value, auth_reason, auth_version,
   indirect_object_identifier, flags, last_modified)
VALUES
  ('kTCCServiceAccessibility', '$target_sql', 1, 2, 3, 1,
   'UNUSED', 0, CAST(strftime('%s', 'now') AS INTEGER));
SQL

sudo launchctl kickstart -k system/com.apple.tccd 2>/dev/null || sudo pkill -HUP tccd
