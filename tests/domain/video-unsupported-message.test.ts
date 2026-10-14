import { expect, it } from "vitest";
import { unsupportedVideoMessage } from "$lib/domain/video-preview";
it("names the detected codecs", () => {
  const m = unsupportedVideoMessage({ container: "MP4", videoCodec: "H.265 (HEVC)", audioCodec: "AAC" });
  expect(m).toContain("H.265 (HEVC)"); expect(m).toContain("AAC"); expect(m).toContain("MP4");
});
it("still reports unsupported when the codec is unknown", () => {
  for (const info of [null, { container: null, videoCodec: null, audioCodec: null }])
    expect(unsupportedVideoMessage(info)).toMatch(/not supported.*could not be determined/);
});
