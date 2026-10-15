import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", () => child);

// Exercise the independent OS probe used by the real cross-window smoke spec.
import { readNativeClipboardPaths, writeExternalClipboardCopy } from "../../e2e-tauri/native-clipboard";

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  // The old synchronous ten-second probe cannot complete a cold shell.
  child.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error("spawnSync powershell ETIMEDOUT"), { code: "ETIMEDOUT" });
  });
});
afterEach(() => vi.useRealTimers());

describe("Windows independent clipboard probe", () => {
  it("awaits a cold shell taking longer than ten seconds and preserves Unicode paths", async () => {
    const paths = ["C:\\Users\\runner\\資料\\latest.txt"];
    child.execFile.mockImplementation((_file, _args, _options, callback) => {
      setTimeout(() => callback(null, JSON.stringify(paths), ""), 12_000);
    });
    let settled = false;
    const reading = readNativeClipboardPaths("win32").then(value => { settled = true; return value; });
    void reading.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(await reading).toEqual(paths);
    expect(child.execFile).toHaveBeenCalledTimes(1);
    const [file, args, options, callback] = child.execFile.mock.calls[0];
    expect(file).toBe("powershell");
    expect(args).toEqual(expect.arrayContaining([
      "-NoProfile", "-NonInteractive", "-STA",
      expect.stringContaining("DragQueryFileW"),
    ]));
    expect(options.timeout).toBe(30_000);
    expect(options.encoding).toBe("utf8");
    expect(callback).toBeTypeOf("function");
    expect(child.execFileSync).not.toHaveBeenCalled();
  });

  it("reads the eager CF_HDROP payload without invoking the stalled Shell clipboard cmdlet", async () => {
    const paths = ["C:\\資料\\one.txt", "C:\\資料\\two.txt"];
    child.execFile.mockImplementation((_file, args, _options, callback) => {
      const script = args.at(-1) as string;
      // The failing native run reached PowerShell but never returned from
      // Get-Clipboard. Fail that command rather than accepting a new timeout.
      if (/\bGet-Clipboard\b/.test(script)) {
        callback(new Error("Shell clipboard cmdlet stalled"), "", "PowerShell ready");
      } else {
        callback(null, JSON.stringify(paths), "");
      }
    });
    await expect(readNativeClipboardPaths("win32")).resolves.toEqual(paths);
    const script = child.execFile.mock.calls[0][1].at(-1) as string;
    expect(script).toContain("OpenClipboard");
    expect(script).toContain("GetClipboardData(15)");
    expect(script).toContain("DragQueryFileW");
    expect(script).toMatch(/finally\s*\{\s*CloseClipboard\(\)/);
    expect(child.execFile).toHaveBeenCalledTimes(1);
  });

  it("fails once with serializable timeout diagnostics instead of WDIO's circular JSON error", async () => {
    const failure = Object.assign(new Error("spawn powershell ETIMEDOUT"), {
      code: "ETIMEDOUT", signal: "SIGTERM", error: null as unknown,
    });
    failure.error = failure;
    child.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(failure, "partial output", "clipboard probe stderr");
    });
    const error = await readNativeClipboardPaths("win32").catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("read Windows file clipboard");
    expect(error.message).toContain("ETIMEDOUT");
    expect(error.message).toContain("SIGTERM");
    expect(error.message).toContain("partial output");
    expect(error.message).toContain("clipboard probe stderr");
    expect(() => JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toThrow();
    expect(child.execFile).toHaveBeenCalledTimes(1);
  });

  it("does not turn empty or malformed probe output into a successful selection", async () => {
    child.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "[]", ""));
    expect(await readNativeClipboardPaths("win32")).toEqual([]);
    child.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "not JSON", ""));
    await expect(readNativeClipboardPaths("win32")).rejects.toThrow();
    for (const output of ["null", '{}', '[3]']) {
      child.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, output, ""));
      await expect(readNativeClipboardPaths("win32")).rejects.toThrow("array of paths");
    }
  });

  it("awaits external Copy and sends the literal path through the environment", async () => {
    let finish!: () => void;
    child.execFile.mockImplementation((_file, _args, _options, callback) => { finish = () => callback(null, "", ""); });
    const writing = writeExternalClipboardCopy("C:\\a'$literal.txt", "win32");
    void writing.catch(() => {});
    expect(child.execFile).toHaveBeenCalledWith("powershell", expect.arrayContaining([
      expect.stringContaining("Set-Clipboard -LiteralPath $env:CLIP_PATH"),
    ]), expect.objectContaining({ env: expect.objectContaining({ CLIP_PATH: "C:\\a'$literal.txt" }) }), expect.any(Function));
    finish();
    await writing;
  });
});

it("retains X11 URI decoding and ignores comment lines", async () => {
  child.execFileSync.mockReturnValue("# files\r\nfile:///tmp/a%20b.txt\r\n");
  expect(await readNativeClipboardPaths("linux")).toEqual(["/tmp/a b.txt"]);
});
