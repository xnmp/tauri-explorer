#!/bin/bash
# PostToolUse(Edit|Write) hook: non-blocking architectural lint of the edited
# file (#304). Runs scripts/arch-lint.mjs in single-file --warn mode and
# surfaces any layering warnings as additionalContext. NEVER blocks: always
# exits 0, even when violations are found or the linter itself fails.

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Only source files covered by the layering rules.
case "$FILE" in
  *.ts|*.js|*.svelte|*.rs) ;;
  *) exit 0 ;;
esac

ROOT="${CLAUDE_PROJECT_DIR:-$(echo "$INPUT" | jq -r '.cwd // empty')}"
[ -z "$ROOT" ] && exit 0
[ -f "$ROOT/scripts/arch-lint.mjs" ] || exit 0

# Only the layered trees.
case "$FILE" in
  "$ROOT"/src/lib/*|"$ROOT"/src-tauri/src/*) ;;
  *) exit 0 ;;
esac

WARNINGS=$(node "$ROOT/scripts/arch-lint.mjs" --warn "$FILE" 2>/dev/null)
[ -z "$WARNINGS" ] && exit 0

# Human-visible in the transcript…
echo "arch-lint warnings (non-blocking):" >&2
echo "$WARNINGS" >&2

# …and surfaced to the model without blocking.
jq -n --arg ctx "arch-lint layering warnings (non-blocking; rules + allowlists in scripts/arch-lint.mjs):
$WARNINGS" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
exit 0
