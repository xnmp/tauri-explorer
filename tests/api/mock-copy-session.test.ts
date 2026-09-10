import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { HistorySummary } from "$lib/domain/file-history";

vi.stubGlobal("window", {} as Window & typeof globalThis);
const { mockInvoke } = await import("$lib/api/mock-invoke");

let sequence = 0;
const freshDir = async (label: string) => {
  const name = `copy-session-${label}-${Date.now()}-${sequence++}`;
  await mockInvoke("create_directory", { parentPath: "/home/user", name });
  return `/home/user/${name}`;
};
const write = (path: string) => mockInvoke("write_text_file", { path, content: "x" });
const copy = (
  sources: string[],
  destDir: string,
  receive: (event: CopySessionEvent) => void = () => {},
) => mockInvoke<{ result: CopySessionOutcome; history: HistorySummary }>("copy_entries", {
  sessionId: "mock-session",
  request: { requestId: crypto.randomUUID(), sources, destDir, jobId: 1, shared: false },
  events: receive,
});

beforeEach(() => vi.restoreAllMocks());

describe("mock copy session parity", () => {
  it("copies within the same directory without prompting for its existing source name", async () => {
    const parent = await freshDir("same-parent");
    await write(`${parent}/a.txt`);
    const events: CopySessionEvent[] = [];
    const reply = await copy([`${parent}/a.txt`], parent, event => events.push(event));
    expect(events.some(({ type }) => type === "conflict")).toBe(false);
    expect(reply.result.items[0]).toMatchObject({ status: "succeeded", receipt: { path: `${parent}/a - Copy.txt` } });
  });

  it("reports an absent source before considering a same-named destination conflict", async () => {
    const destination = await freshDir("missing-source");
    await write(`${destination}/absent.txt`);
    const events: CopySessionEvent[] = [];
    const reply = await copy([`/missing/absent.txt`], destination, event => events.push(event));
    expect(events.some(({ type }) => type === "conflict")).toBe(false);
    expect(reply.result.items).toEqual([{ status: "failed", error: "Source not found" }]);
  });

  it("applies Skip All only to later items which actually conflict", async () => {
    const source = await freshDir("skip-source");
    const destination = await freshDir("skip-destination");
    await write(`${source}/a.txt`);
    await write(`${source}/b.txt`);
    await write(`${destination}/a.txt`);
    const requestId = crypto.randomUUID();
    const reply = await mockInvoke<{ result: CopySessionOutcome; history: HistorySummary }>("copy_entries", {
      sessionId: "mock-session",
      request: { requestId, sources: [`${source}/a.txt`, `${source}/b.txt`],
        destDir: destination, jobId: 1, shared: false },
      events: (event: CopySessionEvent) => {
        if (event.type === "conflict") void mockInvoke("resolve_copy_conflict", {
          requestId, item: event.item, nonce: event.nonce,
          decision: { choice: "skip", applyToAll: true },
        });
      },
    });
    expect(reply.result.items.map(({ status }) => status)).toEqual(["skipped", "succeeded"]);
  });
});
