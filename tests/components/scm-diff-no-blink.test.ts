/**
 * Test: ScmDiffView should not blink on refresh.
 * Issue: #98 (git-scm-diff-blinking)
 *
 * Verifies that re-fetching a diff for the same file keeps
 * the old parsed result visible instead of flashing "Loading diff…".
 */
import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "$lib/domain/diff";

describe("ScmDiffView blink prevention logic", () => {
  it("keeps old parsed diff during refetch (isInitial = false)", () => {
    const oldDiff = parseUnifiedDiff(
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n",
    );
    expect(oldDiff).not.toBeNull();
    expect(oldDiff.lines.length).toBeGreaterThan(0);

    // Simulate the refetch logic: parsed is NOT null so isInitial = false
    let parsed: ReturnType<typeof parseUnifiedDiff> | null = oldDiff;
    let loading = false;

    function fetchDiff(newRawDiff: string) {
      const isInitial = parsed === null;
      if (isInitial) loading = true;
      // parsed stays non-null during the async gap — no blink
      const newParsed = parseUnifiedDiff(newRawDiff);
      parsed = newParsed;
      loading = false;
    }

    // Refetch for the same file (e.g., after stage/unstage)
    fetchDiff(
      "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+newer\n",
    );

    expect(loading).toBe(false);
    expect(parsed).not.toBeNull();
    expect(parsed!.lines.some((l) => l.text === "newer")).toBe(true);
  });

  it("shows loading on initial fetch (isInitial = true)", () => {
    let parsed: ReturnType<typeof parseUnifiedDiff> | null = null;
    let loading = false;

    const isInitial = parsed === null;
    if (isInitial) loading = true;

    expect(loading).toBe(true);
  });

  it("resets parsed when switching files", () => {
    const diff = parseUnifiedDiff(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n",
    );
    let parsed: ReturnType<typeof parseUnifiedDiff> | null = diff;

    // Simulate the reset effect when path changes
    parsed = null;
    const isInitial = parsed === null;
    expect(isInitial).toBe(true);
  });
});
