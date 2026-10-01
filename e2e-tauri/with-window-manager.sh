#!/usr/bin/env bash
# Run only on an isolated display (normally xvfb-run). Native maximize/restore
# needs a window manager; Xvfb alone supplies only an X server.
set -euo pipefail

wm_log=$(mktemp)
openbox --sm-disable >"$wm_log" 2>&1 &
wm_pid=$!
cleanup() {
  kill "$wm_pid" 2>/dev/null || true
  wait "$wm_pid" 2>/dev/null || true
  rm -f "$wm_log"
}
trap cleanup EXIT

for ((attempt = 0; attempt < 100; attempt++)); do
  if ! kill -0 "$wm_pid" 2>/dev/null; then
    cat "$wm_log" >&2
    exit 1
  fi
  case "$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null)" in
    *"window id # 0x"*)
      "$@"
      exit 0
      ;;
  esac
  sleep 0.1
done
cat "$wm_log" >&2
echo "Window manager did not advertise readiness" >&2
exit 1
