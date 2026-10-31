import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Token reports (#1455) are created natively; anonymous ones by the relay.
// Both must target the same repository. This lives in Vitest rather than a
// Rust include_str! so the Rust test cache need not hash website/.
describe("report repository parity", () => {
  it("native token submission and the relay create issues in the same repository", () => {
    const native = readFileSync("src-tauri/src/user_report_github.rs", "utf8");
    const relay = readFileSync("website/api/report.js", "utf8");
    const url = native.match(/"(https:\/\/api\.github\.com\/repos\/[^"]+\/issues)"/)?.[1];
    expect(url).toBeDefined();
    expect(relay).toContain(`"${url}"`);
  });
});
