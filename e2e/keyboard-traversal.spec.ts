/**
 * Keyboard traversal (#797): every main region is reachable and operable with
 * the keyboard alone, and every focused control draws a visible indicator in
 * every built-in theme.
 *
 * Tab and Shift+Tab walk one cycle of the window, in document order, with no
 * keyboard trap. The terminal is the exception: it owns Tab while focused
 * (domain/terminal-keys.ts), so it is entered and left through its toggle
 * chord.
 *
 * An indicator is an outline or a box-shadow ring on the focused element. It
 * must have at least 3:1 contrast against every adjacent surface (WCAG
 * 1.4.11 / 2.4.11): the element fill, the surface behind it, and any border
 * crossed by an inset ring. The UA's `outline: auto` ring is rejected because
 * its colour and shape are engine-defined, not themed.
 */
import { test, expect, type Page } from "./fixtures";
import {
  ALL_VIEW_MODES,
  BUILT_IN_THEMES as THEMES,
  HOME_URL,
  waitForEntries,
  type ViewMode,
} from "./helpers";

/**
 * Main regions in the order Tab must reach them. The status bar holds the
 * file-recovery notice, which the mock always shows.
 */
const REGIONS = ["tabs", "sidebar", "address-bar", "file-list", "preview", "status"] as const;
type Region = (typeof REGIONS)[number] | "pane" | "terminal" | "other";

const MIN_INDICATOR_CONTRAST = 3;
/** Upper bound on one Tab cycle; a trap never returns to the first stop. */
const MAX_STOPS = 150;

interface Stop {
  /** Structural path of the focused element; stable across a cycle. */
  id: string;
  region: Region;
  label: string;
}

interface Indicator {
  kind: "outline" | "box-shadow" | "auto" | "none";
  width: number;
  /** Contrast of the ring against the colour it is drawn over. */
  contrast: number;
  /** What cuts part of the ring off, if anything: a scroller or the window. */
  clipped: string | null;
  ring: string;
  backdrop: string;
}

async function openWindow(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((stored) => {
    if (!sessionStorage.getItem("keyboard-traversal-seeded")) {
      localStorage.clear();
      localStorage.setItem("explorer-settings", JSON.stringify(stored));
      sessionStorage.setItem("keyboard-traversal-seeded", "1");
    }
  }, { showPreviewPane: true, ...settings });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  // The status bar's recovery notice arrives with its own subscription.
  await expect(page.getByTestId("file-recovery-notice")).toBeVisible();
  // Start from the document so the walk begins at the top of the window.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The focused element as a stop, or null while focus is on the document. */
function focusedStop(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const regionOf = (node: HTMLElement): string => {
      if (node.closest(".terminal-panel")) return "terminal";
      if (node.closest(".titlebar")) return "tabs";
      if (node.closest(".sidebar-container")) return "sidebar";
      if (node.closest(".navigation-bar")) return "address-bar";
      if (node.closest(".file-list")) return "file-list";
      if (node.closest(".preview-pane")) return "preview";
      if (node.closest(".status-bar")) return "status";
      if (node.matches(".explorer-pane")) return "pane";
      return "other";
    };
    const path: string[] = [];
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const index = node.parentElement ? [...node.parentElement.children].indexOf(node) : 0;
      path.unshift(`${node.tagName.toLowerCase()}${index}`);
    }
    const label = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
    return { id: path.join("/"), region: regionOf(el) as Region, label };
  });
}

/** Press `key` until focus lands on an element (skipping the document stop). */
async function step(page: Page, key: "Tab" | "Shift+Tab"): Promise<Stop> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press(key);
    const stop = await focusedStop(page);
    if (stop) return stop;
  }
  throw new Error(`${key} left focus on the document three times in a row`);
}

