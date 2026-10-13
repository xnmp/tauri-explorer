/**
 * "Git: Open Issues in Browser" (#1055): the palette command resolves the
 * active pane's repo to its GitHub issues page and hands that URL to the
 * system browser; every dead end reports why instead of opening nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  explorer: { state: { currentPath: "/work/widgets/src" } } as
    | { state: { currentPath: string } }
    | undefined,
  gitRepoRoot: vi.fn(),
  gitIssuesUrl: vi.fn(),
  openExternalUrl: vi.fn(),
  show: vi.fn(),
  error: vi.fn(),
}));

vi.mock("$lib/state/commands/shared", () => ({
  getActiveExplorer: () => h.explorer,
  openNewWindow: vi.fn(),
}));
vi.mock("$lib/api/git", () => ({ gitRepoRoot: h.gitRepoRoot }));
vi.mock("$lib/api/git-log", () => ({
  gitFetch: vi.fn(),
  gitIssuesUrl: h.gitIssuesUrl,
}));
vi.mock("$lib/api/crash", () => ({ openExternalUrl: h.openExternalUrl }));
vi.mock("$lib/state/toast.svelte", () => ({
  toastStore: { show: h.show, error: h.error, success: vi.fn() },
}));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {} }));

import { gitGraphCommands } from "$lib/state/commands/general-commands";

const command = gitGraphCommands.find((c) => c.id === "git.openIssues")!;

beforeEach(() => {
  vi.clearAllMocks();
  h.explorer = { state: { currentPath: "/work/widgets/src" } };
  h.gitRepoRoot.mockResolvedValue({ ok: true, data: "/work/widgets" });
  h.gitIssuesUrl.mockResolvedValue("https://github.com/octo/widgets/issues");
  h.openExternalUrl.mockResolvedValue(undefined);
});

describe("git.openIssues (#1055)", () => {
  it("is a labelled git palette command", () => {
    expect(command).toBeDefined();
    expect(command.label).toBe("Git: Open Issues in Browser");
  });

  it("opens the GitHub issues page of the active pane's repo", async () => {
    await command.handler();

    expect(h.gitRepoRoot).toHaveBeenCalledWith("/work/widgets/src");
    expect(h.gitIssuesUrl).toHaveBeenCalledWith("/work/widgets");
    expect(h.openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/octo/widgets/issues",
    );
    expect(h.show).not.toHaveBeenCalled();
  });

  it("explains and opens nothing when the folder is not in a git repo", async () => {
    h.gitRepoRoot.mockResolvedValue({ ok: true, data: null });
    await command.handler();

    expect(h.show).toHaveBeenCalledWith("Not inside a git repository", "info");
    expect(h.openExternalUrl).not.toHaveBeenCalled();
  });

  it("explains and opens nothing when the repo has no GitHub remote", async () => {
    h.gitIssuesUrl.mockResolvedValue(null);
    await command.handler();

    expect(h.show).toHaveBeenCalledWith("No GitHub remote found for this folder", "info");
    expect(h.openExternalUrl).not.toHaveBeenCalled();
  });

  it("reports a failed browser handoff instead of failing silently", async () => {
    h.openExternalUrl.mockRejectedValue(new Error("no browser"));
    await command.handler();

    expect(h.error).toHaveBeenCalledWith("no browser");
  });

  it("is unavailable without an active pane", () => {
    h.explorer = undefined;
    expect(command.when?.()).toBe(false);
    h.explorer = { state: { currentPath: "/work" } };
    expect(command.when?.()).toBe(true);
  });
});
