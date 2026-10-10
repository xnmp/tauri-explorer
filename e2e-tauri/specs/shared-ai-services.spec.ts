/** Native working-snapshot acceptance; never a clean-release qualification.
 * Run only through run-shared-ai-services.sh with private Xvfb/D-Bus/XDG.
 * Paid providers/keys are forbidden; generation is explicitly gated separately.
 */
import { browser, $, $$, expect } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gatedDescribe } from "./gated-describe";
import { domText, entryPathSelector, navigateTo } from "./helpers";

const directory = process.env.SHARED_AI_NATIVE_FIXTURE;
const present = process.env.SHARED_AI_NATIVE_PROVIDER === "present";
const generate = process.env.SHARED_AI_NATIVE_GENERATE === "1";
const png = fs.readFileSync(fileURLToPath(new URL("../fixtures/image-crop/quadrants.png", import.meta.url)));
const evidence = path.resolve("evidence/shared-ai-native");
let server: Server | undefined;
let endpoint = "";
let textRoot = "";
let releaseResponse: (() => void) | null = null;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
interface ImagePart { name: string; filename: string; type: string; sha256: string }
interface ImageRequest { path: string; headers: Record<string, unknown>; body: unknown; images: ImagePart[]; status?: number; outputSha256?: string }
interface TextRequest { path: string; headers: Record<string, unknown>; model: string; prompt: string; held: boolean; answered: boolean; closed: boolean; at?: number; closedAt?: number }
const requests: ImageRequest[] = [];
const textRequests: TextRequest[] = [];
/** Scripted image replies, consumed one per request. Without one, the original
 * held-success behaviour of the first generation case applies. */
const imageReplies: { status: number }[] = [];
/** Text replies by requested model; held models wait for `releaseText`. */
const textTitles = new Map<string, string>();
const heldTextModels = new Set<string>();
let heldText: (() => void)[] = [];
const releaseText = () => { const waiting = heldText; heldText = []; waiting.forEach(release => release()); };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** The fixture's pixels with a distinct tEXt chunk, so every fake output and
 * second input has its own digest while staying a valid, decodable PNG. */
function taggedPng(tag: string): Buffer {
  const iend = png.length - 12;
  if (png.subarray(iend + 4, iend + 8).toString("latin1") !== "IEND") throw new Error("fixture PNG does not end with IEND");
  const type = Buffer.from("tEXt", "latin1");
  const data = Buffer.from(`Comment\0${tag}`, "latin1");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, iend), length, type, data, crc, png.subarray(iend)]);
}
/** Field values and ordered file parts of a multipart/form-data body. */
function multipart(contentType: string, bytes: Buffer): { fields: Record<string, string>; images: ImagePart[] } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) throw new Error(`multipart body without boundary: ${contentType}`);
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields: Record<string, string> = {};
  const images: ImagePart[] = [];
  for (let start = bytes.indexOf(delimiter); start >= 0;) {
    const next = bytes.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const part = bytes.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("latin1");
    const content = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) fields[name] = content.toString("utf8");
    else images.push({ name, filename, type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "", sha256: sha256(content) });
    start = next;
  }
  return { fields, images };
}
async function replyText(request: IncomingMessage, response: ServerResponse, bytes: Buffer): Promise<void> {
  const body = JSON.parse(bytes.toString());
  const model = String(body.model);
  const entry: TextRequest = { path: request.url ?? "", headers: request.headers, model, prompt: String(body.messages?.[1]?.content ?? ""), held: heldTextModels.has(model), answered: false, closed: false };
  entry.at = Date.now();
  textRequests.push(entry);
  response.on("close", () => { entry.closed = true; entry.closedAt = Date.now(); });
  if (entry.held) await new Promise<void>(resolve => heldText.push(resolve));
  const title = textTitles.get(model);
  if (response.destroyed) return;
  if (!title) { response.writeHead(404, { "Content-Type": "application/json" }); response.end("{}"); return; }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: title } }] }));
  entry.answered = true;
}
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
  // Click the exact label: frecency can rank a recently used command first.
  const item = $(`//li[contains(@class,"command-item")][span[contains(@class,"command-label")][normalize-space()="${label}"]]`);
  await item.waitForExist({ timeoutMsg: `command "${label}" is not offered` });
  await item.click();
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

