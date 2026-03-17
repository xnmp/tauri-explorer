#!/bin/bash
# PreToolUse hook: blocks git commit on feat/ branches if no test files are included.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on git commit
echo "$CMD" | grep -qE 'git\s+commit' || exit 0

BRANCH=$(git branch --show-current 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

# Only enforce on feature branches
echo "$BRANCH" | grep -qE '^feat/' || exit 0

# Check all files on this branch (committed + staged) vs dev
COMMITTED=$(git diff --name-only dev...HEAD 2>/dev/null)
STAGED=$(git diff --cached --name-only 2>/dev/null)
ALL_CHANGES=$(printf "%s\n%s" "$COMMITTED" "$STAGED" | sort -u)

# If tests already exist anywhere on the branch, allow all further commits
UNIT_COUNT=$(echo "$ALL_CHANGES" | grep -cE 'tests/.*\.test\.ts$' || true)
E2E_COUNT=$(echo "$ALL_CHANGES" | grep -cE 'e2e/.*\.spec\.ts$' || true)
[ "$UNIT_COUNT" -gt 0 ] || [ "$E2E_COUNT" -gt 0 ] && exit 0

# No tests yet — check if there are source changes that need them
SRC_COUNT=$(echo "$ALL_CHANGES" | grep -cE 'src/(lib|routes)/.*\.(ts|svelte)$' || true)
RUST_COUNT=$(echo "$ALL_CHANGES" | grep -cE 'src-tauri/src/.*\.rs$' || true)
SRC_TOTAL=$((SRC_COUNT + RUST_COUNT))

if [ "$SRC_TOTAL" -gt 0 ]; then
  echo "Blocked: feat/ branch '$BRANCH' has $SRC_TOTAL changed source files but no tests." >&2
  echo "Add unit tests (tests/*.test.ts) and/or e2e tests (e2e/*.spec.ts) before committing." >&2
  exit 2
fi

exit 0
