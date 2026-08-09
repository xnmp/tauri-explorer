import { describe, expect, it } from "vitest";
import { isE2EMode } from "$lib/e2e-mode";

describe("Tauri E2E build mode", () => {
  it("enables real-binary test hooks in the embedded smoke build", () => {
    expect(isE2EMode({ DEV: false, VITE_TAURI_E2E: "1" })).toBe(true);
  });

  it("keeps real-binary test hooks out of normal production builds", () => {
    expect(isE2EMode({ DEV: false })).toBe(false);
  });
});