/** One full forward cycle, starting from the first stop after the document. */
async function tabCycle(page: Page): Promise<Stop[]> {
  const first = await step(page, "Tab");
  const stops = [first];
  for (let i = 0; i < MAX_STOPS; i++) {
    const stop = await step(page, "Tab");
    if (stop.id === first.id) return stops;
    stops.push(stop);
  }
  throw new Error(`Tab never returned to ${first.label}: focus is trapped near ${stops[stops.length - 1]?.label}`);
}

/**
 * Region runs in visiting order, collapsing consecutive stops in one region.
 * The cycle is rotated to start at the title bar: where a blurred document
 * resumes sequential navigation is engine-defined.
 */
function regionRuns(stops: Stop[]): Region[] {
  const start = Math.max(0, stops.findIndex((s) => s.region === "tabs"));
  const rotated = [...stops.slice(start), ...stops.slice(0, start)];
  return rotated.map((s) => s.region).filter((region, i, all) => region !== all[i - 1]);
}

/** Measure the focused element's indicator against the colour beneath it. */
function focusIndicator(page: Page): Promise<Indicator> {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba | null => {
      const match = value.match(/(rgba?|color)\(([^)]+)\)/);
      if (!match) return null;
      const channels = match[2].replace(/^srgb\s+/, "").split(/[\s,/]+/).filter(Boolean).map(Number);
      if (channels.length < 3 || channels.some(Number.isNaN)) return null;
      const scale = match[1] === "color" ? 255 : 1;
      return [channels[0] * scale, channels[1] * scale, channels[2] * scale, channels[3] ?? 1];
    };
    const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba =>
      [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
    // The opaque colour an element's background composites to, from the
    // element up through its ancestors to the window surface.
    const surface = (from: Element | null): Rgba => {
      const layers: Rgba[] = [];
      for (let node = from; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color[3] > 0) {
          layers.push(color);
          if (color[3] >= 1) break;
        }
      }
      const root = getComputedStyle(document.documentElement).getPropertyValue("--background-solid").trim();
      const probe = document.createElement("div");
      probe.style.color = root || "#ffffff";
      document.body.append(probe);
      const base = parse(getComputedStyle(probe).color) ?? [255, 255, 255, 1];
      probe.remove();
      return layers.reverse().reduce((below, layer) => over(layer, below), base);
    };
    const luminance = ([r, g, b]: Rgba) => {
      const c = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    };
    const contrast = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const fmt = ([r, g, b]: Rgba) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const outlineWidth = parseFloat(style.outlineWidth) || 0;
    if (style.outlineStyle === "auto") {
      return { kind: "auto", width: outlineWidth, contrast: 0, clipped: null, ring: style.outlineColor, backdrop: "" };
    }
    let ring: Rgba | null = null;
    let width = 0;
    let inset = false;
    let reach = 0;
    let kind: "outline" | "box-shadow" | "none" = "none";
    if (style.outlineStyle !== "none" && outlineWidth > 0) {
      ring = parse(style.outlineColor);
      width = outlineWidth;
      const offset = parseFloat(style.outlineOffset) || 0;
      inset = offset < 0;
      reach = Math.max(0, offset + outlineWidth);
      kind = "outline";
    } else if (style.boxShadow !== "none") {
      // A ring is a shadow with no blur and a positive spread.
      for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
        const color = parse(shadow);
        const lengths = shadow.replace(/(rgba?|color)\([^)]*\)/, "").match(/-?[\d.]+px/g)?.map(parseFloat) ?? [];
        const [, , blur = 0, spread = 0] = lengths;
        if (color && color[3] > 0 && blur === 0 && spread > 0) {
          ring = color;
          width = spread;
          inset = /\binset\b/.test(shadow);
          reach = inset ? 0 : spread;
          kind = "box-shadow";
          break;
        }
      }
    }
    if (!ring) return { kind: "none", width: 0, contrast: 0, clipped: null, ring: "", backdrop: "" };
    // The ring's outer edge, checked against every clipping ancestor's padding
    // box and the window, along each axis that clips.
    const box = el.getBoundingClientRect();
    const edge = { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach };
    const slack = 0.5;
    const box4 = (r: { left: number; top: number; right: number; bottom: number }) =>
      [r.left, r.top, r.right, r.bottom].map((v) => v.toFixed(1)).join(",");
    // Sides of the ring cut off by the window or a clipping ancestor's padding
    // box. One cut side is allowed: an element wider than its scroller (a
    // details row under horizontal scrolling) keeps three visible sides.
    const cut = new Set<string>();
    const cutters: string[] = [];
    const cutBy = (name: string, clip: { left: number; top: number; right: number; bottom: number }, x: boolean, y: boolean) => {
      const sides = [
        x && edge.left < clip.left - slack && "left", x && edge.right > clip.right + slack && "right",
        y && edge.top < clip.top - slack && "top", y && edge.bottom > clip.bottom + slack && "bottom",
      ].filter((side): side is string => !!side);
      if (sides.length === 0) return;
      sides.forEach((side) => cut.add(side));
      cutters.push(`${name} ${box4(clip)} cuts ${sides.join("+")}`);
    };
    cutBy("window", { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, true, true);
    // The root and body are skipped: the body is absolutely positioned, so
    // the root's box is empty, and the window check covers both.
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const rect = node.getBoundingClientRect();
      const border = (side: string) => parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0;
      cutBy(`.${node.classList[0] ?? node.tagName.toLowerCase()}`, {
        left: rect.left + border("left"), top: rect.top + border("top"),
        right: rect.right - border("right"), bottom: rect.bottom - border("bottom"),
      }, cs.overflowX !== "visible", cs.overflowY !== "visible");
    }
    const clipped = cut.size >= 2 ? `${cutters.join("; ")} (ring ${box4(edge)})` : null;
    const parentSurface = surface(el.parentElement);
    const elementSurface = surface(el);
    const adjacent = [parentSurface, elementSurface];
    if (inset && kind === "outline") {
      // A negative-offset outline crosses the border edge. Include every
      // border colour that remains exposed inside it. A border no wider than
      // the inset depth is fully painted over and is not adjacent to the ring.
      const coveredBorderDepth = Math.max(0, -(parseFloat(style.outlineOffset) || 0));
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const borderWidth = parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
        const borderColor = parse(style.getPropertyValue(`border-${side}-color`));
        if (borderWidth > coveredBorderDepth && borderColor && borderColor[3] > 0) {
          const paintedBorder = over(borderColor, parentSurface);
          // A same-colour exposed strip is a contiguous extension of the
          // indicator, not a separate adjacent surface.
          if (contrast(over(ring, paintedBorder), paintedBorder) > 1.01) adjacent.push(paintedBorder);
        }
      }
    }
    const comparisons = adjacent.map((backdrop) => {
      const drawn = over(ring!, backdrop);
      return { contrast: contrast(drawn, backdrop), ring: fmt(drawn), backdrop: fmt(backdrop) };
    });
    const weakest = comparisons.reduce((minimum, candidate) => candidate.contrast < minimum.contrast ? candidate : minimum);
    return { kind, width, contrast: weakest.contrast, clipped, ring: weakest.ring, backdrop: weakest.backdrop };
  });
}

