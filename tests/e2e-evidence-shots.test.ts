import { describe, expect, it, vi } from "vitest";
import { gateEvidence, isEvidencePath } from "../e2e/evidence-shots";

// Evidence PNGs in screenshots/ and evidence/ are opt-in (#1123): normal and
// CI runs neither spend capture time on them nor rewrite tracked files.
describe("isEvidencePath", () => {
  const root = "/repo";

  it("matches files under the tracked evidence directories, relative or absolute", () => {
    expect(isEvidencePath("evidence/ac-1.png", root, root)).toBe(true);
    expect(isEvidencePath("screenshots/fix/x/a.png", root, root)).toBe(true);
    expect(isEvidencePath("/repo/evidence/a.png", root, "/elsewhere")).toBe(true);
    expect(isEvidencePath("../evidence/a.png", root, "/repo/e2e")).toBe(true);
  });

  it("leaves test output and look-alike paths alone", () => {
    expect(isEvidencePath("test-results/a.png", root, root)).toBe(false);
    expect(isEvidencePath("/repo/test-results/x/evidence/a.png", root, root)).toBe(false);
    expect(isEvidencePath("evidence-old/a.png", root, root)).toBe(false);
    expect(isEvidencePath("/other/evidence/a.png", root, root)).toBe(false);
    expect(isEvidencePath("evidence", root, root)).toBe(false);
  });
});

describe("gateEvidence", () => {
  const shot = () => vi.fn(async (_options?: object) => Buffer.from("png"));

  it("skips an evidence write unless capture is on", async () => {
    const inner = shot();
    expect(await gateEvidence(inner, false)({ path: "evidence/a.png" })).toEqual(Buffer.alloc(0));
    expect(inner).not.toHaveBeenCalled();
    const capturing = shot();
    expect(await gateEvidence(capturing, true)({ path: "evidence/a.png" })).toEqual(Buffer.from("png"));
    expect(capturing).toHaveBeenCalledWith({ path: "evidence/a.png" });
  });

  it("captures without writing when the call finishes animations", async () => {
    const inner = shot();
    await gateEvidence(inner, false)({ path: "screenshots/a.png", animations: "disabled", fullPage: true });
    expect(inner).toHaveBeenCalledWith({ animations: "disabled", fullPage: true });
  });

  it("passes through pixel captures and test output untouched", async () => {
    const inner = shot();
    const gated = gateEvidence(inner, false);
    await gated();
    await gated({ scale: "css" });
    await gated({ path: "test-results/a.png" });
    expect(inner.mock.calls).toEqual([[undefined], [{ scale: "css" }], [{ path: "test-results/a.png" }]]);
  });

  it("keeps the receiver, as a prototype method needs", async () => {
    const owner = { name: "page", screenshot: gateEvidence(async function (this: { name: string }) { return Buffer.from(this.name); }, false) };
    expect(await owner.screenshot()).toEqual(Buffer.from("page"));
  });
});
