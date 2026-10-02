/** Production WKWebView outcomes, observed only through XCTest and display pixels. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "webdriverio";

interface Rect { x: number; y: number; width: number; height: number }
interface Display extends Rect { id: number; pixelWidth: number; pixelHeight: number }
interface Landmark extends Rect { cx: number; cy: number; pixels: number; pixelScale: number }
const COLORS = [[255, 0, 0], [153, 0, 204], [255, 128, 0]] as const;
const PAGE_SIZES = [[600, 800], [800, 600], [500, 700]] as const;
const PDF_FILES = { pdf: "native-pdf-landmarks.pdf", corrupt: "native-corrupt.pdf", image: "native-replacement.svg" } as const;
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const assert = (condition: boolean, message: string): void => { if (!condition) throw new Error(message); };
const near = (actual: number, expected: number, tolerance: number, message: string) =>
  assert(Math.abs(actual - expected) <= tolerance, `${message}: observed ${actual}, expected ${expected} ± ${tolerance}`);

export function prepareMacosPdfFixtures(fixture: string): void {
  fs.copyFileSync("src/lib/api/fixtures/preview-landmarks.pdf", path.join(fixture, PDF_FILES.pdf));
  fs.writeFileSync(path.join(fixture, PDF_FILES.corrupt), "%PDF-1.7\ninvalid object stream\n");
  fs.writeFileSync(path.join(fixture, PDF_FILES.image), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#0000ff"/></svg>');
}

export async function qualifyMacosPdf(browser: Browser, fixture: string, output: string): Promise<void> {
  assert(process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true" &&
    process.env.RUNNER_ENVIRONMENT === "github-hosted", "PDF native input requires the disposable hosted Mac runner");
  const directory = path.join(output, "pdf-preview");
  fs.mkdirSync(directory, { recursive: true });
  const { pdf: pdfName, corrupt: badName, image: imageName } = PDF_FILES;
  const pdf = path.join(fixture, pdfName);
  const originalHash = hash(pdf);
  assert(originalHash === hash("src/lib/api/fixtures/preview-landmarks.pdf"), "prepared native PDF differs from the known landmark fixture");
  const display = JSON.parse(execFileSync("swift", ["e2e-tauri/macos-display.swift"], { encoding: "utf8" })) as Display;
  const report: { display: Display; fixtureSha256: string; steps: unknown[]; passed: boolean; error: string | null } =
    { display, fixtureSha256: originalHash, steps: [], passed: false, error: null };
  const save = () => fs.writeFileSync(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const record = (name: string, result: unknown) => { report.steps.push({ name, result }); save(); };
  // Exact text has an own-attribute native XCTest locator; XPath instead
  // searches a serialized accessibility snapshot, which can omit live rows.
  const textElement = (text: string) => browser.$(`-ios predicate string:elementType == 48 AND value == '${text}'`);
  const button = (label: string) => browser.$(`-ios predicate string:elementType == 9 AND (label == '${label}' OR title == '${label}')`);
  async function rect(element: Awaited<ReturnType<typeof browser.$>>): Promise<Rect> {
    return { ...await element.getLocation(), ...await element.getSize() };
  }
  async function key(key: string, modifierFlags = 0) {
    await browser.execute("macos: keys", { keys: [{ key, modifierFlags }] });
  }
  async function accessibilityProbe(stage: string) {
    const observations: Record<string, unknown> = { stage };
    async function observe(name: string, operation: () => Promise<unknown>) {
      try { observations[name] = await operation(); }
      catch (error) { observations[name] = { error: String(error) }; }
    }
    // Preserve each discovery path before any selection or recovery gesture.
    await observe("xml", async () => {
      const file = `${stage}.xml`;
      fs.writeFileSync(path.join(directory, file), await browser.getPageSource());
      return file;
    });
    await observe("description", async () => {
      const file = `${stage}.txt`;
      const source = await browser.execute("macos: source", { format: "description" });
      fs.writeFileSync(path.join(directory, file), String(source));
      return file;
    });
    await observe("screenshot", async () => {
      const file = `${stage}.png`;
      await browser.saveScreenshot(path.join(directory, file));
      return file;
    });
    const queries = {
      nativePdf: `-ios predicate string:elementType == 48 AND value == '${pdfName}'`,
      xpathPdf: `//XCUIElementTypeStaticText[@value='${pdfName}']`,
      focused: "-ios predicate string:amHasKeyboardInputFocus == true",
    };
    for (const [name, selector] of Object.entries(queries)) {
      await observe(name, async () => {
        const elements = await browser.$$(selector);
        const matches = [];
        for (const element of elements) {
          if (matches.length === 12) break;
          const attributes: Record<string, unknown> = { id: element.elementId };
          for (const attribute of ["elementType", "value", "label", "title", "selected", "enabled", "hittable"]) {
            try { attributes[attribute] = await element.getAttribute(attribute); }
            catch (error) { attributes[attribute] = { error: String(error) }; }
          }
          try { attributes.rect = { ...await element.getLocation(), ...await element.getSize() }; }
          catch (error) { attributes.rect = { error: String(error) }; }
          matches.push(attributes);
        }
        return { count: elements.length, matches };
      });
    }
    await observe("rows", async () => (await browser.$$("XCUIElementTypeTableRow")).length);
    await observe("cells", async () => (await browser.$$("XCUIElementTypeCell")).length);
    await observe("tablePdf", async () => {
      const table = await browser.$("-ios predicate string:elementType == 26 AND label == 'Files'");
      return (await table.$$(queries.nativePdf)).length;
    });
    await observe("paletteInputs", async () => (await browser.$$("-ios predicate string:placeholderValue == 'Type a command...'")).length);
    fs.writeFileSync(path.join(directory, `${stage}.json`), `${JSON.stringify(observations, null, 2)}\n`);
    record(stage, observations);
  }
  async function command(label: string, diagnose = false) {
    if (diagnose) await accessibilityProbe("ax-01-before-palette");
    await key("p", (1 << 4) | (1 << 1));
    const input = await browser.$("-ios predicate string:placeholderValue == 'Type a command...'");
    await input.waitForDisplayed({ timeout: 15_000 });
    if (diagnose) await accessibilityProbe("ax-02-palette-open");
    await browser.execute("macos: keys", { keys: Array.from(label), elementId: input.elementId });
    // WKWebView exposes the selected option as one flattened accessibility
    // row: its title includes the category and optional shortcut.
    const result = await browser.$(`-ios predicate string:elementType == 48 AND selected == true AND (title == 'VIEW ${label}' OR title BEGINSWITH 'VIEW ${label} ')`);
    await result.waitForDisplayed({ timeout: 15_000 });
    if (diagnose) await accessibilityProbe("ax-03-before-result-click");
    await result.click();
    await input.waitForExist({ reverse: true, timeout: 15_000 });
    if (diagnose) await accessibilityProbe("ax-04-palette-closed");
  }
  async function select(name: string) {
    const names = new Set(fs.readdirSync(fixture));
    assert(names.size === 5 && names.has(name) && fs.statSync(path.join(fixture, "child")).isDirectory(),
      "native selection requires the unchanged five-entry fixture");
    const table = () => browser.$("-ios predicate string:elementType == 26 AND label == 'Files'");
    async function selected() {
      const collection = await table();
      const cell = await collection.$("-ios predicate string:elementType == 75 AND selected == true");
      const labels = await cell.$$("-ios predicate string:elementType == 48");
      const matches: string[] = [];
      for (const label of labels) {
        const value = await label.getAttribute("value");
        if (value && names.has(value)) matches.push(value);
      }
      assert(matches.length === 1, "selected native Files cell does not identify exactly one fixture entry");
      return { name: matches[0], cell };
    }
    // Closing the palette can leave XCTest exposing only the selected row,
    // despite all five rows remaining visible. Own collection focus and use
    // real keyboard navigation; no coordinates or debounced typeahead.
    const initial = await selected();
    await initial.cell.click();
    await browser.waitUntil(async () => (await (await table()).$(
      "-ios predicate string:elementType == 75 AND amHasKeyboardInputFocus == true")).isExisting(),
    { timeout: 15_000, timeoutMsg: "native file collection did not acquire keyboard focus" });
    await key("XCUIKeyboardKeyHome", 1 << 2);
    await browser.waitUntil(async () => (await selected()).name === "child",
      { timeout: 15_000, timeoutMsg: "native Control+Home did not select the first fixture entry" });
    for (let index = 0; index < names.size; index++) {
      const current = await selected();
      record("native-file-selection", { requested: name, index, selected: current.name });
      if (current.name === name) return;
      if (index + 1 === names.size) break;
      // Send each key once, then acknowledge its outcome before advancing.
      await key("XCUIKeyboardKeyDownArrow");
      await browser.waitUntil(async () => (await selected()).name !== current.name,
        { timeout: 15_000, timeoutMsg: `native Down did not advance selection from ${current.name}` });
    }
    throw new Error(`native keyboard selection did not reach ${name}`);
  }
  async function viewport(page: number) {
    const element = await browser.$(`-ios predicate string:label == '${pdfName}, PDF page ${page}'`);
    await element.waitForDisplayed({ timeout: 30_000 });
    return rect(element);
  }
  async function capture(name: string, region: Rect, color: readonly number[], allowAbsent = false): Promise<Landmark | null> {
    const file = path.join(directory, `${name}.png`);
    // Mac2 4.2.0 returns a dictionary keyed by display ID. Its published
    // execute-method documentation incorrectly describes this as an array.
    const screens = await browser.execute("macos: screenshots", { displayId: display.id }) as unknown as
      Record<string, { id: number; isMain: boolean; payload: string | null }>;
    const screen = screens[String(display.id)];
    assert(!!screen && Number(screen.id) === display.id && screen.isMain === true &&
      typeof screen.payload === "string" && screen.payload.length > 0,
      "Mac2 did not return pixels for the measured main display");
    fs.writeFileSync(file, Buffer.from(screen!.payload!, "base64"));
    const request = JSON.stringify({ display, viewport: region, color, allowAbsent });
    return JSON.parse(execFileSync(process.env.PDF_SCREENSHOT_PYTHON ?? "python3",
      ["e2e-tauri/pdf_screenshot.py", file, request], { encoding: "utf8" })) as Landmark | null;
  }
  async function rendered(name: string, page: number, validate?: (result: { viewport: Rect; landmark: Landmark }) => void): Promise<{ viewport: Rect; landmark: Landmark }> {
    let result: { viewport: Rect; landmark: Landmark } | undefined;
    let lastError = "";
    await browser.waitUntil(async () => {
      try {
        const region = await viewport(page);
        const landmark = await capture(name, region, COLORS[page - 1]);
        if (!landmark) throw new Error("required PDF landmark is absent");
        result = { viewport: region, landmark };
        validate?.(result);
        return true;
      } catch (error) { lastError = String(error); return false; }
    }, { timeout: 30_000, interval: 1000, timeoutMsg: `native pixels did not show expected PDF page ${page}` })
      .catch(error => { throw new Error(`${String(error)}; last observation: ${lastError}`); });
    fs.writeFileSync(path.join(directory, `${name}.xml`), await browser.getPageSource());
    record(name, result);
    return result!;
  }
  function centered(result: { viewport: Rect; landmark: Landmark }) {
    near(result.landmark.cx, result.viewport.x + result.viewport.width / 2, 3, "PDF horizontal center");
    near(result.landmark.cy, result.viewport.y + result.viewport.height / 2, 3, "PDF vertical center");
  }
  function fitted(result: { viewport: Rect; landmark: Landmark }, page: number, appZoom = 1) {
    centered(result);
    const [width, height] = PAGE_SIZES[page - 1];
    // The fixture's center square is exactly 70 PDF points. Infer page size
    // from its observed pixels, allowing two raster edge pixels per square.
    const scale = result.landmark.width / 70;
    const edgeTolerance = 2 / result.landmark.pixelScale;
    const expectedScale = Math.min((result.viewport.width - 32 * appZoom) / width,
      (result.viewport.height - 32 * appZoom) / height);
    near(result.landmark.width, 70 * expectedScale, edgeTolerance, "native fitted landmark width");
    near(result.landmark.height, 70 * expectedScale, edgeTolerance, "native fitted landmark height");
    assert(width * Math.max(0, scale - edgeTolerance / 70) <= result.viewport.width &&
      height * Math.max(0, scale - edgeTolerance / 70) <= result.viewport.height, "fitted PDF extends outside its viewport");
  }
  async function zoom(percent: number) {
    await (await button("Fit")).click();
    for (let value = 100; value < percent; value += 10) await (await button("Zoom PDF in")).click();
    await (await textElement(`${percent}%`)).waitForDisplayed({ timeout: 15_000 });
  }
  try {
    await command("Reset Zoom", true);
    await select(pdfName);
    await command("Dock Preview Pane Right");
    const fit = await rendered("01-fit-page-1", 1, result => fitted(result, 1));
    await zoom(130);
    const enlarged = await rendered("02-centered-130-percent", 1);
    centered(enlarged);
    near(enlarged.landmark.width, fit.landmark.width * 1.3, 3 / fit.landmark.pixelScale, "native PDF magnification");
    assert(enlarged.landmark.width > fit.landmark.width + 2, "native zoom did not enlarge PDF pixels");
    for (const page of [2, 3]) {
      await (await button("Next PDF page")).click();
      await rendered(`03-page-${page}`, page, result => fitted(result, page));
    }
    assert(!(await (await button("Next PDF page")).isEnabled()), "next page remains enabled at final page");
    await (await button("Previous PDF page")).click();
    await rendered("04-returned-page-2", 2, result => fitted(result, 2));
    await (await button("Previous PDF page")).click();
    await rendered("04-returned-page-1", 1);
    await zoom(400);
    const before = await rendered("05-before-pan-400-percent", 1, result => {
      centered(result);
      near(result.landmark.width, fit.landmark.width * 4, 5 / fit.landmark.pixelScale, "400% PDF pixels");
    });
    centered(before);
    await browser.execute("macos: clickAndDrag", {
      startX: before.landmark.cx, startY: before.landmark.cy,
      endX: before.landmark.cx - 40, endY: before.landmark.cy - 30, duration: 0.2,
    });
    const after = await rendered("06-after-native-pan", 1);
    near(after.landmark.cx - before.landmark.cx, -40, 4, "trusted native horizontal pan");
    near(after.landmark.cy - before.landmark.cy, -30, 4, "trusted native vertical pan");
    assert(await (await button("View PDF fullscreen")).isDisplayed(), "drag unexpectedly entered fullscreen");
    await (await button("Fit")).click();
    fitted(await rendered("07-reset-fit", 1), 1);
    await (await button("View PDF fullscreen")).click();
    const fullscreen = await rendered("08-fullscreen", 1);
    fitted(fullscreen, 1);
    assert(fullscreen.viewport.width > fit.viewport.width * 1.5, "fullscreen did not expand native PDF viewport");
    await (await button("Exit PDF fullscreen")).click();
    fitted(await rendered("09-exit-fullscreen", 1), 1);

    const window = await browser.$("//XCUIElementTypeWindow[1]");
    const restore = await button("Restore");
    if (await restore.isDisplayed()) {
      await restore.click();
      await (await button("Maximize")).waitForDisplayed({ timeout: 15_000 });
    }
    const large = await rect(window);
    assert(large.x >= display.x && large.y >= display.y &&
      large.x + large.width <= display.x + display.width && large.y + large.height <= display.y + display.height,
      "restored owned Mac window extends outside the measured display");
    await browser.execute("macos: clickAndDrag", {
      startX: large.x + large.width - 2, startY: large.y + large.height - 2,
      // Keep the window substantially smaller while leaving enough solid
      // landmark pixels for the independent screenshot presence check.
      endX: large.x + large.width - 202, endY: large.y + large.height - 62, duration: 0.3,
    });
    await browser.waitUntil(async () => {
      const current = await rect(window);
      return current.width < large.width - 100 && current.height < large.height - 50;
    }, { timeout: 15_000, timeoutMsg: "owned Mac window did not become narrower and shorter" });
    const narrow = await rect(window);
    // Responsive navigation hides its buttons in a narrow pane. The fixture
    // retains the fixed-size New Tab control under the normal root CSS zoom.
    const anchor100 = await rect(await button("New tab"));
    await command("Zoom In");
    const anchor110 = await rect(await button("New tab"));
    for (let count = 0; count < 4; count++) await command("Zoom In");
    const anchor150 = await rect(await button("New tab"));
    near(anchor150.width / anchor100.width, 1.5, 0.08, "actual application zoom from 100% to 150%");
    near(anchor150.width / anchor110.width, 150 / 110, 0.08, "actual application 150% magnification");
    near(anchor150.height / anchor100.height, 1.5, 0.08, "actual application vertical zoom from 100% to 150%");
    record("narrow-native-window-and-app-zoom", { large, narrow, anchor: "New tab", anchor110, anchor150, anchor100 });
    for (const dock of ["Right", "Top", "Bottom"]) {
      await command(`Dock Preview Pane ${dock}`);
      const result = await rendered(`10-narrow-150-${dock.toLowerCase()}`, 1, result => fitted(result, 1, 1.5));
      assert(result.viewport.width < fit.viewport.width || result.viewport.height < fit.viewport.height,
        "narrow dock did not reduce PDF viewport");
      for (const label of ["Previous PDF page", "Next PDF page", "Zoom PDF out", "Zoom PDF in", "Fit", "View PDF fullscreen"]) {
        const bounds = await rect(await button(label));
        assert(bounds.width >= 20 && bounds.height >= 20 && bounds.x >= narrow.x && bounds.y >= narrow.y &&
          bounds.x + bounds.width <= narrow.x + narrow.width + 1 && bounds.y + bounds.height <= narrow.y + narrow.height + 1,
        `${dock} PDF control ${label} is clipped or too small`);
        record(`${dock}-control-${label}`, bounds);
      }
      const content = await rect(await browser.$("-ios predicate string:label == 'file browser pane'"));
      const region = result.viewport;
      if (dock === "Right") assert(region.x > content.x + content.width / 2, "Right dock is not on the right");
      if (dock === "Top") assert(region.y < content.y + content.height / 2, "Top dock is not above the list");
      if (dock === "Bottom") assert(region.y > content.y + content.height / 2, "Bottom dock is not below the list");
      await (await button("Next PDF page")).click();
      await rendered(`11-narrow-${dock.toLowerCase()}-page-2`, 2, result => fitted(result, 2, 1.5));
      await (await button("Previous PDF page")).click();
      await rendered(`11-narrow-${dock.toLowerCase()}-returned-page-1`, 1, result => fitted(result, 1, 1.5));
    }
    await command("Reset Zoom");
    await command("Dock Preview Pane Right");
    await select(badName);
    await (await browser.$(`-ios predicate string:label == 'Preview of ${badName}'`)).waitForDisplayed({ timeout: 30_000 });
    const errorElement = await browser.$("-ios predicate string:elementType == 48 AND value BEGINSWITH 'Cannot preview PDF:'");
    await errorElement.waitForDisplayed({ timeout: 30_000 });
    const badViewport = await rect(await browser.$(`-ios predicate string:label == '${badName}, PDF page 1'`));
    assert(await capture("12-corrupt-pdf-no-old-landmark", badViewport, COLORS[0], true) === null,
      "corrupt PDF retained previously rendered red page");
    await browser.saveScreenshot(path.join(directory, "12-corrupt-pdf.png"));
    fs.writeFileSync(path.join(directory, "12-corrupt-pdf.xml"), await browser.getPageSource());
    record("corrupt-pdf-visible-error", true);
    await select(imageName);
    const image = await browser.$(`-ios predicate string:label == 'Preview of ${imageName}'`);
    await image.waitForDisplayed({ timeout: 30_000 });
    let replacement: Landmark | undefined;
    await browser.waitUntil(async () => {
      try {
        const region = await rect(image);
        const pixels = await capture("13-real-image-replacement", region, [0, 0, 255]);
        if (!pixels) return false;
        near(pixels.width / pixels.height, 1.5, 0.03, "native replacement image aspect");
        assert(pixels.width >= Math.min(100, region.width * 0.5) && pixels.height >= Math.min(60, region.height * 0.5),
          "native replacement image is not substantive");
        assert(!(await (await button("Next PDF page")).isExisting()), "image replacement retained PDF controls");
        replacement = pixels;
        return true;
      }
      catch { return false; }
    }, { timeout: 30_000, timeoutMsg: "native image replacement did not render blue pixels" });
    record("real-image-replacement", replacement);
    await select(pdfName);
    fitted(await rendered("14-pdf-after-replacement", 1), 1);
    assert(hash(pdf) === originalHash, "native preview changed the source PDF");
    record("source-pdf-unchanged", hash(pdf));
    report.passed = true;
  } catch (error) {
    report.error = String(error);
    try { fs.writeFileSync(path.join(directory, "failure.xml"), await browser.getPageSource()); } catch { /* retain earlier evidence */ }
    try { await browser.saveScreenshot(path.join(directory, "failure.png")); } catch { /* retain earlier evidence */ }
    throw error;
  } finally { save(); }
}
