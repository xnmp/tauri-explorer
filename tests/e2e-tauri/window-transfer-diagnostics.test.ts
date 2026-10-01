/// <reference types="mocha" />
/** #710: native transfer failures retain partial JSON and the failing window screenshot.
 *
 * Retire-when: #710 closed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let waits: typeof import("../../e2e-tauri/window-transfer-waits");

const driver = vi.hoisted(() => ({
  execute: vi.fn(), executeAsync: vi.fn(), getWindowHandle: vi.fn(),
  getWindowHandles: vi.fn(), switchToWindow: vi.fn(), saveScreenshot: vi.fn(),
  getUrl: vi.fn(), waitUntil: vi.fn(),
}));
const files = vi.hoisted(() => ({
  mkdtempSync: vi.fn(() => "transfer-fixture"), mkdirSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock("@wdio/globals", () => ({ browser: driver, $: vi.fn() }));
vi.mock("expect-webdriverio", async () => ({ expect: (await import("vitest")).expect }));
vi.mock("node:fs", () => ({ default: files }));
vi.mock("../../e2e-tauri/specs/helpers", () => ({
  navigateTo: vi.fn(), domTexts: vi.fn(), closeOtherWindows: vi.fn(),
  // Fixture handles are named after their labels.
  switchToWindowLabel: async (label: string) => { await driver.switchToWindow(label); return label; },
}));

const cases = new Map<string, () => Promise<void>>();
let currentWindow: string;
const screenshots: string[] = [];

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.stubEnv("TAURI_NATIVE_CLEANUP_STATE_DIRECTORY", "transfer-fixture-owner");
  cases.clear();
  screenshots.length = 0;
  currentWindow = "main";
  files.mkdtempSync.mockReturnValue("transfer-fixture");
  driver.getWindowHandle.mockImplementation(async () => currentWindow);
  driver.getWindowHandles.mockResolvedValue(["main", "child1", "child2"]);
  driver.switchToWindow.mockImplementation(async (handle: string) => { currentWindow = handle; });
  driver.getUrl.mockImplementation(async () => currentWindow === "warm"
    ? "tauri://localhost/?warm=1&path=%2Fhome" : "tauri://localhost/");
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function firstNativeCase(): Promise<void> {
  const run = cases.get("concurrent same-path children each become functional and keep independent navigation");
  if (!run) throw new Error("native transfer case was not registered");
  return run();
}

describe("native transfer failure artifacts at the spec call sites", () => {
  it("retains JSON and the source screenshot when an operation times out", async () => {
    driver.executeAsync.mockResolvedValue({ ok: false, reason: "native open-pair did not finish" });
    await expect(firstNativeCase()).rejects.toThrow("native open-pair did not finish");

    expect(driver.executeAsync).toHaveBeenCalledExactlyOnceWith(waits.waitForWindowOperation,
      expect.objectContaining({ op: "open-pair", token: expect.any(String) }));
    expect(files.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("window-transfer-operation-open-pair.json"), expect.any(String));
    const artifact = JSON.parse(files.writeFileSync.mock.calls.at(-1)![1]);
    expect(artifact).toMatchObject({ reason: "operation-open-pair", platform: process.platform });
    expect(artifact.windows.map((entry: { handle: string }) => entry.handle))
      .toEqual(["main", "child1", "child2"]);
    expect(screenshots).toEqual(["main"]);
    expect(currentWindow).toBe("main");
  });

  it("captures the failed listing window before inspecting unrelated windows", async () => {
    driver.executeAsync.mockResolvedValueOnce({ ok: true, value: { result: ["child1", "child2"] } })
      .mockResolvedValueOnce({ ok: false, reason: "native listing did not contain source.txt" });
    await expect(firstNativeCase()).rejects.toThrow("native listing did not contain source.txt");

    expect(driver.executeAsync).toHaveBeenNthCalledWith(2, waits.waitForListingEntry,
      expect.objectContaining({ name: "source.txt" }));
    expect(files.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("window-transfer-listing-source-txt.json"), expect.any(String));
    expect(screenshots).toEqual(["child1"]);
    expect(currentWindow).toBe("child1");
  });

  it("records a warm window by URL without running script in it (#931)", async () => {
    driver.executeAsync.mockResolvedValue({ ok: false, reason: "native open-pair did not finish" });
    driver.getWindowHandles.mockResolvedValue(["main", "warm", "child1"]);
    const scripted: string[] = [];
    driver.execute.mockImplementation(async (_script, ...args) => {
      scripted.push(currentWindow);
      if (currentWindow === "warm") throw new Error("session deleted because of page crash or hang");
      return args.length === 2 ? { handle: currentWindow, reason: args[1] } : currentWindow;
    });

    await expect(firstNativeCase()).rejects.toThrow("native open-pair did not finish");
    expect(scripted).not.toContain("warm");
    const artifact = JSON.parse(files.writeFileSync.mock.calls.at(-1)![1]);
    expect(artifact.windows).toEqual([
      expect.objectContaining({ handle: "main" }),
      expect.objectContaining({ handle: "warm", url: expect.stringContaining("warm=1"), skipped: expect.any(String) }),
      expect.objectContaining({ handle: "child1" }),
    ]);
  });

  it("retains the original failure and partial diagnostics when the driver loses its session", async () => {
    driver.executeAsync.mockResolvedValue({ ok: false, reason: "native open-pair did not finish" });
    driver.getWindowHandles.mockRejectedValue(new Error("session lost"));
    driver.saveScreenshot.mockRejectedValue(new Error("screenshot session lost"));

    await expect(firstNativeCase()).rejects.toThrow("native open-pair did not finish");
    const artifact = JSON.parse(files.writeFileSync.mock.calls.at(-1)![1]);
    expect(artifact.reason).toBe("operation-open-pair");
    expect(artifact.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ screenshotError: "Error: screenshot session lost" }),
      expect.objectContaining({ captureError: "Error: session lost" }),
    ]));
  });
});
