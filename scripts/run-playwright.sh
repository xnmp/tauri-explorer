#!/usr/bin/env bash
set -euo pipefail

# Playwright's downloaded Chromium is dynamically linked against desktop
# libraries. NixOS keeps those outside the default linker path; include the
# available Nix library directories when present without affecting other hosts.
if [[ -d /nix/store ]]; then
  NIX_BROWSER_LIBS=$(find /nix/store -maxdepth 3 \
    \( -name libglib-2.0.so.0 -o -name libgobject-2.0.so.0 -o -name libnspr4.so \
    -o -name libnss3.so -o -name libnssutil3.so -o -name libgio-2.0.so.0 \
    -o -name libatk-1.0.so.0 -o -name libatk-bridge-2.0.so.0 -o -name libdbus-1.so.3 \
    -o -name libX11.so.6 -o -name libXcomposite.so.1 -o -name libXdamage.so.1 \
    -o -name libXext.so.6 -o -name libXfixes.so.3 -o -name libXrandr.so.2 \
    -o -name libgbm.so.1 -o -name libexpat.so.1 -o -name libxcb.so.1 \
    -o -name libxkbcommon.so.0 -o -name libudev.so.1 -o -name libasound.so.2 \
    -o -name libatspi.so.0 \) -printf '%h\n' 2>/dev/null | sort -u | paste -sd:)
  export LD_LIBRARY_PATH="${NIX_BROWSER_LIBS}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

exec npx playwright test "$@"