/** Click the open context-menu item whose label contains `label`. */
async function clickMenuItem(label: string): Promise<void> {
  await $(".context-menu").waitForDisplayed({ timeout: 5000 });
  for (const item of await $$(".context-menu .menu-item").getElements()) {
    if ((((await item.getProperty("textContent")) as string | null) ?? "").includes(label)) { await item.click(); return; }
  }
  throw new Error(`context-menu item "${label}" not found in ${JSON.stringify(await browser.execute(() => [...document.querySelectorAll(".context-menu .menu-item")].map(item => item.textContent?.trim())))}`);
}
/** The provider's own journal receipt for one Trace operation (read-only). */
function providerReceipt(operationId: string): any {
  const journal = path.join(process.env.XDG_CONFIG_HOME!, "tauri-explorer", "plugin-data", "xnmp.image-generation", "operations.sqlite");
  return JSON.parse(execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute('SELECT status FROM operations WHERE caller=? AND operation=?',('xnmp.trace-explorer',sys.argv[2])).fetchone(); print(r[0] if r else 'null')", journal, operationId], { encoding: "utf8" }));
}
const activeDescription = (): Promise<string> => browser.execute(() => {
  const active = document.activeElement as HTMLElement | null;
  const dialogs = [...document.querySelectorAll('[aria-modal="true"]')].map(d => `${d.className}|inert=${(d as HTMLElement).inert || !!d.closest("[inert]")}`);
  return JSON.stringify({ tag: active?.tagName, cls: active?.className, text: active?.textContent?.trim().slice(0, 60), aria: active?.getAttribute("aria-label"), dialogs });
});
/** Clicks like a user; when something covers the target, names what does. */
async function press(target: ChainablePromiseElement): Promise<void> {
  await target.waitForDisplayed();
  try { await target.click(); } catch (error) {
    const cover = await browser.execute((element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) as HTMLElement | null;
      const owner = (node: HTMLElement | null) => node ? `${node.tagName}.${node.className}[${node.getAttribute("aria-label") ?? ""}]` : "none";
      return { target: owner(element), box: [box.x, box.y, box.width, box.height], viewport: [innerWidth, innerHeight], cover: owner(top), coverParents: [top?.parentElement, top?.closest("[role]")].map(n => owner(n as HTMLElement | null)) };
    }, await target as unknown as HTMLElement);
    await screenshot(`press-intercepted-${Date.now()}`);
    throw new Error(`${(error as Error).message}: ${JSON.stringify(cover)}`);
  }
}
const traceSelector = '[data-file-view="trace.view"]';
async function traceView(on: boolean, source: string): Promise<void> {
  if (await $(traceSelector).isDisplayed().catch(() => false) !== on) await command("Toggle Trace View");
  if (on) await $(traceSelector).waitForDisplayed({ timeout: 30_000 });
  else await $(entryPathSelector(source)).waitForDisplayed();
}
const progress = '[role="region"][aria-label="Background progress"]';
interface ProgressEntry { id: string | null; label: string; status: string; error: string; retry: boolean }
/** Every image entry the host progress panel currently shows. */
function progressEntries(): Promise<ProgressEntry[]> {
  return browser.execute((selector: string) => [...document.querySelectorAll(`${selector} .operation-item`)].map(item => ({
    id: item.getAttribute("data-job-id"),
    label: item.querySelector(".file-name")?.textContent ?? "",
    status: item.querySelector('.status-text[role="status"]')?.textContent?.trim() ?? "",
    error: item.querySelector(".error-text")?.textContent ?? "",
    retry: !!item.querySelector("button.retry"),
  })), progress);
}
/** Dismisses terminal entries left by earlier cases (presentation only). */
async function clearProgress(): Promise<void> {
  // The panel re-renders as entries update, so each attempt re-queries the
  // button instead of holding a handle that can go stale between lookups.
  await browser.waitUntil(async () => {
    if (!await $(progress).isExisting()) return true;
    await $(`${progress} button.clear-all`).click().catch(() => undefined);
    return !await $(progress).isExisting();
  }, { timeout: 10_000, timeoutMsg: "the progress panel kept dismissed image entries" });
}
async function waitForTerminalProgress(status: string, timeoutMsg: string): Promise<ProgressEntry[]> {
  let entries: ProgressEntry[] = [];
  await browser.waitUntil(async () => {
    entries = await progressEntries();
    return entries.length > 0 && entries.every(entry => ["Complete", "Failed", "Cancelled", "Discarded"].includes(entry.status));
  }, { timeout: 45_000, timeoutMsg });
  expect(entries.map(entry => entry.status)).toEqual([status]);
  return entries;
}
interface RunHistory { run: { id: number; status: string; operation: string; parameters: Record<string, any>; input_ids?: number[]; inputIds?: number[] }; outputPath: string | null; preparedOutputPath: string | null; inputs: { path: string; digest: string }[] }
async function waitForRun(match: (run: RunHistory) => boolean, timeoutMsg: string): Promise<RunHistory> {
  let found: RunHistory | undefined;
  await browser.waitUntil(async () => {
    const runs: RunHistory[] = await backend("xnmp.trace-explorer", "recent_openai_image_runs");
    found = runs.find(match);
    return !!found;
  }, { timeout: 45_000, timeoutMsg });
  return found!;
}
const readRun = async (id: number): Promise<RunHistory> =>
  (await backend("xnmp.trace-explorer", "recent_openai_image_runs") as RunHistory[]).find(entry => entry.run.id === id)!;
