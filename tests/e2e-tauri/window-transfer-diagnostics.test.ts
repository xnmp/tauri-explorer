import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let waits: typeof import("../../e2e-tauri/window-transfer-waits");

const driver = vi.hoisted(() => ({
  execute: vi.fn(), executeAsync: vi.fn(), getWindowHandle: vi.fn(),
  getWindowHandles: vi.fn(), switchToWindow: vi.fn(), saveScreenshot: vi.fn(),
  waitUntil: vi.fn(),
}));
const files = vi.hoisted(() => ({
  mkdtempSync: vi.fn(() => "transfer-fixture"), mkdirSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser: driver, $: vi.fn() }));
vi.mock("expect-webdriverio", async () => ({ expect: (await import("vitest")).expect }));
vi.mock("node:fs", () => ({ default: files }));
vi.mock("../../e2e-tauri/specs/helpers", () => ({ navigateTo: vi.fn(), domTexts: vi.fn() }));

const cases = new Map<string, () => Promise<void>>();
let currentWindow: string;
const screenshots: string[] = [];

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  cases.clear();
  screenshots.length = 0;
  currentWindow = "main";
  files.mkdtempSync.mockReturnValue("transfer-fixture");
  driver.getWindowHandle.mockImplementation(async () => currentWindow);
  driver.getWindowHandles.mockResolvedValue(["main", "child1", "child2"]);
  driver.switchToWindow.mockImplementation(async (handle: string) => { currentWindow = handle; });
  driver.execute.mockImplementation(async (_script, ...args) => args.length === 2
    ? { handle: currentWindow, reason: args[1] } : currentWindow);
  driver.saveScreenshot.mockImplementation(async () => { screenshots.push(currentWindow); });
  driver.waitUntil.mockImplementation(async (predicate) => {
    if (!await predicate()) throw new Error("test window was not found");
  });
  vi.stubGlobal("describe", (_name: string, register: () => void) => register.call({ bail: vi.fn() }));
  vi.stubGlobal("it", (name: string, run: () => Promise<void>) => cases.set(name, run));
  vi.stubGlobal("before", vi.fn());
  vi.stubGlobal("after", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => {});
  waits = await import("../../e2e-tauri/window-transfer-waits");
  await import("../../e2e-tauri/specs/window-transfer-lifetime.spec");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function firstNativeCase(): Promise<void> {
  const run = cases.get("concurrent same-path children each become functional and keep independent navigation");
  if (!run) throw new Error("native transfer case was not registered");
  return run();
}

describe("native transfer failure artifacts at the spec call sites", () => {
  it("retains JSON and the source screenshot when an operation times out", async () => {
    driver.executeAsync.mockResolvedValue({ ok: false, error: "native open-pair did not finish" });
    await expect(firstNativeCase()).rejects.toThrow("native open-pair did not finish");

    expect(driver.executeAsync).toHaveBeenCalledExactlyOnceWith(waits.waitForWindowOperation,
      expect.objectContaining({ op: "open-pair", token: expect.any(String) }));
    expect(files.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("window-transfer-operation-open-pair.json"), expect.any(String));
    const artifact = JSON.parse(files.writeFileSync.mock.calls[0][1]);
    expect(artifact).toMatchObject({ reason: "operation-open-pair", platform: process.platform });
    expect(artifact.windows.map((entry: { handle: string }) => entry.handle))
      .toEqual(["main", "child1", "child2"]);
    expect(screenshots).toEqual(["main"]);
    expect(currentWindow).toBe("main");
  });

  it("captures the failed listing window before inspecting unrelated windows", async () => {
    driver.executeAsync.mockResolvedValueOnce({ ok: true, value: { result: ["child1", "child2"] } })
      .mockResolvedValueOnce({ ok: false, error: "native listing did not contain source.txt" });
    await expect(firstNativeCase()).rejects.toThrow("native listing did not contain source.txt");

    expect(driver.executeAsync).toHaveBeenNthCalledWith(2, waits.waitForListingEntry,
      expect.objectContaining({ name: "source.txt" }));
    expect(files.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("window-transfer-listing-source-txt.json"), expect.any(String));
    expect(screenshots).toEqual(["child1"]);
    expect(currentWindow).toBe("child1");
  });
});
