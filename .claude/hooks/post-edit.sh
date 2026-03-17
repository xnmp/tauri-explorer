#!/bin/bash
# Post-edit hook: runs unit tests and type check in parallel after every Edit/Write.
# Target: <10s total. Both checks run concurrently.

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# Only check TS/Svelte files
case "$FILE" in
  *.ts|*.svelte) ;;
  *) exit 0 ;;
esac

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Run tests and type check in parallel
bun run test 2>&1 | tail -5 > "$TMPDIR/tests" &
PID_TEST=$!

# Get relative path to match svelte-check output format
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REL_PATH="${FILE#$PROJECT_ROOT/}"
bunx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -F "\"$REL_PATH\"" | head -10 > "$TMPDIR/types" &
PID_TYPES=$!

wait $PID_TEST
TEST_EXIT=$?

wait $PID_TYPES
TYPE_EXIT=$?

# Only output if there are problems
TESTS=$(cat "$TMPDIR/tests")
TYPES=$(cat "$TMPDIR/types")

if [ $TEST_EXIT -ne 0 ] || [ -s "$TMPDIR/types" ]; then
  echo "=== Post-edit check ==="
  if [ $TEST_EXIT -ne 0 ]; then
    echo "TESTS FAILED:"
    echo "$TESTS"
  fi
  if [ -s "$TMPDIR/types" ]; then
    echo "TYPE ERRORS:"
    echo "$TYPES"
  fi
fi

exit 0
