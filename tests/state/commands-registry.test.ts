/**
 * Command registry behavior (#280): registration/override/unregister, the
 * `when()` gate, and executeCommand's success/failure contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAvailableCommands,
  executeCommand,
  type Command,
} from "$lib/state/commands.svelte";

function cmd(id: string, overrides: Partial<Command> = {}): Command {
  return { id, label: id, category: "general", handler: vi.fn(), ...overrides };
}

const TEST_IDS = ["t.a", "t.b", "t.gated", "t.hidden", "t.throws"];

beforeEach(() => {
  for (const id of TEST_IDS) unregisterCommand(id);
});

describe("command registry (#280)", () => {
  it("registers, overrides by id, and unregisters", () => {
    registerCommand(cmd("t.a", { label: "first" }));
    expect(getCommand("t.a")?.label).toBe("first");

    // Re-registering the same id replaces the command (plugin reload path).
    registerCommand(cmd("t.a", { label: "second" }));
    expect(getCommand("t.a")?.label).toBe("second");

    unregisterCommand("t.a");
    expect(getCommand("t.a")).toBeUndefined();
  });

  it("getAvailableCommands filters hidden commands and failed when() gates", () => {
    registerCommand(cmd("t.a"));
    registerCommand(cmd("t.hidden", { hidden: true }));
    registerCommand(cmd("t.gated", { when: () => false }));

    const ids = getAvailableCommands().map((c) => c.id);
    expect(ids).toContain("t.a");
    expect(ids).not.toContain("t.hidden");
    expect(ids).not.toContain("t.gated");
  });

  it("executeCommand runs the handler and reports success", async () => {
    const handler = vi.fn();
    registerCommand(cmd("t.a", { handler }));

    await expect(executeCommand("t.a")).resolves.toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("executeCommand refuses unknown ids and failed gates without running anything", async () => {
    const handler = vi.fn();
    registerCommand(cmd("t.gated", { when: () => false, handler }));

    await expect(executeCommand("does.not.exist")).resolves.toBe(false);
    await expect(executeCommand("t.gated")).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("executeCommand reports false when the handler throws, without propagating", async () => {
    registerCommand(
      cmd("t.throws", {
        handler: () => {
          throw new Error("boom");
        },
      }),
    );

    await expect(executeCommand("t.throws")).resolves.toBe(false);
  });
});
