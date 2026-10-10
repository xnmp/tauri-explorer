/** Native working-snapshot acceptance; never a clean-release qualification.
 * Run only through run-shared-ai-services.sh with private Xvfb/D-Bus/XDG.
 * Paid providers/keys are forbidden; generation is explicitly gated separately.
 */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { gatedDescribe } from "./gated-describe";
import { domText, entryPathSelector, navigateTo } from "./helpers";

const directory = process.env.SHARED_AI_NATIVE_FIXTURE;
const present = process.env.SHARED_AI_NATIVE_PROVIDER === "present";
const generate = process.env.SHARED_AI_NATIVE_GENERATE === "1";
const png = fs.readFileSync(fileURLToPath(new URL("../fixtures/image-crop/quadrants.png", import.meta.url)));
const evidence = path.resolve("evidence/shared-ai-native");
let server: Server | undefined;
let endpoint = "";
let releaseResponse: (() => void) | null = null;
const requests: { path: string; headers: Record<string, unknown>; body: unknown }[] = [];
async function invoke(command: string, params: Record<string, unknown> = {}): Promise<any> {
  const result = await browser.executeAsync((cmd: string, args: Record<string, unknown>, done: (value: unknown) => void) => {
    const native = (window as any).__TAURI_INTERNALS__;
    native.invoke(cmd, args).then((value: unknown) => done({ ok: true, value }), (error: unknown) => done({ ok: false, failure: typeof error === "string" ? error : JSON.stringify(error) }));
  }, command, params) as { ok: boolean; value?: unknown; failure?: string };
  if (!result.ok) throw new Error(result.failure);
  return result.value;
}
const backend = (packageId: string, method: string, params: Record<string, unknown> = {}) => invoke("plugin_backend_invoke", { packageId, method, params });
async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const search = $(".command-palette-dialog .search-input");
  await search.waitForDisplayed(); await search.setValue(label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label));
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}
async function screenshot(name: string): Promise<void> {
  fs.mkdirSync(evidence, { recursive: true });
  await browser.saveScreenshot(path.join(evidence, `${present ? "present" : "absent"}-${name}.png`));
}
async function field(label: string, value: string): Promise<void> {
  await $(".connections").$(`label*=${label}`).$("input").setValue(value);
}
async function addConnection(name: string): Promise<string> {
  await $("button=Add Images API").click();
  await field("Name", name);
  await field("Images resource URL", endpoint);
  await field("Image model ID", "fixture/native-image-v1");
  await $(".connections").$("label*=Credential source").$("select").selectByAttribute("value", "none");
  const id = await $(".connections").$("label*=Edit connection").$("select").getValue();
  await $(".connections").$("label*=Default image connection").$("select").selectByAttribute("value", id);
  await $("button=Save connections").click();
  await browser.waitUntil(async () => !(await $("button=Save connections").isEnabled()), { timeoutMsg: "native connection save never committed" });
  return id;
}
function privateProcesses(): unknown[] {
  const profile = process.env.XDG_CONFIG_HOME!;
  return fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).flatMap(pid => {
    try {
      const exe = fs.readlinkSync(`/proc/${pid}/exe`);
      if (!/tauri-explorer$|WebKitWebProcess$|WebKitNetworkProcess$|WebKitWebDriver$|tauri-driver$|image-generation-backend$|trace-explorer-backend$/.test(exe)) return [];
      const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").map(v => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)]; }));
      if (env.XDG_CONFIG_HOME !== profile) return [];
      if (env.DISPLAY !== process.env.DISPLAY || env.GDK_BACKEND !== "x11" || env.WAYLAND_DISPLAY || env.DBUS_SESSION_BUS_ADDRESS !== process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error(`Process ${pid} escaped its private display/session`);
      return [{ pid, exe, display: env.DISPLAY, config: env.XDG_CONFIG_HOME, privateBus: true }];
    } catch (error) { if (String(error).includes("escaped")) throw error; return []; }
  });
}

