#!/bin/bash
# PreToolUse hook: runs unit tests before every git commit.
# ~3s overhead — catches broken tests before they reach dev.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on git commit
echo "$CMD" | grep -qE 'git\s+commit' || exit 0

# Skip on protected branches (no direct commits there anyway)
BRANCH=$(git branch --show-current 2>/dev/null)
case "$BRANCH" in
  main|dev) exit 0 ;;
esac

echo "Running unit tests before commit..." >&2

OUTPUT=$(npx vitest run 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Blocked: unit tests failed. Fix before committing." >&2
  echo "$OUTPUT" | grep -E "FAIL|×|Error" | head -10 >&2
  exit 2
fi

PASS_LINE=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | tail -1)
echo "Unit tests passed ($PASS_LINE)." >&2
exit 0