/** The Trace-recorded provenance for an image: its run and that run's ordered input paths. */
async function provenance(image: string, runId: number): Promise<{ inputs: string[]; inputArtifacts: Record<string, any>[]; artifact: Record<string, any> }> {
  const graph = await backend("xnmp.trace-explorer", "trace_for_image", { path: image });
  expect(graph).not.toBeNull();
  const run = graph.runs.find((candidate: any) => candidate.id === runId);
  expect(run).toBeDefined();
  const byId = new Map<number, Record<string, any>>(graph.artifacts.map((artifact: any) => [artifact.id, artifact]));
  const inputArtifacts = (run.inputIds ?? run.input_ids).map((id: number) => byId.get(id)!);
  return {
    inputs: inputArtifacts.map((artifact: Record<string, any>) => artifact.path),
    inputArtifacts,
    artifact: graph.artifacts.find((artifact: any) => artifact.path === image && artifact.generatingRun === runId),
  };
}
async function withControl(action: () => Promise<void>): Promise<void> {
  await browser.performActions([{ type: "key", id: "modifier", actions: [{ type: "keyDown", value: "" }] }]);
  try { await action(); }
  finally {
    await browser.performActions([{ type: "key", id: "modifier", actions: [{ type: "keyUp", value: "" }] }]);
    await browser.releaseActions();
  }
}
const inputOrder = (): Promise<string[]> => browser.execute(() =>
  [...document.querySelectorAll<HTMLElement>(".plugin-dialog li.input-card")].map(card => card.dataset.inputPath ?? ""));
async function submitImageDialog(prompt: string): Promise<void> {
  const dialog = $(".plugin-dialog");
  // Lower-case prompts: WebKitWebDriver occasionally drops Shift on the first typed key.
  await dialog.$("textarea").setValue(prompt);
  expect(await dialog.$("textarea").getValue()).toBe(prompt);
  const generateButton = dialog.$("button=Generate");
  await browser.waitUntil(() => generateButton.isEnabled(), { timeoutMsg: "the image form never became ready to generate" });
  await generateButton.click();
  await dialog.waitForDisplayed({ reverse: true, timeoutMsg: "the image form did not close after accepting the job" });
}
/** Keyboard focus on a tile shows its hover actions (`:focus-within`), without
 * a pointer action that would disturb WebKitWebDriver's later Shift handling. */
const focusCard = (tile: string): Promise<void> => browser.execute((selector: string) => {
  document.querySelector<HTMLElement>(`${selector} button.card`)!.focus();
}, tile);
const tileText = (key: string): Promise<string> => browser.execute((selector: string) =>
  document.querySelector(`${selector} .label .text`)?.textContent ?? "", `[data-tile-key="${key}"]`);
/** Choose a <select> option as a user would, with one change event.
 * WebKitWebDriver's option click skips the change event when the same select
 * element previously showed that value for another (since replaced) profile. */
