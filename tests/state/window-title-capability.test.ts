import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("native window-title capability", () => {
  it("allows the frontend title sync to reach Tauri windows", () => {
    const capability = JSON.parse(
      readFileSync("src-tauri/capabilities/default.json", "utf8"),
    ) as { permissions: string[] };

    expect(capability.permissions).toContain("core:window:allow-set-title");
  });
});
