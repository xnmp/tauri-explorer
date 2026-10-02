import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryPathSelector, navigateTo } from "./helpers";

// The profile controls both D-Bus service availability and installed desktop
// entries. Ordinary suite runs must not exercise the user's external desktop.
const scenario = process.env.TAURI_NATIVE_TRASH_SCENARIO;
const scenarios = ["native", "fallback", "missing", "failed"];
if (scenario !== undefined && !scenarios.includes(scenario))
  throw new Error(`Unknown native Trash scenario: ${scenario}`);
const enabled = process.platform === "linux" && scenario !== undefined;
const proof = "screenshots/test/trash-broken-in-arch";

function windows() {
  const root = execFileSync("xprop", ["-root", "_NET_CLIENT_LIST"], { encoding: "utf8" });
  return (root.match(/0x[0-9a-f]+/g) ?? []).map(id => ({
    id, properties: execFileSync("xprop", ["-id", id, "WM_CLASS", "_NET_WM_PID", "_NET_WM_NAME"], { encoding: "utf8" }),
  }));
}

function assertHelperIsolation(properties: string) {
  const pid = properties.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/)?.[1];
  if (!pid) throw new Error("External file manager has no process identity");
  const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
  for (const key of ["DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"])
    expect(environment).toContain(`${key}=${process.env[key]}`);
  expect(environment.some(entry => entry.startsWith("WAYLAND_DISPLAY="))).toBe(false);
}

function privateTrashCount(): number {
  return JSON.parse(execFileSync("python3", ["e2e-tauri/fixtures/trash-accessibility.py", "--trash-count"], { encoding: "utf8", timeout: 5000 }));
}

function visibleNames(): string[] {
  return JSON.parse(execFileSync("python3", ["e2e-tauri/fixtures/trash-accessibility.py"], { encoding: "utf8", timeout: 5000 }));
}

