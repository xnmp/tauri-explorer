/** #703: the fresh-window helper must retain evidence across a lost session. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({
  getWindowHandles: vi.fn(),
  switchToWindow: vi.fn(),
  execute: vi.fn(),
  waitUntil: vi.fn(),
}));
const element = vi.hoisted(() => ({ waitForExist: vi.fn() }));
vi.mock("@wdio/globals", () => ({
  browser: driver,
  $: vi.fn(() => element),
  $$: vi.fn(),
}));

const diagnosticsDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "fresh-window-capture-"),
);
process.env.TAURI_NATIVE_DIAGNOSTICS_DIR = diagnosticsDirectory;

const helpers = await import("../../e2e-tauri/specs/helpers");
const { switchToFreshWindow, waitForFreshWindowElement } = helpers;

afterAll(() => {
  fs.rmSync(diagnosticsDirectory, { recursive: true, force: true });
  delete process.env.TAURI_NATIVE_DIAGNOSTICS_DIR;
});

type Record_ = {
  phase: string;
  requestedLabel: string;
  handle: string;
  pageAtSelection: { statusPath?: string; fileListCount?: number } | { error: string };
  lookup?: { selector: string; error: string };
  nativeAfterFailure?: { webkit: unknown[] };
};

function records(): Record_[] {
  return fs.readdirSync(diagnosticsDirectory)
    .map((name) => JSON.parse(
      fs.readFileSync(path.join(diagnosticsDirectory, name), "utf8"),
    ) as Record_);
}

const page = {
  capturedAt: 1,
  label: "explorer-child",
  hooksReady: true,
  fileListCount: 1,
  entryCount: 3,
  statusPath: "/tmp/child-1",
  url: "tauri://localhost/",
  readyState: "complete",
  visibility: "visible",
};

function selectFreshWindow(snapshot: unknown = page): Promise<string> {
  driver.getWindowHandles.mockResolvedValue(["main", "child"]);
  let reads = 0;
  driver.execute.mockImplementation(async () =>
    ++reads === 1 ? "explorer-child" : snapshot);
  return switchToFreshWindow("explorer-child", ["main"]);
}

describe("fresh window evidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const name of fs.readdirSync(diagnosticsDirectory)) {
      fs.rmSync(path.join(diagnosticsDirectory, name));
    }
    driver.waitUntil.mockImplementation(async (ready: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 3; attempt += 1) if (await ready()) return;
      throw new Error("window did not become ready");
    });
  });

  it("records the selected window's rendered state before any element lookup", async () => {
    await expect(selectFreshWindow()).resolves.toBe("child");

    const [record] = records();
    expect(record.phase).toBe("selected");
    expect(record.requestedLabel).toBe("explorer-child");
    expect(record.handle).toBe("child");
    expect(record.pageAtSelection).toMatchObject({
      statusPath: "/tmp/child-1",
      fileListCount: 1,
    });
  });

  it("retains that evidence when the first lookup loses the session", async () => {
    await selectFreshWindow();
    const executesBeforeLookup = driver.execute.mock.calls.length;
    element.waitForExist.mockRejectedValue(
      new Error("invalid session id when running \"element\" with method \"POST\""),
    );

    await expect(waitForFreshWindowElement(".file-list", 20_000))
      .rejects.toThrow("invalid session id");

    const failure = records().find((record) => record.phase === "lookup-failed");
    expect(failure?.lookup).toMatchObject({ selector: ".file-list" });
    expect(failure?.lookup?.error).toContain("invalid session id");
    expect(failure?.pageAtSelection).toMatchObject({ statusPath: "/tmp/child-1" });
    expect(Array.isArray(failure?.nativeAfterFailure?.webkit)).toBe(true);
    // A dead session cannot answer another WebDriver command.
    expect(driver.execute.mock.calls.length).toBe(executesBeforeLookup);
  });

  it("does not fail a lookup that succeeds", async () => {
    await selectFreshWindow();
    element.waitForExist.mockResolvedValue(true);

    await expect(waitForFreshWindowElement(".file-list", 20_000)).resolves.toBeUndefined();
    expect(records().every((record) => record.phase === "selected")).toBe(true);
  });

  it("still selects the window when the renderer cannot answer the capture", async () => {
    driver.getWindowHandles.mockResolvedValue(["main", "child"]);
    let reads = 0;
    driver.execute.mockImplementation(async () => {
      if (++reads === 1) return "explorer-child";
      throw new Error("script timed out");
    });

    await expect(switchToFreshWindow("explorer-child", ["main"])).resolves.toBe("child");
    expect(records()[0].pageAtSelection).toEqual({
      error: expect.stringContaining("script timed out"),
    });
  });
});
