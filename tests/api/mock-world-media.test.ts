import { describe, expect, it } from "vitest";
import { createMockMediaLoader } from "$lib/api/mock-world-media";

const ok = (text: string) => new Response(new Blob([text]), { status: 200 });

describe("mock media loader", () => {
  it("fetches each asset once while it succeeds", async () => {
    let calls = 0;
    const loader = createMockMediaLoader(async () => { calls++; return ok("abc"); });
    await loader.bytes("http://a/x.png");
    await loader.bytes("http://a/x.png");
    expect(calls).toBe(1);
  });

  it.each([
    ["a network error", () => Promise.reject(new TypeError("offline"))],
    ["an HTTP error", () => Promise.resolve(new Response("", { status: 503 }))],
  ])("retries after %s instead of caching the failure", async (_label, failOnce) => {
    let calls = 0;
    const loader = createMockMediaLoader(() => (++calls === 1 ? failOnce() : Promise.resolve(ok("abc"))));
    await expect(loader.bytes("http://a/x.png")).rejects.toBeDefined();
    const bytes = await loader.bytes("http://a/x.png");
    expect(new TextDecoder().decode(bytes)).toBe("abc");
    expect(calls).toBe(2);
  });
});
