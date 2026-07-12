/**
 * Mock-side git contract tests.
 *
 * Drives src/lib/api/mock-invoke.ts through the same scenarios the mirrored
 * Rust #[test]s in src-tauri/src/git.rs drive the real git2 backend through,
 * asserting both agree with the shared JSON fixtures in ./fixtures.
 *
 * If the mock's git_status classification, git_commit conflict guard, or
 * git_discard conflict guard drift from the real backend, one side fails.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The mock's merge-conflict affordances register on `window` at import time
// (the same hooks the browser E2E suite uses). Stub a window before importing
// so they are available in this Node test. Vitest isolates modules per file, so
// this does not leak the stub into other suites.
vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);
const { mockInvoke } = await import("../../src/lib/api/mock-invoke");

const REPO = "/home/user/Documents/project";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

const gitStatusFx = fixture("git_status.json");
const gitCommitFx = fixture("git_commit.json");
const gitDiscardFx = fixture("git_discard.json");

interface GitEntry {
  status: string;
}
interface Summary {
  op_state: string;
  staged: GitEntry[];
  changes: GitEntry[];
  untracked: GitEntry[];
  merge: GitEntry[];
}

/** Normalize a git_status summary to the shared fixture shape: a
 *  { statusCode: count } histogram per bucket plus op_state. Paths are dropped
 *  on purpose — the mock and the real repo use different file names; only the
 *  classification is contractual. */
function counts(entries: GitEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.status] = (out[e.status] ?? 0) + 1;
  return out;
}
function normalize(s: Summary) {
  return {
    op_state: s.op_state,
    staged: counts(s.staged),
    changes: counts(s.changes),
    untracked: counts(s.untracked),
    merge: counts(s.merge),
  };
}

const win = () =>
  window as unknown as {
    __mockGitReset: () => void;
    __mockGitSetClean: () => void;
    __mockGitStartMergeConflict: () => void;
  };

const status = () => mockInvoke<Summary>("git_status", { repoPath: REPO });

describe("git contract — mock agrees with real backend (fixtures)", () => {
  beforeEach(() => {
    win().__mockGitReset();
  });

  describe("git_status bucket classification + op_state", () => {
    it("clean tree", async () => {
      win().__mockGitSetClean();
      expect(normalize(await status())).toEqual(gitStatusFx.clean);
    });

    it("dirty tree (staged / changes / untracked buckets)", async () => {
      expect(normalize(await status())).toEqual(gitStatusFx.dirty_tree);
    });

    it("conflicted merge (merge bucket + op_state=merge)", async () => {
      win().__mockGitSetClean();
      win().__mockGitStartMergeConflict();
      expect(normalize(await status())).toEqual(gitStatusFx.conflicted_merge);
    });
  });

  describe("git_commit conflict guard", () => {
    it("refuses to commit while a merge conflict is unresolved", async () => {
      win().__mockGitSetClean();
      win().__mockGitStartMergeConflict();
      const fx = gitCommitFx.commit_while_conflicted as {
        expect_error: boolean;
        error_substring: string;
      };
      await expect(mockInvoke("git_commit", { message: "resolve merge", options: null })).rejects.toThrow(
        fx.error_substring,
      );
    });
  });

  describe("git_discard conflict guard", () => {
    it("refuses to discard a conflicted path (no silent deletion)", async () => {
      win().__mockGitSetClean();
      win().__mockGitStartMergeConflict();
      const fx = gitDiscardFx.discard_conflicted_refuses as {
        expect_error: boolean;
        error_substring: string;
      };
      await expect(
        mockInvoke("git_discard", { paths: ["src/constants.ts"], options: null }),
      ).rejects.toThrow(fx.error_substring);
      // The conflicted entry must remain — refusing means not dropping it.
      const after = await status();
      expect(after.merge.some((e) => (e as unknown as { path: string }).path === "src/constants.ts")).toBe(
        true,
      );
    });
  });
});