gatedDescribe("shared AI native working snapshot", [[process.platform === "linux", "Linux private display"], [!!directory, "SHARED_AI_NATIVE_FIXTURE private profile"], [process.env.SHARED_AI_NATIVE_ACCEPTANCE === "1", "SHARED_AI_NATIVE_ACCEPTANCE=1"]], () => {
  const scratch = directory!;
  const source = path.join(scratch, "source.png");
  let connectionA = "";
  let startupReady = false;
  let settingsReady = false;
  before(async () => {
    fs.mkdirSync(scratch, { recursive: true }); fs.writeFileSync(source, png);
    fs.writeFileSync(path.join(scratch, "notes.txt"), "Native shared AI fixture\n");
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      requests.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(bytes.toString()) });
      if (generate) await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { releaseResponse = null; resolve(); }, 20_000);
        releaseResponse = () => { clearTimeout(timeout); releaseResponse = null; resolve(); };
      });
      response.writeHead(200, { "Content-Type": "application/json", "x-request-id": "native-fake-request" });
      response.end(JSON.stringify({ model: "fixture/actual-image-v1", data: [{ b64_json: png.toString("base64") }] }));
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture/images`;
  });
  after(async () => {
    releaseResponse?.();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, `${present ? "present" : "absent"}-outcomes.json`), JSON.stringify({ qualification: "dirty-working-snapshot", privateProcesses: privateProcesses(), requests, providerPresent: present, generationEnabled: generate }, null, 2));
  });
  it("cold starts installed SDK3 packages with shipped CSP and styles in the private process tree", async () => {
    await browser.waitUntil(async () => {
      const entries = await invoke("list_installed_plugins");
      return entries.some((e: any) => e.manifest.id === "xnmp.trace-explorer" && e.enabled)
        && (!present || entries.some((e: any) => e.manifest.id === "xnmp.image-generation" && e.enabled));
    }, { timeout: 45_000, timeoutMsg: "queued SDK3 packages were not installed" });
    const entries = await invoke("list_installed_plugins");
    expect(entries.find((e: any) => e.manifest.id === "xnmp.trace-explorer").manifest.sdkVersion).toBe(3);
    expect(entries.some((e: any) => e.manifest.id === "xnmp.image-generation")).toBe(present);
    await navigateTo(scratch);
    await $(entryPathSelector(source)).click();
    // Trace is intentionally unavailable in folders with no provenance. A
    // real core crop creates that provenance without any provider request.
    if (!await $(".preview-pane").isDisplayed()) {
      await browser.keys(" "); await $(".preview-pane").waitForDisplayed();
    }
    await command("Crop Image…");
    await $('[role="slider"][aria-label="Right crop edge"]').waitForDisplayed();
    await $("button=Save copy").click();
    await $('[role="dialog"][aria-label="Edit image"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => fs.readdirSync(scratch).filter(name => name.endsWith(".png")).length === 2,
      { timeoutMsg: "core crop provenance fixture never published" });
    await command("Toggle Trace View");
    await $('[data-file-view="trace.view"]').waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll("path[data-route]").length)) >= 1,
      { timeoutMsg: "native Trace did not show the core crop provenance edge" });
    const strokes = await browser.execute(() => [...document.querySelectorAll<SVGPathElement>("path[data-route]")].map(route => getComputedStyle(route).stroke));
    expect(strokes).not.toContain("none");
    const styled = await browser.execute(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(link => link.href.includes("plugin") && link.sheet !== null).length);
    expect(styled).toBe(present ? 2 : 1);
    const rows = privateProcesses() as { exe: string }[];
    expect(rows.some(row => row.exe.endsWith("tauri-explorer"))).toBe(true);
    expect(rows.some(row => row.exe.endsWith("WebKitWebProcess"))).toBe(true);
    const available = await backend("xnmp.trace-explorer", "image_service_describe");
    expect(available.available).toBe(present);
    if (!present) expect(available.reason.message).toMatch(/install|missing|enable/i);
    await screenshot("cold-trace");
    await command("Toggle Trace View");
    await $(entryPathSelector(source)).waitForDisplayed();
    startupReady = true;
  });
  it("keeps Trace available and refuses generation when the optional provider is absent", async function () {
    if (present) this.skip();
    await $(entryPathSelector(source)).click();
    await command("OpenAI: Generate Image…");
    await $("textarea").setValue("No optional provider must never dispatch");
    expect(await $("button=Generate").isEnabled()).toBe(false);
    expect(await domText(".plugin-dialog")).toMatch(/install|missing|enable/i);
    expect(requests.length).toBe(0);
    await screenshot("absent-provider-refusal");
    await browser.keys("Escape");
    await $(".plugin-dialog").waitForDisplayed({ reverse: true });
  });
  it("owns settings navigation, dirty close veto, caller draft and pinned default without any generation", async function () {
    if (!present) this.skip();
    expect(startupReady).toBe(true);
    await $(entryPathSelector(source)).click();
    await command("OpenAI: Generate Image…");
    await $("textarea").setValue("Keep the native caller draft");
    await $("button=Configure connections").click();
    await $(".connections").waitForDisplayed();
    connectionA = await addConnection("Native connection A");
    await $(".connections").$("button=Close").click();
    await $(".connections").waitForDisplayed({ reverse: true });
    await $('[aria-label="Image connection"]').selectByAttribute("value", connectionA);
    await $("button=Configure connections").click();
    await $(".connections").waitForDisplayed();
    await addConnection("Native connection B");
    await field("Name", "Unsaved child draft");
    await browser.keys("Escape");
    await $("button=Discard edits and close").waitForDisplayed();
    expect(await $(".connections").isDisplayed()).toBe(true);
    expect(await $(".connections").$("label*=Name").$("input").getValue()).toBe("Unsaved child draft");
    await screenshot("dirty-child-veto");
    await $("button=Discard edits and close").click();
    await $(".connections").waitForDisplayed({ reverse: true });
    expect(await $("textarea").getValue()).toBe("Keep the native caller draft");
    expect(await $('[aria-label="Image connection"]').getValue()).toBe(connectionA);
    expect(await browser.execute(() => document.activeElement?.textContent)).toContain("Configure connections");
    expect(requests.length).toBe(0);
    const saved = await backend("xnmp.image-generation", "settings.read");
    expect(saved.profiles.length).toBe(2);
    expect(saved.defaultConnectionId).not.toBe(connectionA);
    expect(saved.profiles.every((p: any) => p.credential.kind === "none")).toBe(true);
    await screenshot("caller-draft-returned");
    settingsReady = true;
  });
  if (generate) it("publishes one exact local fake PNG into Trace with provenance and acquired provider receipt", async () => {
    if (!present) throw new Error("Generation fixture requires provider");
    expect(startupReady && settingsReady).toBe(true);
    await $("button=Generate").click();
    await $(".plugin-dialog").waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => requests.length === 1 && releaseResponse !== null,
      { timeoutMsg: "the one local fake provider request was not dispatched" });
    try {
      let refused = "";
      try { await invoke("set_plugin_package_enabled", { id: "xnmp.image-generation", enabled: false }); }
      catch (failure) { refused = String(failure); }
      expect(refused).toMatch(/active|busy|finish|operation/i);
      const installed = await invoke("list_installed_plugins");
      expect(installed.find((entry: any) => entry.manifest.id === "xnmp.image-generation").enabled).toBe(true);
      const checks = await Promise.all(Array.from({ length: 8 }, () => backend("xnmp.trace-explorer", "recent_openai_image_runs")));
      expect(checks.every(runs => runs.some((run: any) => run.run.status === "running"))).toBe(true);
    } finally { releaseResponse?.(); }
    await browser.waitUntil(async () => {
      const runs = await backend("xnmp.trace-explorer", "recent_openai_image_runs");
      return runs.some((r: any) => r.run.status === "succeeded" && r.run.parameters.prompt === "Keep the native caller draft");
    }, { timeout: 45_000, timeoutMsg: "native image job did not publish its proven output" });
    const runs = await backend("xnmp.trace-explorer", "recent_openai_image_runs");
    const run = runs.find((r: any) => r.run.parameters.prompt === "Keep the native caller draft");
    expect(requests.length).toBe(1);
    expect(requests[0].path).toBe("/fixture/images/generations");
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].body).toMatchObject({ model: "fixture/native-image-v1", prompt: "Keep the native caller draft" });
    expect(run.run.parameters.connection_id).toBe(connectionA);
    expect(run.run.parameters.operation_id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(run.run.parameters.effective_recipe).toBeDefined();
    const output = run.outputPath ?? run.preparedOutputPath;
    expect(typeof output).toBe("string");
    expect(fs.readFileSync(output).equals(png)).toBe(true);
    const journal = path.join(process.env.XDG_CONFIG_HOME!, "tauri-explorer", "plugin-data", "xnmp.image-generation", "operations.sqlite");
    const receipt = JSON.parse(execFileSync("python3", ["-c", "import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute('SELECT status FROM operations WHERE caller=? AND operation=?',('xnmp.trace-explorer',sys.argv[2])).fetchone(); print(r[0] if r else 'null')", journal, run.run.parameters.operation_id], { encoding: "utf8" }));
    expect(receipt.execution.state).toBe("succeeded");
    expect(receipt.delivery.state).toBe("acquired");
    expect(receipt.execution.metadata.actualModel).toBe("fixture/actual-image-v1");
    fs.writeFileSync(path.join(evidence, "provider-acquired-receipt.json"), JSON.stringify(receipt, null, 2));
    await command("Toggle Trace View");
    await $('[data-file-view="trace.view"]').waitForDisplayed();
    const generated = `[data-tile-key="o:${run.run.id}:0"]`;
    await $(generated).waitForDisplayed();
    await browser.waitUntil(async () => browser.execute((selector: string) => {
      const image = document.querySelector<HTMLImageElement>(`${selector} button.card img`);
      return !!image?.complete && image.naturalWidth > 0;
    }, generated), { timeoutMsg: "Trace did not decode and display this operation's generated image" });
    fs.writeFileSync(path.join(evidence, "generation-run.json"), JSON.stringify(run, null, 2));
    await screenshot("generated-trace-image");
    // Kill only this private provider through a pinned process handle. The
    // completed acquired receipt must survive activation with no remote replay.
    const providers = (privateProcesses() as { pid: string; exe: string }[]).filter(row => row.exe.endsWith("image-generation-backend"));
    expect(providers.length).toBe(1);
    const provider = providers[0];
    execFileSync("python3", ["-c", "import os,sys,signal; p=int(sys.argv[1]); fd=os.pidfd_open(p); assert os.readlink('/proc/'+str(p)+'/exe')==sys.argv[2]; env=open('/proc/'+str(p)+'/environ','rb').read().split(bytes([0])); assert ('XDG_CONFIG_HOME='+sys.argv[3]).encode() in env; signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd)", provider.pid, provider.exe, process.env.XDG_CONFIG_HOME!]);
    const reactivated = await backend("xnmp.trace-explorer", "image_service_describe");
    expect(reactivated.available).toBe(true);
    const restarted = (privateProcesses() as { pid: string; exe: string }[]).filter(row => row.exe.endsWith("image-generation-backend"));
    expect(restarted.length).toBe(1);
    expect(restarted[0].pid).not.toBe(provider.pid);
    const unchanged = JSON.parse(execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(c.execute('SELECT status FROM operations WHERE caller=? AND operation=?',('xnmp.trace-explorer',sys.argv[2])).fetchone()[0])", journal, run.run.parameters.operation_id], { encoding: "utf8" }));
    expect(unchanged).toEqual(receipt);
    expect(requests.length).toBe(1);
    await screenshot("provider-restarted-no-replay");
  });
});
