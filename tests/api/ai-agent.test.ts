/** Folder-agent IPC wrapper and host request IDs (#1884). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
// A plain function in front of the spy: the rejection test must see the very
// promise the wrapper returns, not one the spy also observes.
const backend = vi.hoisted(() => ({ reject: null as unknown }));
vi.mock("$lib/api/common", () => ({
  invoke: (...args: unknown[]) => (backend.reject ? (invokeMock(...args), Promise.reject(backend.reject)) : invokeMock(...args)),
}));

import { cancelAgent, describeAgent, runAgent } from "$lib/api/ai-agent";
import { agentRequestId } from "$lib/domain/ai-agent";

beforeEach(() => { invokeMock.mockReset(); backend.reject = null; });

describe("ai-agent wrapper", () => {
  it("describes through ai_agent_describe without arguments", async () => {
    const description = { version: 1, available: true, models: ["haiku"], defaultModel: "haiku" };
    invokeMock.mockResolvedValue(description);
    await expect(describeAgent()).resolves.toBe(description);
    expect(invokeMock).toHaveBeenCalledWith("ai_agent_describe");
  });

  it("runs with every request field as a command argument, unchanged", async () => {
    const request = {
      requestId: "agent.p.x.1", folder: "/home/u/invoices", instructions: "Find the invoice date",
      input: "[\"a.pdf\"]", model: "haiku", maxOutputTokens: 2048, timeoutMs: 90_000, expectedConfigurationRevision: 7,
    };
    const result = { text: "{\"a.pdf\":\"2026-11-01\"}", model: "haiku", usage: { inputTokens: 10, outputTokens: 5 } };
    invokeMock.mockResolvedValue(result);
    await expect(runAgent(request)).resolves.toBe(result);
    expect(invokeMock).toHaveBeenCalledWith("ai_agent_run", request);
  });

  it("cancels by request ID", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(cancelAgent("agent.p.x.1")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("ai_agent_cancel", { requestId: "agent.p.x.1" });
  });

  it("passes native rejections through unchanged", async () => {
    const error = new Error("Folder agent jobs need a Claude Code CLI or Codex CLI connection");
    backend.reject = error;
    await expect(runAgent({ requestId: "r", folder: "/f", instructions: "i", input: "", maxOutputTokens: 1 })).rejects.toBe(error);
  });
});

describe("agentRequestId", () => {
  const NATIVE_ID = /^[A-Za-z0-9._-]{1,128}$/;

  it("scopes IDs to the plugin and the context incarnation", () => {
    expect(agentRequestId("acme.columns", "k3j9", 4)).toBe("agent.acme.columns.k3j9.4");
    expect(agentRequestId("acme", "a", 1)).not.toBe(agentRequestId("acme", "b", 1));
    expect(agentRequestId("acme", "a", 1)).not.toBe(agentRequestId("acme", "a", 2));
  });

  it("always yields an ID native accepts, whatever the plugin ID", () => {
    for (const pluginId of ["", "a b/c", "ünïcode✓", "x".repeat(500), "../../etc", "@scope/pkg"]) {
      for (const incarnation of ["", "%%%", "y".repeat(100)]) {
        const id = agentRequestId(pluginId, incarnation, Number.MAX_SAFE_INTEGER);
        expect(id, `${pluginId} / ${incarnation}`).toMatch(NATIVE_ID);
      }
    }
  });
});
