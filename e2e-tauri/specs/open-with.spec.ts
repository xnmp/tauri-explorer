import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryPathSelector, navigateTo } from "./helpers";

const profile = process.env.TAURI_NATIVE_OPEN_WITH_PROFILE;
const proof = "screenshots/fix/add-open-with-to-right-click-context-menu";
const enabled = process.platform === "linux" && profile !== undefined;
const content = "Exact alternate-application dispatch, unchanged source bytes.\n";
let source: string;
let viewerPid: number | undefined;

function ownedViewerEnvironment(pid: number): Record<string, string> {
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  if (!command.includes(path.resolve("e2e-tauri/fixtures/open-with-viewer.py")))
    throw new Error("Alternate viewer process is not the disposable fixture");
  const environment = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(value => value.includes("=")).map(value => {
    const index = value.indexOf("=");
    return [value.slice(0, index), value.slice(index + 1)];
  }));
  for (const key of ["DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME"])
    if (environment[key] !== process.env[key]) throw new Error(`Alternate viewer lost private ${key}`);
  if (environment.WAYLAND_DISPLAY) throw new Error("Alternate viewer retained host Wayland connection");
  return environment;
}

async function chooser() {
  await $(entryPathSelector(source)).click({ button: "right" });
  await $('.context-menu').$('button*=Open with').click();
  await $('.open-with-dialog').waitForDisplayed();
  await $('.open-with-dialog').$('button*=Acceptance Alternate Viewer').waitForDisplayed();
}

async function capture(name: string) {
  await browser.executeAsync(done => {
    const element = document.querySelector('.modal-overlay') ?? document.querySelector('.context-menu');
    Promise.all(element?.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})) ?? []).then(() => done());
  });
  await browser.saveScreenshot(`${proof}/${name}.png`);
}

(enabled ? describe : describe.skip)("native installed application choice (#822)", function () {
  this.bail(true);
  const receipt = process.env.TAURI_NATIVE_OPEN_WITH_RECEIPT!;
  let initialAssociation: string;
  before(async () => {
    if (!profile || process.env.XDG_DATA_HOME !== path.join(profile, "data") || process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND !== "x11" || !process.env.DISPLAY || !process.env.DBUS_SESSION_BUS_ADDRESS)
      throw new Error("Use the disposable private Xvfb/X11, D-Bus and XDG Open with profile");
    const directory = createNativeFixtureDirectory("open-with-");
    source = path.join(directory, "a space ü ' \" $(touch injected);.txt");
    fs.writeFileSync(source, content);
    fs.mkdirSync(proof, { recursive: true });
    initialAssociation = execFileSync("xdg-mime", ["query", "default", "text/plain"], { encoding: "utf8" }).trim();
    expect(initialAssociation).toBe("acceptance-default.desktop");
    await navigateTo(directory);
  });

  afterEach(() => {
    if (viewerPid !== undefined) {
      ownedViewerEnvironment(viewerPid);
      process.kill(viewerPid, "SIGTERM");
      viewerPid = undefined;
    }
    if (fs.existsSync(receipt)) fs.unlinkSync(receipt);
  });

  it("cancel preserves the exact selected source and launches no application", async () => {
    await chooser();
    await capture("linux-native-installed-chooser");
    await $('.open-with-dialog').$('button=Cancel').click();
    await $('.open-with-dialog').waitForExist({ reverse: true });
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe(content);
  });

  it("the alternate installed app receives the intact path and default association stays unchanged", async () => {
    await chooser();
    await $('.open-with-dialog').$('button*=Acceptance Alternate Viewer').click();
    await $('.open-with-dialog').waitForExist({ reverse: true });
    await browser.waitUntil(() => fs.existsSync(receipt), { timeoutMsg: "registered alternate application did not receive a file" });
    const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
    viewerPid = result.pid;
    const environment = ownedViewerEnvironment(result.pid);
    fs.writeFileSync("/tmp/issue17-822-viewer-isolation.json", JSON.stringify({ pid: result.pid, command: fs.readFileSync(`/proc/${result.pid}/cmdline`, "utf8").replaceAll("\0", " "), environment: Object.fromEntries(["DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].map(key => [key, environment[key]])) }, null, 2));
    expect(result.path).toBe(source);
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    for (const key of ["DISPLAY", "GDK_BACKEND", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME"])
      expect(result.environment[key]).toBe(process.env[key]);
    expect(result.environment.WAYLAND_DISPLAY).toBeNull();
    await browser.waitUntil(() => {
    const properties = execFileSync("xprop", ["-root", "_NET_CLIENT_LIST"], { encoding: "utf8" });
    const windows = (properties.match(/0x[0-9a-f]+/g) ?? []).map(id => execFileSync("xprop", ["-id", id, "_NET_WM_NAME", "_NET_WM_PID"], { encoding: "utf8" }));
    return windows.some(window => window.includes('"Acceptance Alternate Viewer"') && window.includes(`= ${result.pid}`));
    }, { timeoutMsg: "The installed alternate viewer did not display its actual window" });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-video_size", "1600x1000", "-i", process.env.DISPLAY!, "-frames:v", "1", "-y", `${proof}/linux-native-alternate-opened.png`]);
    expect(fs.readFileSync(source, "utf8")).toBe(content);
    expect(fs.existsSync(path.join(path.dirname(source), "injected"))).toBe(false);
    expect(execFileSync("xdg-mime", ["query", "default", "text/plain"], { encoding: "utf8" }).trim()).toBe(initialAssociation);

  });

  it("an admitted application with an invalid working directory reports launch failure", async () => {
    await chooser();
    await $('.open-with-dialog').$('button=Acceptance Broken Viewer').click();
    await $('.open-with-dialog [role="alert"]').waitForDisplayed();
    expect(await $('.open-with-dialog [role="alert"]').getText()).toMatch(/launch|execute|No such file/i);
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe(content);
    await capture("linux-native-launch-error");
    await $('.open-with-dialog').$('button=Cancel').click();
  });

  it("a deleted selected file returns an error and launches no application", async () => {
    await chooser();
    fs.unlinkSync(source);
    await $('.open-with-dialog').$('button*=Acceptance Alternate Viewer').click();
    await $('.open-with-dialog [role="alert"]').waitForDisplayed();
    expect(await $('.open-with-dialog [role="alert"]').getText()).toContain("not found");
    expect(fs.existsSync(receipt)).toBe(false);
    await capture("linux-native-deleted-file-error");
    await $('.open-with-dialog').$('button=Cancel').click();
  });
});