(enabled ? describe : describe.skip)("Arch graphical Trash acceptance (#723, #733)", function () {
  this.bail(true);
  let directory: string;
  let original: string;
  let payload: string;
  const name = "acceptance-723-733-disposable.txt";
  const bytes = "disposable Trash acceptance bytes\n";

  before(async () => {
    if (!process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND !== "x11" || !process.env.DBUS_SESSION_BUS_ADDRESS || !process.env.XDG_DATA_HOME?.includes("issue17-native-profile/trash/"))
      throw new Error("Trash acceptance requires its private display, D-Bus and controlled XDG profile");
    expect(execFileSync("xdg-mime", ["query", "default", "inode/directory"], { encoding: "utf8" }).trim()).toBe("kitty-open.desktop");
    directory = createNativeFixtureDirectory("trash-acceptance-");
    original = path.join(directory, name);
    const trashFiles = path.join(process.env.XDG_DATA_HOME!, "Trash", "files");
    fs.writeFileSync(original, bytes);
    await navigateTo(directory);
    // Exercise the existing production Move to Trash before checking opener.
    await browser.execute(entryPath => window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: { op: "delete", path: entryPath } })), original);
    await browser.waitUntil(() => !fs.existsSync(original) && fs.existsSync(trashFiles) && fs.readdirSync(trashFiles).some(entry => entry.startsWith(name)), { timeout: 25_000, timeoutMsg: "real Move to Trash did not produce the disposable payload" });
    const saved = fs.readdirSync(trashFiles).filter(entry => entry.startsWith(name));
    expect(saved).toHaveLength(1);
    payload = path.join(trashFiles, saved[0]);
    await $(entryPathSelector(original)).waitForExist({ reverse: true });
    expect(fs.readFileSync(payload, "utf8")).toBe(bytes);
    fs.mkdirSync(proof, { recursive: true });
  });

  after(() => {
    if (!payload) return;
    // Failure and unavailable-opener cases also clean only the known fixture.
    fs.rmSync(payload, { force: true });
    fs.rmSync(path.join(process.env.XDG_DATA_HOME!, "Trash", "info", `${path.basename(payload)}.trashinfo`), { force: true });
  });

  it(`${scenario}: chooses a graphical surface or reports unavailable without mutating files`, async () => {
    await $('button[aria-label="Open Recycle Bin"]').click();
    if (scenario === "missing" || scenario === "failed") {
      const error = $('.toast.error');
      await error.waitForDisplayed();
      const message = await error.getText();
      expect(message).toContain("No graphical file manager could open Recycle Bin");
      if (scenario === "failed") {
        expect(message).toContain("thunar.desktop:");
        expect(message).toMatch(/execute|No such file|Failed/i);
      }
      expect(windows().some(window => /Thunar|kitty/i.test(window.properties))).toBe(false);
      await browser.saveScreenshot(`${proof}/${scenario}-actionable-error.png`);
    } else {
      const expectedTitle = scenario === "native" ? '"Trash - Thunar"' : '"files - Thunar"';
      await browser.waitUntil(() => windows().some(window => /Thunar/.test(window.properties) && window.properties.includes(expectedTitle)), { timeoutMsg: `No actual Thunar window reached ${expectedTitle}` });
      const window = windows().find(window => /Thunar/.test(window.properties) && window.properties.includes(expectedTitle))!;
      assertHelperIsolation(window.properties);
      expect(window.properties).toContain(scenario === "native" ? '"Trash - Thunar"' : '"files - Thunar"');
      execFileSync("python3", ["e2e-tauri/fixtures/trash-accessibility.py", "--list-view"], { encoding: "utf8", timeout: 5000 });
      await browser.waitUntil(() => visibleNames().some(value => value.includes(name)), { timeoutMsg: "Disposable trashed file is absent from the graphical file manager accessibility tree" });
      expect(windows().some(window => /kitty/i.test(window.properties))).toBe(false);
      expect(privateTrashCount()).toBe(1);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1600x1000", "-i", process.env.DISPLAY!, "-frames:v", "1", "-y", `${proof}/${scenario}-graphical-disposable.png`]);
    }
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(payload, "utf8")).toBe(bytes);
    expect(await $('.status-path').getAttribute("title")).toBe(directory);
  });

  it(`${scenario}: empty Trash opens without an unknown-URI error`, async function () {
    if (scenario !== "native" && scenario !== "fallback") { this.skip(); return; }
    const previousWindowIds = new Set(windows().map(window => window.id));
    // Remove only this disposable profile's known payload and metadata.
    fs.unlinkSync(payload);
    fs.unlinkSync(path.join(process.env.XDG_DATA_HOME!, "Trash", "info", `${path.basename(payload)}.trashinfo`));
    // A previously launched Thunar may now own its native D-Bus service.
    // Verify the empty user-visible result and both Trash source counts.
    await $('button[aria-label="Open Recycle Bin"]').click();
    await browser.waitUntil(() => windows().some(window => !previousWindowIds.has(window.id) && /Thunar/.test(window.properties) && /"(?:Trash|files) - Thunar"/.test(window.properties)), { timeoutMsg: "Empty Trash action did not open a new graphical window" });
    const reopened = windows().find(window => !previousWindowIds.has(window.id) && /Thunar/.test(window.properties))!;
    assertHelperIsolation(reopened.properties);
    await browser.waitUntil(() => !visibleNames().some(value => value.includes(name)), { timeoutMsg: "Graphical Trash did not observe removal of the disposable fixture" });
    expect(windows().some(window => /Thunar/.test(window.properties))).toBe(true);
    expect(await $('.toast.error').isExisting()).toBe(false);
    expect(await $('.status-path').getAttribute("title")).toBe(directory);
    expect(privateTrashCount()).toBe(0);
    expect(fs.readdirSync(path.dirname(payload))).toHaveLength(0);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1600x1000", "-i", process.env.DISPLAY!, "-frames:v", "1", "-y", `${proof}/${scenario}-graphical-empty.png`]);
  });
});
