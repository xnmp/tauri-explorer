/** A click on the video itself toggles fullscreen, as picture preview's click does (#1058). */
import { describe, expect, it } from "vitest";
import { videoClickAction } from "$lib/domain/video-preview";

describe("videoClickAction", () => {
  it("toggles fullscreen when the click lands on the video surface", () => {
    expect(videoClickAction("surface")).toBe("fullscreen");
  });

  it("leaves the loading and error overlays and their buttons without an action", () => {
    expect(videoClickAction("message")).toBeNull();
    expect(videoClickAction("button")).toBeNull();
  });
});
