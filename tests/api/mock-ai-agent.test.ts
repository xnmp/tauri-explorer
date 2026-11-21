/** The browser mock's folder agent (#1884) answers deterministically, refuses
 *  what native refuses, and honours cancellation. */
import { afterEach, describe, expect, it } from "vitest";
import { aiCommands } from "$lib/api/mock-ai";
import { getMockControl } from "$lib/api/mock-control";
import { mockFiles } from "$lib/api/mock-fixtures";

const folder = Object.keys(mockFiles).find((path) => mockFiles[path].some((entry) => entry.kind === "file"))!;
const run = (args: Record<string, unknown>) =>
  aiCommands.ai_agent_run({ requestId: "agent.t.x.1", folder, instructions: "Find the extension", input: "", maxOutputTokens: 256, ...args }) as Promise<{ text: string; model: string }>;

afterEach(() => {
  const control = getMockControl();
  delete control.aiAgentUnavailable;
  delete control.aiAgentReply;
  delete control.aiAgentDelayMs;
});

describe("mock folder agent", () => {
  it("describes a Claude-like connection with the cheapest model as default", () => {
    expect(aiCommands.ai_agent_describe({})).toMatchObject({ available: true, models: ["haiku", "sonnet", "opus"], defaultModel: "haiku", readScope: "folder", maxTimeoutMs: 300_000, maxConcurrent: 2 });
  });

  it("maps every file of the folder to its extension", async () => {
    const result = await run({});
    const expected = Object.fromEntries(mockFiles[folder].filter((entry) => entry.kind === "file").map((entry) => {
      const dot = entry.name.lastIndexOf(".");
      return [entry.name, dot > 0 ? entry.name.slice(dot + 1).toUpperCase() : "NONE"];
    }));
    expect(JSON.parse(result.text)).toEqual(expected);
    expect(result.model).toBe("haiku");
  });

  it("refuses an unavailable connection, a virtual folder and an unoffered model", async () => {
    await expect(run({ folder: "trash://" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(run({ folder: "relative/dir" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(run({ model: "gpt-unknown" })).rejects.toMatchObject({ code: "invalid_request" });
    getMockControl().aiAgentUnavailable = true;
    expect(aiCommands.ai_agent_describe({})).toMatchObject({ available: false, models: [], error: { code: "unsupported" } });
    await expect(run({})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("ends a delayed job with `cancelled` when it is cancelled", async () => {
    getMockControl().aiAgentDelayMs = 60_000;
    const job = run({ requestId: "agent.t.x.2" });
    expect(aiCommands.ai_agent_cancel({ requestId: "agent.t.x.2" })).toBe(true);
    await expect(job).rejects.toMatchObject({ code: "cancelled" });
  });
});
