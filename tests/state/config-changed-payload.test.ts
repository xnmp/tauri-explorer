/**
 * `config-file-changed` payloads cross the IPC boundary. Only the
 * `{filename: string}` shape is acted on; anything else is ignored rather
 * than throwing an unhandled rejection in the listener.
 */
import { describe, it, expect } from "vitest";
import { changedFilename } from "$lib/state/config-watch";

describe("changedFilename", () => {
  it("reads the filename the backend sends", () => {
    expect(changedFilename({ filename: "settings.json" })).toBe("settings.json");
    expect(changedFilename({ filename: "themes/dark.css" })).toBe("themes/dark.css");
    expect(changedFilename({ filename: "" })).toBe("");
  });

  it("ignores payloads of any other shape", () => {
    for (const payload of ["plugin.openai-image.json", null, undefined, 7, [], {}, { filename: 3 }, { name: "settings.json" }]) {
      expect(changedFilename(payload)).toBeNull();
    }
  });
});
