#!/bin/bash
# PreToolUse hook: runs e2e tests before merging any branch into dev.
#
# Tiered gating: instead of the full suite, run the @smoke set plus the specs
# affected by the branch's diff (dev...<branch>). If the affected computation
# says ALL (backend / hub / mock / unmapped change), run the full suite as
# before. Block the merge on any failure (exit 2), preserving prior messages.
#
# Set E2E_HOOK_DRYRUN=1 to print the playwright commands instead of running
# them (used by the bash test harness).

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only trigger on git merge
echo "$CMD" | grep -qE 'git\s+merge' || exit 0

# Only enforce when on dev branch (merging INTO dev)
BRANCH=$(git branch --show-current 2>/dev/null)
[ "$BRANCH" = "dev" ] || exit 0

# --- resolve the branch being merged in -----------------------------------
# Strip any -m "message" / --message=... first so the message text can't be
# mistaken for a ref, then take the first non-flag token after "merge".
CLEAN=$(echo "$CMD" | sed -E "s/-m[[:space:]]+\"[^\"]*\"//g; s/-m[[:space:]]+'[^']*'//g; s/--message=[^[:space:]]*//g")
MERGE_REF=$(echo "$CLEAN" | sed -E 's/.*merge[[:space:]]+//' | tr ' ' '\n' | grep -vE '^-' | grep -vE '^$' | head -1)

if [ -z "$MERGE_REF" ]; then
  echo "Could not parse a merge ref from: $CMD" >&2
  echo "Falling back to the full e2e suite." >&2
  MERGE_REF=""
fi

echo "Running e2e tests before merge to dev..." >&2

# --- compute affected specs ------------------------------------------------
if [ -n "$MERGE_REF" ]; then
  echo "Computing affected e2e specs for '$MERGE_REF' (diff $BRANCH...$MERGE_REF)..." >&2
  AFFECTED=$(node scripts/e2e-affected.mjs "$BRANCH" "$MERGE_REF")
else
  AFFECTED="ALL"
fi

# --- build the playwright invocations (deduped) ----------------------------
# Each entry is a full argument string passed to `playwright test`.
declare -a PW_CMDS=()

if [ "$AFFECTED" = "ALL" ]; then
  echo "Affected = ALL — running the full e2e suite." >&2
  PW_CMDS+=("")   # empty args => whole suite
else
  AFF_LIST=$(echo "$AFFECTED" | grep -vE '^$')
  if [ -z "$AFF_LIST" ]; then
    # No affected specs: just run smoke across everything.
    echo "No affected specs — running the @smoke set only." >&2
    PW_CMDS+=("--grep @smoke")
  else
    # Affected spec files run in full; every other spec runs only its @smoke
    # tests. This unions "affected (full)" with "smoke elsewhere" without
    # re-running any spec twice.
    NONAFF=$(ls e2e/*.spec.ts | grep -vFf <(echo "$AFF_LIST"))
    AFF_ARGS=$(echo "$AFF_LIST" | tr '\n' ' ')
    echo "Running affected specs in full:" >&2
    echo "$AFF_LIST" | sed 's/^/  /' >&2
    PW_CMDS+=("$AFF_ARGS")
    if [ -n "$NONAFF" ]; then
      NONAFF_ARGS=$(echo "$NONAFF" | tr '\n' ' ')
      PW_CMDS+=("$NONAFF_ARGS --grep @smoke")
    fi
  fi
fi

# --- execute (or dry-run) --------------------------------------------------
for args in "${PW_CMDS[@]}"; do
  if [ "$E2E_HOOK_DRYRUN" = "1" ]; then
    echo "[dryrun] playwright test $args" >&2
    continue
  fi
  OUTPUT=$(bunx playwright test $args 2>&1)
  EXIT_CODE=$?
  if [ $EXIT_CODE -ne 0 ]; then
    echo "Blocked: e2e tests failed. Fix before merging to dev." >&2
    echo "$OUTPUT" | grep -E "failed|Error" | tail -10 >&2
    exit 2
  fi
done

echo "e2e tests passed." >&2
exit 0
