import { expect, it, vi } from "vitest";
import { validateReport, processReport, createInMemoryRateLimitStore, ReportError } from "../../website/api/_report-core.js";
const clips = [
  ["video/mp4", "000000186674797069736f6d0000000069736f6d6d703432"],
  ["video/quicktime", "0000001466747970717420200000000071742020"],
  ["video/webm", "1a45dfa3"],
] as const;
const report = (mediaType: string, hex: string) => ({ title: "Video report", body: "Steps", kind: "bug", attachments: [{ name: "clip[1].wrong", mediaType, data: Buffer.from(hex, "hex").toString("base64") }] });
it.each(clips)("hosts %s and puts a video link in the created issue", async (mediaType, hex) => {
  const upload = vi.fn().mockResolvedValue("https://blob.example/clip");
  const create = vi.fn().mockResolvedValue({ url: "https://github.com/xnmp/tauri-explorer/issues/1", number: 1 });
  await processReport(report(mediaType, hex), "ip", createInMemoryRateLimitStore(), create, { upload, remove: vi.fn() });
  expect(upload.mock.calls[0][0]).toMatchObject({ mediaType, bytes: new Uint8Array(Buffer.from(hex, "hex")) });
  expect(create.mock.calls[0][0].body).toContain("## Attachments\n\n[clip\\[1\\].wrong](https://blob.example/clip)");
  expect(create.mock.calls[0][0].body).not.toContain("![");
});
it.each(clips)("rejects malformed %s", (mediaType) => {
  expect(() => validateReport(report(mediaType, "00010203"))).toThrow(ReportError);
});
it("cleans up videos if issue creation definitely fails", async () => {
  const remove = vi.fn();
  await expect(processReport(report(...clips[0]), "ip", createInMemoryRateLimitStore(), async () => { throw new ReportError("server_rejected", "No"); }, { upload: async () => "https://blob.example/clip", remove })).rejects.toMatchObject({ code: "server_rejected" });
  expect(remove).toHaveBeenCalledWith(["https://blob.example/clip"]);
});