async function tabToEntry(page: Page): Promise<string | null> {
  const focusedPath = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return el.matches(".file-list .entry-item") ? el.dataset.path ?? null : null;
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < MAX_STOPS && !(await focusedPath()); i++) await step(page, "Tab");
  return await focusedPath();
}

async function reloadInView(page: Page, viewMode: ViewMode): Promise<void> {
  await page.evaluate((mode) => {
    const raw = localStorage.getItem("explorer-settings");
    const settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    localStorage.setItem("explorer-settings", JSON.stringify({ ...settings, viewMode: mode }));
  }, viewMode);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await expect(page.getByTestId("file-recovery-notice")).toBeVisible();
}

test.describe("Keyboard traversal", () => {
  test("Tab reaches every main region in document order and cycles back", async ({ page }) => {
    await openWindow(page);
    const stops = await tabCycle(page);
    const runs = regionRuns(stops).filter((region) => (REGIONS as readonly string[]).includes(region));
    // Each region is one contiguous run, visited in layout order.
    expect(runs).toEqual([...REGIONS]);
    expect(stops.filter((s) => s.region === "other"), "stops outside every region").toEqual([]);
  });

  test("Shift+Tab walks the same cycle in reverse", async ({ page }) => {
    await openWindow(page);
    const forward = await tabCycle(page);
    // tabCycle ends with focus back on the first stop.
    const backward: Stop[] = [];
    for (let i = 0; i < forward.length - 1; i++) backward.push(await step(page, "Shift+Tab"));
    expect(backward.map((s) => s.label)).toEqual(forward.slice(1).reverse().map((s) => s.label));
    expect(backward.map((s) => s.id)).toEqual(forward.slice(1).reverse().map((s) => s.id));
  });

  test("Enter on a sidebar location navigates to it", async ({ page }) => {
    await openWindow(page);
    let stop = await step(page, "Tab");
    for (let i = 0; i < MAX_STOPS && !(stop.region === "sidebar" && stop.label === "Documents"); i++) {
      stop = await step(page, "Tab");
    }
    expect(stop.label).toBe("Documents");
    await page.keyboard.press("Enter");
    await expect(page.locator(".explorer-pane .crumb.current")).toHaveText("Documents");
  });

  test("the address bar opens from the keyboard and filters its suggestions as you type", async ({ page }) => {
    await openWindow(page);
    let stop = await step(page, "Tab");
    for (let i = 0; i < MAX_STOPS && stop.region !== "address-bar"; i++) stop = await step(page, "Tab");
    expect(stop.region).toBe("address-bar");
    await page.keyboard.press("Control+l");
    const input = page.locator(".explorer-pane .navigation-bar input");
    await expect(input).toBeFocused();
    await input.fill("/home/user/Do");
    const suggestions = page.locator(".explorer-pane .suggestion-item");
    await expect(suggestions).toHaveText([/Documents/, /Downloads/]);
    await input.fill("/home/user/Vi");
    await expect(suggestions).toHaveText([/Videos/]);
    // Enter first applies the pre-selected suggestion, then confirms the path.
    // Videos has no subfolders, so no new suggestion is pre-selected between
    // the two presses (a folder with subfolders would descend instead).
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("/home/user/Videos/");
    await page.keyboard.press("Enter");
    await expect(page.locator(".explorer-pane .crumb.current")).toHaveText("Videos");
  });

  for (const viewMode of ALL_VIEW_MODES) {
    test(`arrow keys move the ${viewMode} file-list selection once Tab reaches it`, async ({ page }) => {
      await openWindow(page, { viewMode });
      // The file list keeps one roving Tab stop among its entries: the cursor,
      // or the first entry before anything has been selected.
      expect(await tabToEntry(page)).toBe("/home/user/Archive");
      await page.keyboard.press("ArrowDown");
      const focusedPath = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return el.matches(".file-list .entry-item") ? el.dataset.path ?? null : null;
      });
      await expect.poll(focusedPath).not.toBe("/home/user/Archive");
      const moved = await focusedPath();
      expect(moved).toBeTruthy();
      await expect(page.locator(`.explorer-pane .entry-item[data-path="${moved}"]`))
        .toHaveAttribute("aria-selected", "true");
    });
  }

  test("the preview content is a Tab stop that scrolls from the keyboard", async ({ page }) => {
    // A short bottom dock makes the markdown preview overflow its region.
    await openWindow(page, { previewPanePosition: "bottom", previewPaneHeight: 160 });
    await page.locator(".explorer-pane .entry-item", { hasText: "notes.md" }).click();
    const region = page.getByRole("region", { name: "Preview of notes.md" });
    await expect(region.locator(".preview-markdown")).toBeVisible();
    expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    let stop = await step(page, "Tab");
    for (let i = 0; i < MAX_STOPS && stop.label !== "Preview of notes.md"; i++) stop = await step(page, "Tab");
    await expect(region).toBeFocused();
    await page.keyboard.press("PageDown");
    await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The file list keeps its selection: the preview owns its own keys.
    await expect(page.locator('.explorer-pane .entry-item[aria-selected="true"]')).toContainText("notes.md");
  });

  test("the terminal is entered and left with its toggle chord", async ({ page }) => {
    // Typed input reaching a real PTY through this chord is covered natively
    // by e2e-tauri/specs/terminal-input-order.spec.ts; the browser mock cannot
    // spawn a terminal session.
    await openWindow(page);
    await page.locator(".explorer-pane .entry-item").first().click();
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("textarea.xterm-helper-textarea")).toBeFocused();
    // xterm marks its focused state, which draws the solid cursor.
    await expect(panel.locator(".xterm")).toHaveClass(/\bfocus\b/);
    // The terminal owns Tab: it must not move focus out of the panel.
    await page.keyboard.press("Tab");
    expect((await focusedStop(page))?.region).toBe("terminal");
    await page.keyboard.press("Control+`");
    await expect(panel).toBeHidden();
    // Hiding the panel releases focus (the engine moves it off the hidden
    // input on its next update), and the file list takes the keyboard back.
    await expect.poll(async () => (await focusedStop(page))?.region ?? "document").not.toBe("terminal");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('.explorer-pane .entry-item[aria-selected="true"]')).toHaveAttribute("data-path", "/home/user/Documents");
  });
});

