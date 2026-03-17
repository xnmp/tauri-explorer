#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.svelte) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASENAME=$(basename "$FILE")

RAW=$(cd "$PROJECT_ROOT" && bunx svelte-check --tsconfig ./tsconfig.json 2>&1)

# Find error lines mentioning this file
RAW_ERRORS=$(echo "$RAW" | grep -F "$BASENAME" | grep "ERROR")

if [ -z "$RAW_ERRORS" ]; then
  exit 0
fi

# Try to extract "line:col message" from format: TIMESTAMP ERROR "path" line:col "message"
PARSED=$(echo "$RAW_ERRORS" | sed -n 's/^[0-9]* ERROR "[^"]*" \([0-9]*:[0-9]*\) "\(.*\)"$/\1 \2/p')

if [ -n "$PARSED" ]; then
  echo "Type errors in $BASENAME:" >&2
  echo "$PARSED" >&2
else
  # Fallback: show raw error lines if parsing failed
  echo "Type errors in $BASENAME (raw):" >&2
  echo "$RAW_ERRORS" >&2
fi

exit 2
