#!/bin/bash
# PreToolUse hook: runs e2e tests before merging any branch into dev.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on git merge
echo "$CMD" | grep -qE 'git\s+merge' || exit 0

# Only enforce when on dev branch (merging INTO dev)
BRANCH=$(git branch --show-current 2>/dev/null)
[ "$BRANCH" = "dev" ] || exit 0

echo "Running e2e tests before merge to dev..." >&2

# Run e2e tests
OUTPUT=$(bun run test:e2e 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "Blocked: e2e tests failed. Fix before merging to dev." >&2
  echo "$OUTPUT" | grep -E "failed|Error" | tail -10 >&2
  exit 2
fi

echo "e2e tests passed." >&2
exit 0
