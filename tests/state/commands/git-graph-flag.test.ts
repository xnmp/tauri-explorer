/**
 * The commit graph is experimental and opt-in (#1675): its palette command is
 * unavailable on a fresh profile and appears once the user enables the flag.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { settingsStore } from "$lib/state/settings.svelte";
import { gitGraphCommands } from "$lib/state/commands/general-commands";

const showGraph = gitGraphCommands.find((c) => c.id === "git.showGraph")!;

beforeEach(() => {
  localStorage.clear();
  settingsStore.reset();
});

describe("Git commit graph feature flag (#1675)", () => {
  it("is off by default, so the graph command is unavailable", () => {
    expect(settingsStore.enableGitGraph).toBe(false);
    expect(showGraph.when?.()).toBe(false);
  });

  it("makes the graph command available once enabled", () => {
    settingsStore.toggleEnableGitGraph();
    expect(settingsStore.enableGitGraph).toBe(true);
    expect(showGraph.when?.()).toBe(true);
  });
});