test.describe("Focus indicators", () => {
  // Each case measures every stop of a full Tab cycle.
  test.describe.configure({ timeout: 60_000 });
  for (const premium of [false, true]) {
    for (const theme of THEMES) {
      test(`every Tab stop shows a visible ring in ${theme}${premium ? " (premium)" : ""}`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openWindow(page, { theme, premiumTheme: premium });
        if (premium) await expect(page.locator("html")).toHaveAttribute("data-premium", "true");
        const failures: string[] = [];
        const first = await step(page, "Tab");
        let stop = first;
        let completedCycle = false;
        for (let i = 0; i < MAX_STOPS; i++) {
          const indicator = await focusIndicator(page);
          if (indicator.kind === "none" || indicator.kind === "auto" || indicator.clipped
            || indicator.contrast < MIN_INDICATOR_CONTRAST) {
            failures.push(`${stop.region} "${stop.label}": ${indicator.kind}${indicator.clipped ? ` clipped by ${indicator.clipped}` : ""} `
              + `${indicator.ring} on ${indicator.backdrop} = ${indicator.contrast.toFixed(2)}:1`);
          }
          stop = await step(page, "Tab");
          if (stop.id === first.id) {
            completedCycle = true;
            break;
          }
        }
        expect(completedCycle, "focus did not complete one Tab cycle").toBe(true);

        // List and Tiles are separate virtualized renderers with their own
        // focus CSS. Exercise their roving stop in every theme as well.
        for (const viewMode of ALL_VIEW_MODES.filter((mode): mode is Exclude<ViewMode, "details"> => mode !== "details")) {
          await reloadInView(page, viewMode);
          expect(await tabToEntry(page), `${viewMode} did not expose a roving entry Tab stop`).toBeTruthy();
          const indicator = await focusIndicator(page);
          if (indicator.kind === "none" || indicator.kind === "auto" || indicator.clipped
            || indicator.contrast < MIN_INDICATOR_CONTRAST) {
            failures.push(`${viewMode} entry: ${indicator.kind}${indicator.clipped ? ` clipped by ${indicator.clipped}` : ""} `
              + `${indicator.ring} on ${indicator.backdrop} = ${indicator.contrast.toFixed(2)}:1`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }
});