async function choose(select: ChainablePromiseElement, value: string): Promise<void> {
  await browser.execute((element: HTMLSelectElement, next: string) => {
    if (![...element.options].some(option => option.value === next)) throw new Error(`no option ${next}`);
    element.focus();
    element.value = next;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, await select.getElement() as unknown as HTMLSelectElement, value);
  expect(await select.getValue()).toBe(value);
}
async function textProfile(name: string, model: string): Promise<string> {
  const root = $(".language-models");
  await root.$("button=Add profile").click();
  // A new profile starts as Codex CLI; its editor must show that, not the previous profile's protocol.
  await browser.waitUntil(async () => (await root.$("label*=Edit profile").$("select").getValue()) !== "" , { timeoutMsg: "the new profile was not selected" });
  expect(await root.$("label*=Executable path").isExisting()).toBe(true);
  expect(await root.$("label*=Protocol").$("select").getValue()).toBe("codex-cli");
  await choose(root.$("label*=Protocol").$("select"), "openai-chat-completions");
  await root.$("label*=API root").waitForExist({ timeout: 5000 }).catch(async () => {
    throw new Error(`the HTTP protocol fields never appeared: ${JSON.stringify(await browser.execute(() => ({
      labels: [...document.querySelectorAll(".language-models label")].map(label => label.textContent?.trim().slice(0, 40)),
      protocol: document.querySelector<HTMLSelectElement>(".language-models fieldset select")?.value,
    })))}`);
  });
  await root.$("label*=Name").$("input").setValue(name);
  await root.$("label*=Model ID").$("input").setValue(model);
  await root.$("label*=API root").$("input").setValue(textRoot);
  expect(await root.$("label*=Credential source").$("select").getValue()).toBe("none");
  return root.$("label*=Edit profile").$("select").getValue();
}
async function saveTextDefault(profileId: string): Promise<void> {
  const root = $(".language-models");
  await choose(root.$("label*=Default profile").$("select"), profileId);
  const enabled = root.$("label*=Enable language models").$("input");
  if (!await enabled.isSelected()) await enabled.click();
  const save = root.$("button=Save language models");
  await save.click();
  await browser.waitUntil(async () => !(await save.isEnabled()) && (await domText(".language-models")).includes("Language model settings saved."),
    { timeout: 10_000 }).catch(async () => {
    throw new Error(`language model settings were not saved: ${JSON.stringify(await browser.execute(() => ({
      messages: [...document.querySelectorAll('.language-models [role="alert"], .language-models [role="status"]')].map(node => node.textContent?.trim()),
      saveEnabled: [...document.querySelectorAll(".language-models button")].filter(button => button.textContent?.includes("Save language models")).map(button => !(button as HTMLButtonElement).disabled),
    })))}`);
  });
  const saved = await invoke("ai_connections_read");
  expect(saved.enabled).toBe(true);
  expect(saved.defaultProfileId).toBe(profileId);
}

gatedDescribe("shared AI native working snapshot", [[process.platform === "linux", "Linux private display"], [!!directory, "SHARED_AI_NATIVE_FIXTURE private profile"], [process.env.SHARED_AI_NATIVE_ACCEPTANCE === "1", "SHARED_AI_NATIVE_ACCEPTANCE=1"]], () => {
  // Mocha evaluates skipped suite bodies, so paths resolve only once the gate runs it.
  let scratch = "";
  let source = "";
  let connectionA = "";
  let startupReady = false;
  let settingsReady = false;
  let generatedReady = false;
  let second = "";
  let selectionRun: RunHistory | undefined;
  let retried: RunHistory | undefined;
  before(async () => {
    scratch = directory!;
    source = path.join(scratch, "source.png");
    fs.mkdirSync(scratch, { recursive: true }); fs.writeFileSync(source, png);
    fs.writeFileSync(path.join(scratch, "notes.txt"), "Native shared AI fixture\n");
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if ((request.url ?? "").startsWith("/fixture/text/")) return replyText(request, response, bytes);
      const contentType = String(request.headers["content-type"] ?? "");
      const parsed = contentType.startsWith("multipart/form-data") ? multipart(contentType, bytes) : { fields: JSON.parse(bytes.toString()), images: [] };
      const record: ImageRequest = { path: request.url ?? "", headers: request.headers, body: parsed.fields, images: parsed.images };
      requests.push(record);
      const scripted = imageReplies.shift();
      if (!scripted && generate) await new Promise<void>(resolve => {
        const timeout = setTimeout(() => { releaseResponse = null; resolve(); }, 20_000);
        releaseResponse = () => { clearTimeout(timeout); releaseResponse = null; resolve(); };
      });
      record.status = scripted?.status ?? 200;
      if (record.status !== 200) {
        response.writeHead(record.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "native fixture rejected this request" } }));
        return;
      }
      const output = scripted ? taggedPng(`native-output-${requests.length}`) : png;
      record.outputSha256 = sha256(output);
      response.writeHead(200, { "Content-Type": "application/json", "x-request-id": "native-fake-request" });
      response.end(JSON.stringify({ model: "fixture/actual-image-v1", data: [{ b64_json: output.toString("base64") }] }));
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    endpoint = `http://127.0.0.1:${port}/fixture/images`;
    textRoot = `http://127.0.0.1:${port}/fixture/text/v1`;
  });
  after(async () => {
    releaseResponse?.();
    releaseText();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, `${present ? "present" : "absent"}-outcomes.json`), JSON.stringify({ qualification: "dirty-working-snapshot", privateProcesses: privateProcesses(), requests, textRequests, providerPresent: present, generationEnabled: generate }, null, 2));
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
    generatedReady = true;
  });
  // Plan §14.4 (4.6, 4.9): selection entry point with ordered inputs.
  if (generate) it("edits two selected images in the order shown, sends them in that order and links both inputs in Trace", async function () {
    this.timeout(150_000);
    expect(generatedReady).toBe(true);
    await traceView(false, source);
    await clearProgress();
    second = path.join(scratch, "second.png");
    fs.writeFileSync(second, taggedPng("native-second-input"));
    await $(entryPathSelector(second)).waitForDisplayed({ timeoutMsg: "the second input never appeared in the listing" });
    await $(entryPathSelector(source)).click();
    await withControl(() => $(entryPathSelector(second)).click());
    await command("AI Edit Image…");
    await $(".plugin-dialog").waitForDisplayed();
    const initial = await inputOrder();
    expect([...initial].sort()).toEqual([second, source].sort());
    await $('.plugin-dialog button[aria-label="Move Image 2 earlier"]').click();
    const ordered = await inputOrder();
    expect(ordered).toEqual([initial[1], initial[0]]);
    const before = requests.length;
    imageReplies.push({ status: 200 });
    const prompt = "native selection edit with ordered inputs";
    await submitImageDialog(prompt);
    selectionRun = await waitForRun(entry => entry.run.parameters.prompt === prompt && entry.run.status === "succeeded",
      "the selection edit never published its output");
    // The loopback endpoint received exactly the displayed images, in the displayed order.
    expect(requests.length).toBe(before + 1);
    const sent = requests[before];
    expect(sent.path).toBe("/fixture/images/edits");
    expect(sent.headers.authorization).toBeUndefined();
    // The provider sends Trace's recorded recipe prompt, which numbers the images.
    expect(sent.body).toMatchObject({ prompt: selectionRun.run.parameters.submitted_prompt, model: "fixture/native-image-v1" });
    expect(String((sent.body as Record<string, string>).prompt)).toContain(prompt);
    expect(sent.images.map(part => part.name)).toEqual(["image[]", "image[]"]);
    expect(sent.images.map(part => part.sha256)).toEqual(ordered.map(file => sha256(fs.readFileSync(file))));
    // Trace persisted the same ordered, pinned inputs and the exact output.
    expect(selectionRun.run.operation).toBe("openai.image.edit");
    expect(selectionRun.inputs).toEqual(ordered.map(file => ({ path: file, digest: sha256(fs.readFileSync(file)) })));
    expect(sha256(fs.readFileSync(selectionRun.outputPath!))).toBe(sent.outputSha256);
    const linked = await provenance(selectionRun.outputPath!, selectionRun.run.id);
    expect(linked.inputs).toEqual(ordered);
    // One progress entry with the real terminal outcome.
    await waitForTerminalProgress("Complete", "the progress panel never showed the selection edit's outcome");
    await traceView(true, source);
    const key = `o:${selectionRun.run.id}:0`;
    await $(`[data-tile-key="${key}"]`).waitForDisplayed();
    // Every recorded input draws an edge into the output (directly or through
    // the junction Trace draws for a multi-input run).
    const inputKeys = linked.inputArtifacts.map(artifact => artifact.generatingRun ? `o:${artifact.generatingRun}:0` : `a:${artifact.id}`).sort();
    const drawn = () => browser.execute((target: string) => {
      const image = document.querySelector<HTMLImageElement>(`[data-tile-key="${target}"] button.card img`);
      const routes = [...document.querySelectorAll("path[data-route]")].map(route => [route.getAttribute("data-from") ?? "", route.getAttribute("data-to") ?? ""]);
      const into = new Set([`node:${target}`]);
      for (const [from, to] of routes) if (to === `node:${target}` && from.startsWith("junction:")) into.add(from);
      const sources = routes.filter(([from, to]) => into.has(to) && from.startsWith("node:")).map(([from]) => from.slice("node:".length));
      return { decoded: !!image?.complete && image.naturalWidth > 0, sources: [...new Set(sources)].sort(), routes };
    }, key);
    await browser.waitUntil(async () => {
      const seen = await drawn();
      return seen.decoded && JSON.stringify(seen.sources) === JSON.stringify(inputKeys);
    }, { timeout: 20_000 }).catch(async () => {
      throw new Error(`Trace did not show the edited image with its ${inputKeys.join(", ")} input links: ${JSON.stringify(await drawn())}`);
    });
    fs.writeFileSync(path.join(evidence, "selection-edit-run.json"), JSON.stringify({ run: selectionRun, request: sent }, null, 2));
    await screenshot("selection-edit-trace");
  });
  // Plan §14.4 (4.7, 4.9): a rejected run fails visibly; Retry is a new durable operation.
  if (generate) it("retries a rejected run from the progress panel as a new operation with the same pinned inputs and options", async function () {
    this.timeout(150_000);
    expect(selectionRun).toBeDefined();
    await traceView(false, source);
    await clearProgress();
    await $(entryPathSelector(source)).click();
    await command("AI Edit Image…");
    await $(".plugin-dialog").waitForDisplayed();
    expect(await inputOrder()).toEqual([source]);
    const before = requests.length;
    imageReplies.push({ status: 400 }, { status: 200 });
    const prompt = "native retry after a rejected request";
    await submitImageDialog(prompt);
    const failed = await waitForRun(entry => entry.run.parameters.prompt === prompt && entry.run.status === "failed",
      "the rejected request never failed its run");
    const [failure] = await waitForTerminalProgress("Failed", "the progress panel never showed the rejected run's failure");
    expect(failure.error.trim()).not.toBe("");
    expect(failure.retry).toBe(true);
    expect(requests.length).toBe(before + 1);
    await screenshot("retry-failed-progress");
    await $(progress).$("button.retry").click();
    retried = await waitForRun(entry => entry.run.parameters.retry_of === failed.run.id && entry.run.status === "succeeded",
      "Retry never published a run linked to the failed one");
    await waitForTerminalProgress("Complete", "the progress panel did not replace the failure with the retry's outcome");
    expect(retried.run.id).not.toBe(failed.run.id);
    expect(retried.run.parameters.operation_id).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(retried.run.parameters.operation_id).not.toBe(failed.run.parameters.operation_id);
    expect(retried.inputs).toEqual(failed.inputs);
    expect(retried.inputs).toEqual([{ path: source, digest: sha256(fs.readFileSync(source)) }]);
    for (const option of ["prompt", "model", "size", "resolution", "aspect_ratio", "quality", "background", "connection_id", "connection_revision", "input_roles", "submitted_prompt"])
      expect({ [option]: retried.run.parameters[option] }).toEqual({ [option]: failed.run.parameters[option] });
    const original = await readRun(failed.run.id);
    expect(original.run.status).toBe("failed");
    expect(original.run.parameters.retry_of).toBeUndefined();
    // The endpoint saw the rejected original and one identical resubmission.
    expect(requests.length).toBe(before + 2);
    const [first, again] = requests.slice(before);
    expect([first.status, again.status]).toEqual([400, 200]);
    expect(again.path).toBe(first.path);
    expect(again.body).toEqual(first.body);
    expect(again.images).toEqual(first.images);
    expect(sha256(fs.readFileSync(retried.outputPath!))).toBe(again.outputSha256);
    expect((await provenance(retried.outputPath!, retried.run.id)).inputs).toEqual([source]);
    fs.writeFileSync(path.join(evidence, "retry-runs.json"), JSON.stringify({ failed, retried, requests: [first, again] }, null, 2));
  });
  // Plan §14.4 (4.10): native Save and Discard of unsaved outputs.
  if (generate) it("saves one generated image into its folder and discards another, keeping provenance and receipts", async function () {
    this.timeout(150_000);
    expect(selectionRun && retried).toBeTruthy();
    const requestCount = requests.length;
    const pngs = () => fs.readdirSync(scratch).filter(name => name.endsWith(".png")).sort();
    const listed = pngs();
    await traceView(true, source);
    const temporary = selectionRun!.outputPath!;
    const bytes = fs.readFileSync(temporary);
    const kept = `[data-tile-key="o:${selectionRun!.run.id}:0"]`;
    await $(kept).waitForDisplayed();
    await focusCard(kept);
    await $(kept).$('button[aria-label="Save image permanently"]').click();
    const saved = await waitForRun(entry => entry.run.id === selectionRun!.run.id && !!entry.outputPath && path.dirname(entry.outputPath) === scratch,
      "Save did not move the image into its folder");
    expect(fs.readFileSync(saved.outputPath!).equals(bytes)).toBe(true);
    // Save copies the unsaved bytes; Trace re-points the artifact (its old
    // temporary path stays a locator, by design since Trace #1).
    expect(saved.outputPath).not.toBe(temporary);
    const savedLink = await provenance(saved.outputPath!, selectionRun!.run.id);
    expect(savedLink.inputs).toEqual(selectionRun!.inputs.map(input => input.path));
    expect(savedLink.artifact.temporary).toBeUndefined();
    expect(savedLink.artifact.digest).toBe(sha256(bytes));
    const discardedPath = retried!.outputPath!;
    expect(fs.existsSync(discardedPath)).toBe(true);
    const dropped = `[data-tile-key="o:${retried!.run.id}:0"]`;
    await $(dropped).waitForDisplayed();
    await focusCard(dropped);
    await $(dropped).$('button[aria-label="Delete unsaved image"]').click();
    await browser.waitUntil(async () => !fs.existsSync(discardedPath), { timeoutMsg: "Discard left the temporary image on disk" });
    const discardedLink = await provenance(discardedPath, retried!.run.id);
    expect(discardedLink.artifact.discarded).toBe(true);
    expect(discardedLink.inputs).toEqual([source]);
    // The folder gained exactly the saved image; the discarded one never landed.
    expect(pngs()).toEqual([...listed, path.basename(saved.outputPath!)].sort());
    // Provider receipts stay acquired: no Save or Discard replays a provider request.
    for (const run of [selectionRun!, retried!]) {
      const receipt = providerReceipt(run.run.parameters.operation_id);
      expect(receipt.execution.state).toBe("succeeded");
      expect(receipt.delivery.state).toBe("acquired");
    }
    expect(requests.length).toBe(requestCount);
    await screenshot("saved-and-discarded");
  });
  // Plan §14.4 (4.2, 4.3, 4.5): the host's global text default titles Trace prompts.
  if (generate) it("titles Trace prompts with the global default text profile, ignores a slow previous profile, and keeps text and image settings independent", async function () {
    this.timeout(180_000);
    expect(selectionRun).toBeDefined();
    const prompt = selectionRun!.run.parameters.prompt as string;
    textTitles.set("fixture-text-a", "Alpha fixture title");
    textTitles.set("fixture-text-b", "Beta fixture title");
    textTitles.set("fixture-text-slow", "Slow stale title");
    heldTextModels.add("fixture-text-slow");
    const imageSettings = await backend("xnmp.image-generation", "settings.read");
    // The finished-progress corner panel stays above modal dialogs by design
    // and covers their footers at this window size; dismiss it as a user would.
    await clearProgress();
    await traceView(true, source);
    const key = `o:${selectionRun!.run.id}:0`;
    await $(`[data-tile-key="${key}"]`).waitForDisplayed();
    expect(await tileText(key)).toBe(prompt);
    expect(textRequests).toEqual([]);
    await command("Settings");
    await $(".language-models").$("button=Add profile").waitForDisplayed();
    const alpha = await textProfile("fixture text a", "fixture-text-a");
    const beta = await textProfile("fixture text b", "fixture-text-b");
    await saveTextDefault(alpha);
    await browser.waitUntil(async () => await tileText(key) === "Alpha fixture title",
      { timeout: 30_000, timeoutMsg: "the default profile's title never reached the Trace prompt node" });
    const alphaRequests = textRequests.filter(request => request.model === "fixture-text-a");
    expect(alphaRequests.map(request => request.prompt)).toContain(prompt);
    expect(alphaRequests.every(request => request.path === "/fixture/text/v1/chat/completions" && request.headers.authorization === undefined)).toBe(true);
    // 4.2: change the host's global default and the node follows it.
    await saveTextDefault(beta);
    await browser.waitUntil(async () => await tileText(key) === "Beta fixture title",
      { timeout: 30_000, timeoutMsg: "changing the global default did not retitle the Trace prompt node" });
    expect(textRequests.some(request => request.model === "fixture-text-b" && request.prompt === prompt)).toBe(true);
    await screenshot("titles-global-default");
    // 4.3: a slow response from the previous default never replaces the new default's label.
    const slow = await textProfile("fixture text slow", "fixture-text-slow");
    await saveTextDefault(slow);
    await browser.waitUntil(async () => textRequests.some(request => request.model === "fixture-text-slow"),
      { timeoutMsg: "the slow profile was never asked for a title" });
    await browser.waitUntil(async () => await tileText(key) === prompt
      && await browser.execute((target: string) => !!document.querySelector(`[data-tile-key="${target}"] [aria-label="Generating title"]`), key),
      { timeoutMsg: "the pending slow title did not show the prompt with a spinner" });
    await browser.execute((selector: string) => {
      const view = document.querySelector(selector)!;
      const record = () => { if (view.textContent?.includes("Slow stale title")) (window as any).__staleTitleSeen = true; };
      (window as any).__staleTitleSeen = false;
      (window as any).__staleTitleObserver = new MutationObserver(record);
      (window as any).__staleTitleObserver.observe(view, { subtree: true, childList: true, characterData: true });
    }, traceSelector);
    await saveTextDefault(beta);
    await browser.waitUntil(async () => await tileText(key) === "Beta fixture title",
      { timeout: 30_000, timeoutMsg: "the new default's title did not replace the pending slow request" });
    releaseText();
    await browser.waitUntil(async () => textRequests.filter(request => request.model === "fixture-text-slow").every(request => request.closed),
      { timeoutMsg: "the slow responses were never delivered or abandoned" });
    // Barrier: one more title round trip through the same Trace title queue
    // completes only after any stale slow result was returned to the view.
    const description = await backend("xnmp.trace-explorer", "trace_title_context");
    const barrier = await backend("xnmp.trace-explorer", "trace_prompt_title",
      { runId: selectionRun!.run.id, requestId: `native-barrier-${Date.now()}`, expectedConfigurationRevision: description.context.configurationRevision });
    expect(barrier.title).toBe("Beta fixture title");
    expect(await tileText(key)).toBe("Beta fixture title");
    expect(await browser.execute(() => { (window as any).__staleTitleObserver.disconnect(); return (window as any).__staleTitleSeen; })).toBe(false);
    // One paid title request per prompt and profile: a configuration change
    // announced twice (the host's save and its file watcher) asks once.
    const asked = textRequests.map(request => `${request.model}\n${request.prompt}`);
    expect(asked.filter((entry, index) => asked.indexOf(entry) !== index)).toEqual([]);
    // 4.5: saving text settings never touched image connections.
    expect(await backend("xnmp.image-generation", "settings.read")).toEqual(imageSettings);
    await browser.keys("Escape");
    await $(".language-models").waitForDisplayed({ reverse: true });
    // 4.5: saving image connections never touches text settings.
    const textSettings = await invoke("ai_connections_read");
    await command("Image Generation: Configure connections");
    await $(".connections").waitForDisplayed({ timeoutMsg: "the palette's command opened no image connections dialog" });
    const otherDefault = imageSettings.profiles.map((profile: { id: string }) => profile.id).find((id: string) => id !== imageSettings.defaultConnectionId);
    await choose($(".connections").$("label*=Default image connection").$("select"), otherDefault);
    await $("button=Save connections").click();
    await browser.waitUntil(async () => !(await $("button=Save connections").isEnabled()), { timeoutMsg: "image connection save never committed" });
    expect((await backend("xnmp.image-generation", "settings.read")).defaultConnectionId).toBe(otherDefault);
    expect(await invoke("ai_connections_read")).toEqual(textSettings);
    await press($(".connections").$("button=Close"));
    await $(".connections").waitForDisplayed({ reverse: true });
    fs.writeFileSync(path.join(evidence, "text-settings.json"), JSON.stringify(textSettings, null, 2));
  });
  // Plan §14.4 (4.6): folder entry point, no invented inputs, output suggested in that folder.
  if (generate) it("generates from a folder's context menu into that folder with no invented input", async function () {
    this.timeout(150_000);
    expect(selectionRun).toBeDefined();
    await traceView(false, source);
    await clearProgress();
    const folder = path.join(scratch, "folder-entry");
    fs.mkdirSync(folder);
    await $(entryPathSelector(folder)).waitForDisplayed({ timeoutMsg: "the output folder never appeared in the listing" });
    // Runs after every typed case: WebKitWebDriver drops Shift from all later
    // typing once a right-click pointer action has run in the session.
    await $(entryPathSelector(folder)).click({ button: "right" });
    await clickMenuItem("AI");
    await $(".ai-submenu").waitForDisplayed();
    await clickMenuItem("Generate image with OpenAI");
    await $(".plugin-dialog").waitForDisplayed();
    expect(await inputOrder()).toEqual([]);
    const before = requests.length;
    imageReplies.push({ status: 200 });
    const prompt = "native folder entry generation";
    await submitImageDialog(prompt);
    const run = await waitForRun(entry => entry.run.parameters.prompt === prompt && entry.run.status === "succeeded",
      "the folder generation never published its output");
    expect(requests.length).toBe(before + 1);
    const sent = requests[before];
    expect(sent.path).toBe("/fixture/images/generations");
    expect(sent.images).toEqual([]);
    expect(sent.body).toMatchObject({ prompt: run.run.parameters.submitted_prompt, model: "fixture/native-image-v1" });
    expect(String((sent.body as Record<string, string>).prompt)).toContain(prompt);
    expect(run.run.operation).toBe("openai.image.generate");
    expect(run.inputs).toEqual([]);
    expect(sha256(fs.readFileSync(run.outputPath!))).toBe(sent.outputSha256);
    const generated = await provenance(run.outputPath!, run.run.id);
    expect(generated.inputs).toEqual([]);
    expect(generated.artifact.temporary).toBe(true);
    const suggestion = await backend("xnmp.trace-explorer", "image_save_suggestion", { artifactId: generated.artifact.id });
    expect(suggestion.directory).toBe(folder);
    // Nothing lands in the folder until the user saves.
    expect(fs.readdirSync(folder)).toEqual([]);
    await waitForTerminalProgress("Complete", "the progress panel never showed the folder generation's outcome");
    fs.writeFileSync(path.join(evidence, "folder-entry-run.json"), JSON.stringify({ run, suggestion, request: sent }, null, 2));
  });
  // Plan §21.3 item 12: provider configuration opened from the Plugins page.
  it("opens provider configuration from Plugins as the top modal that owns Escape and focus, losing no draft", async function () {
    if (!present) this.skip();
    expect(settingsReady).toBe(true);
    // Without generation the settings case leaves its caller form open (no
    // unsaved provider edits); close whatever an earlier case left open.
    for (let attempt = 0; attempt < 4 && await browser.execute(() => !!document.querySelector('[aria-modal="true"]')); attempt++) await browser.keys("Escape");
    expect(await browser.execute(() => !!document.querySelector('[aria-modal="true"]'))).toBe(false);
    await clearProgress();
    const saved = await backend("xnmp.image-generation", "settings.read");
    await command("Plugins");
    const plugins = $(".plugins-dialog");
    await plugins.waitForDisplayed();
    await plugins.$('input[aria-label="Filter plugins"]').setValue("image");
    await press(plugins.$('//section[h3[normalize-space()="AI / Image Generation"]]//button[normalize-space()="Configure connections"]'));
    const connections = $(".connections");
    await connections.waitForDisplayed();
    // Only the provider modal is modal; the suspended Plugins page is not.
    const insideConnections = () => browser.execute(() => {
      const modals = [...document.querySelectorAll('[aria-modal="true"]')];
      return modals.length === 1 && !!modals[0].querySelector(".connections") && modals[0].contains(document.activeElement);
    });
    await browser.waitUntil(insideConnections, { timeout: 5000 }).catch(async () => {
      throw new Error(`focus did not move into the provider configuration: ${await activeDescription()}`);
    });
    const suspendedPlugins = () => browser.execute(() => !!document.querySelector(".plugins-dialog")?.closest("[inert]"));
    expect(await suspendedPlugins()).toBe(true);
    const name = connections.$("label*=Name").$("input");
    await name.waitForDisplayed();
    await name.setValue("unsaved plugins page draft");
    for (let step = 0; step < 12; step++) {
      await browser.keys("Tab");
      expect(await insideConnections()).toBe(true);
    }
    await browser.keys("Escape");
    await connections.$("button=Discard edits and close").waitForDisplayed();
    expect(await connections.isDisplayed()).toBe(true);
    // The Plugins page stays mounted but suspended (inert) beneath its child.
    expect(await suspendedPlugins()).toBe(true);
    expect(await insideConnections()).toBe(true);
    expect(await name.getValue()).toBe("unsaved plugins page draft");
    await screenshot("plugins-dirty-veto");
    await connections.$("button=Keep editing").click();
    expect(await name.getValue()).toBe("unsaved plugins page draft");
    await browser.keys("Escape");
    await connections.$("button=Discard edits and close").click();
    await connections.waitForDisplayed({ reverse: true });
    expect(await plugins.isDisplayed()).toBe(true);
    expect(await suspendedPlugins()).toBe(false);
    expect(await plugins.$('input[aria-label="Filter plugins"]').getValue()).toBe("image");
    await browser.waitUntil(() => browser.execute(() => {
      const active = document.activeElement;
      return active?.textContent?.trim() === "Configure connections"
        && active.closest("section")?.querySelector("h3")?.textContent?.trim() === "AI / Image Generation";
    }), { timeoutMsg: "focus did not return to the Plugins page action" });
    expect(await backend("xnmp.image-generation", "settings.read")).toEqual(saved);
    await browser.keys("Escape");
    await plugins.waitForDisplayed({ reverse: true });
  });
});
