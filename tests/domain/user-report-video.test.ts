import { expect, it } from "vitest";
import { validateUserReportAttachmentFiles } from "$lib/domain/user-report";
import { createUserReportDraftStore } from "$lib/state/user-report-draft.svelte";
const clips = [
  ["video/mp4", Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex")],
  ["video/quicktime", Buffer.from("0000001466747970717420200000000071742020", "hex")],
  ["video/webm", Buffer.from("1a45dfa3", "hex")],
] as const;
it.each(clips)("adds %s to the actual report draft", async (type, bytes) => {
  const store = createUserReportDraftStore();
  try {
    const attachment = { name: "clip", mediaType: type, data: bytes.toString("base64") };
    expect(await store.attachFiles([{ name: "clip", type, size: bytes.length }], async () => [attachment])).toBeNull();
    expect(store.attachments).toEqual([attachment]);
    expect(await store.attachClipboard(async () => attachment)).toBeNull();
    expect(store.attachments).toHaveLength(2);
  } finally { store.dispose(); }
});
it.each(clips)("rejects mismatched %s bytes before adding to a draft", async (type) => {
  const store = createUserReportDraftStore();
  try {
    expect(await store.attachFiles([{ name: "fake", type, size: 8 }], async () => [{ name: "fake", mediaType: type, data: Buffer.from("notmedia").toString("base64") }])).toMatch(/invalid|match/i);
    expect(store.attachments).toHaveLength(0);
  } finally { store.dispose(); }
});
it("explains how to reduce an oversized video and keeps count/total caps", () => {
  const file = { name: "big.mp4", type: "video/mp4", size: 2097153 };
  expect(validateUserReportAttachmentFiles([file])).toMatch(/shorter.*lower quality/i);
  expect(validateUserReportAttachmentFiles([{ ...file, size: 1024 }], { count: 3, bytes: 0 })).toMatch(/3/);
  expect(validateUserReportAttachmentFiles([{ ...file, size: 2097152 }], { count: 1, bytes: 2097152 })).toMatch(/3 MiB/);
  expect(validateUserReportAttachmentFiles([{ ...file, type: "video/avi", size: 12 }])).toMatch(/MP4/);
});
