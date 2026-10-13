import { expect, it, vi, afterEach } from "vitest";
const blob = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn() }));
vi.mock("../../website/node_modules/@vercel/blob/dist/index.js", () => blob);
import handler from "../../website/api/report.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([
  ["video/mp4", "mp4", "000000186674797069736f6d0000000069736f6d6d703432"],
  ["video/quicktime", "mov", "0000001466747970717420200000000071742020"],
  ["video/webm", "webm", "1a45dfa3"],
])("uploads %s with a matching Blob content type and extension", async (mediaType, extension, hex) => {
  vi.stubEnv("VERCEL", ""); vi.stubEnv("KV_REST_API_URL", ""); vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("GITHUB_ISSUE_TOKEN", "test"); vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test");
  blob.put.mockResolvedValue({ url: "https://blob.example/clip" });
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ html_url: "https://github.com/xnmp/tauri-explorer/issues/1", number: 1 }) });
  vi.stubGlobal("fetch", fetch);
  const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), end: vi.fn().mockReturnThis() };
  await handler({ method: "POST", headers: { "x-forwarded-for": `video-${extension}` }, body: { title: "Clip", body: "Steps", kind: "bug", attachments: [{ name: "clip.wrong", mediaType, data: Buffer.from(hex, "hex").toString("base64") }] } }, response);
  expect(response.status).toHaveBeenCalledWith(200);
  expect(blob.put).toHaveBeenCalledWith(`user-reports/clip.${extension}`, Buffer.from(hex, "hex"), expect.objectContaining({ contentType: mediaType, access: "public" }));
  expect(JSON.parse(fetch.mock.calls[0][1].body).body).toContain("[clip.wrong](https://blob.example/clip)");
});
