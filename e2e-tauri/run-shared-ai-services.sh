#!/usr/bin/env bash
# Private native acceptance against dirty working snapshots, no user profile.
# Usage: run-shared-ai-services.sh ABSOLUTE_HOST_BINARY TRACE_ARCHIVE [PROVIDER_ARCHIVE]
set -euo pipefail
binary=${1:?host binary required}
trace_archive=${2:?Trace archive required}
provider_archive=${3:-}
[[ "$binary" == /* && -x "$binary" && -f "$trace_archive" ]]
for tool in xvfb-run dbus-run-session openbox WebKitWebDriver tauri-driver; do command -v "$tool" >/dev/null; done
profile=$(mktemp -d "${TMPDIR:-/tmp}/te-shared-ai-native.XXXXXX")
export XDG_CONFIG_HOME="$profile/config" XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache" XDG_STATE_HOME="$profile/state" XDG_RUNTIME_DIR="$profile/runtime"
mkdir -p "$XDG_CONFIG_HOME/tauri-explorer/pending-plugins" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
for archive in "$trace_archive" ${provider_archive:+"$provider_archive"}; do
  digest=$(sha256sum "$archive" | cut -d' ' -f1)
  cp -- "$archive" "$XDG_CONFIG_HOME/tauri-explorer/pending-plugins/$digest.teplugin"
done
export SHARED_AI_NATIVE_ACCEPTANCE=1 SHARED_AI_NATIVE_FIXTURE="$profile/fixtures" TAURI_E2E_REQUIRE_GATED=1
export SHARED_AI_NATIVE_PROVIDER=absent
[[ -z "$provider_archive" ]] || export SHARED_AI_NATIVE_PROVIDER=present
export TAURI_NATIVE_DRIVER_PORT=${TAURI_NATIVE_DRIVER_PORT:-14544} TAURI_NATIVE_BACKEND_PORT=${TAURI_NATIVE_BACKEND_PORT:-14545}
export NATIVE_BUILD_MANIFEST="$profile/working-snapshot-build.json"
python3 - "$binary" "$NATIVE_BUILD_MANIFEST" "$trace_archive" "$provider_archive" <<'PY'
import sys,json,hashlib,os,datetime,subprocess
binary,manifest,trace,provider=sys.argv[1:]
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path):return hashlib.sha256(open(path,'rb').read()).hexdigest()
source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
dirty=subprocess.check_output(['git','status','--porcelain=v1'],text=True)
# The verifier requires a command array; this is the documented command, not an observed one.
record={'schemaVersion':1,'sourceCommit':source,'profile':'dirty-working-snapshot-debug-custom-protocol-e2e-hooks','buildCommand':['bun','run','tauri','build','--debug','--no-bundle','--features','e2e-hooks','--','--locked'],'buildCommandKnown':False,'startedAt':now,'completedAt':now,'binary':binary,'binarySha256':sha(binary),'binaryBytes':os.stat(binary).st_size,'binaryModifiedAt':datetime.datetime.fromtimestamp(os.stat(binary).st_mtime,datetime.timezone.utc).isoformat(),'qualification':'working-snapshot-only','buildTimesKnown':False,'sourcePostBuildStatusSha256':hashlib.sha256(dirty.encode()).hexdigest(),'sourcePostBuildDirty':bool(dirty.strip()),'archives':[{'path':p,'sha256':sha(p)} for p in [trace,provider] if p]}
open(manifest,'w').write(json.dumps(record,indent=2)+'\n')
PY
printf 'Private working-snapshot profile: %s\n' "$profile"
# The host's default text profile is the Codex CLI, and the CLI adapters pass
# CODEX_HOME/CLAUDE_CONFIG_DIR through. Point both at empty private homes and
# shadow the real executables with refusing shims, so no saved CLI login can
# ever run a real model call from this fixture.
cli_home="$profile/cli"
mkdir -p "$cli_home/bin" "$cli_home/codex-home" "$cli_home/claude-home"
for cli in codex claude; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$0 $*" >> "%s/invocations.log"\necho "%s is disabled in native acceptance" >&2\nexit 127\n' "$cli_home" "$cli" > "$cli_home/bin/$cli"
  chmod 755 "$cli_home/bin/$cli"
done
export PATH="$cli_home/bin:$PATH" CODEX_HOME="$cli_home/codex-home" CLAUDE_CONFIG_DIR="$cli_home/claude-home"
trap 'printf "Refused CLI invocations: %s (%s)\n" "$(cat "$cli_home/invocations.log" 2>/dev/null | wc -l)" "$cli_home/invocations.log"' EXIT
# Remove auth environment variables from this isolated launch only. Never change HOME.
env -u WAYLAND_DISPLAY -u OPENAI_API_KEY -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN -u ANTHROPIC_API_KEY GDK_BACKEND=x11 \
  xvfb-run -a --server-args="-screen 0 1440x1000x24" dbus-run-session -- \
  bash e2e-tauri/with-window-manager.sh bunx wdio run e2e-tauri/wdio.conf.ts --spec e2e-tauri/specs/shared-ai-services.spec.ts
# Preserve private journals and identity evidence for independent inspection.
