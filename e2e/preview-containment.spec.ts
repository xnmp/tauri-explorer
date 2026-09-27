/**
 * E2E: every preview format stays inside its pane in a narrow split at 80,
 * 100 and 150 % UI zoom, in each dock position, at the default and the
 * minimum dock size, and in a narrow window (#792). So do the SCM diff and
 * the git-graph comparison routed through the preview.
 *
 * "Inside" is reachability, not clipping: the preview pane clips with
 * `overflow: hidden`, so content that spills past its region would silently
 * disappear. Anything wider or taller than its region (header, diff actions,
 * content, info) or than a clipping ancestor must sit inside a scroll container that is
 * itself reachable, or be inline text truncated with a visible ellipsis. The
 * page itself must never scroll horizontally, the content region must keep a
 * usable height, the file name and metadata a usable width, and every
 * explorer pane a usable file-list region.
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, waitForEntries, type ViewMode } from "./helpers";

const DIR = "/home/preview-containment";
const LONG_NAME =
  "an-exceptionally-long-file-name-that-must-truncate-inside-the-preview-header-instead-of-widening-the-pane.txt";
const LONG_CHILD =
  "a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated.log";
/** A repository-relative path far wider than a diff's metadata column. */
const LONG_DIFF_PATH = "src/main/java/com/example/project/service/impl/UserAccountServiceImplementation.java";
const ZOOMS = [80, 100, 150] as const;
const DOCKS = ["right", "bottom", "top"] as const;
type Dock = (typeof DOCKS)[number];
/** The default dock size and the smallest the resize bounds allow (settings-numbers.ts). */
const SIZES = {
  default: { previewPaneWidth: 0, previewPaneHeight: 0 },
  minimum: { previewPaneWidth: 160, previewPaneHeight: 120 },
} as const;
type Size = keyof typeof SIZES;
/** The default window, and narrower ones where a vertical dock is at its narrowest. */
const VIEWPORTS = {
  wide: { width: 1100, height: 720 },
  medium: { width: 900, height: 720 },
  narrow: { width: 800, height: 720 },
} as const;
type Viewport = keyof typeof VIEWPORTS;
/** Narrowest region, in CSS pixels, that still shows a readable name or value. */
const MIN_USABLE_WIDTH = 96;
/** Lowest content region, in CSS pixels, that still shows two lines of a preview. */
const MIN_CONTENT_HEIGHT = 40;

interface Format {
  name: string;
  /** Resolves once the format's own content (not a spinner) has rendered. */
  rendered: (page: Page) => Promise<void>;
}

const pane = (page: Page) => page.locator(".preview-pane");

/** The root UI zoom factor: element rects are zoomed, layout sizes are not. */
const appZoom = (page: Page) =>
  page.evaluate(
    () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-zoom")) || 1,
  );

const FORMATS: readonly Format[] = [
  {
    name: "long-line.ts",
    rendered: (page) => expect(pane(page).locator(".preview-code")).toContainText("export const unbroken"),
  },
  {
    name: "unbroken.txt",
    rendered: (page) => expect(pane(page).locator(".preview-text")).toContainText("xxxxxxxx"),
  },
  {
    name: "wide.md",
    rendered: async (page) => {
      await expect(pane(page).locator(".preview-markdown h1")).toContainText("Heading");
      await expect(pane(page).locator(".preview-markdown table td").first()).toHaveText("cell value 1");
      await expect(pane(page).locator(".preview-markdown pre.md-code")).toContainText("const wide");
      // A property value keeps a readable column instead of a few characters
      // per line: either a usable width, or (in a pane too narrow for that)
      // nearly the whole property row because its key stacks above it.
      const zoom = await appZoom(page);
      const [value, row] = await pane(page)
        .locator(".md-property")
        .first()
        .evaluate((property) => [
          property.querySelector("dd")!.getBoundingClientRect().width,
          property.getBoundingClientRect().width,
        ]);
      expect(value / zoom, "frontmatter value column width").toBeGreaterThanOrEqual(
        Math.min(MIN_USABLE_WIDTH, (row / zoom) * 0.9),
      );
    },
  },
  {
    name: "wide.csv",
    rendered: (page) =>
      expect(pane(page).getByRole("table", { name: "CSV preview" }).getByRole("columnheader")).toHaveCount(16),
  },
  {
    name: "panorama.png",
    rendered: (page) => expectDecodedImage(page, 4000, 300),
  },
  {
    name: "tall.png",
    rendered: (page) => expectDecodedImage(page, 300, 4000),
  },
  {
    name: "clip.mp4",
    rendered: (page) =>
      expect
        .poll(() =>
          pane(page)
            .locator(".preview-image")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0),
  },
  {
    name: "archive.zip",
    rendered: (page) => expect(pane(page).locator(".folder-item").first()).toBeVisible(),
  },
  {
    name: "long-names",
    rendered: (page) => expect(pane(page).locator(".folder-item-name", { hasText: LONG_CHILD })).toBeVisible(),
  },
  {
    name: "blob.bin",
    rendered: (page) => expect(pane(page).locator(".preview-empty")).toContainText("No preview available"),
  },
  {
    name: LONG_NAME,
    rendered: async (page) => {
      await expect(pane(page).locator(".preview-code, .preview-text").first()).toContainText("short content");
      if (await pane(page).locator(".preview-header").count()) {
        await expect(pane(page).locator(".preview-filename")).toHaveText(LONG_NAME);
      }
    },
  },
];

const formatNamed = (name: string) => FORMATS.find((format) => format.name === name)!;

async function expectDecodedImage(page: Page, width: number, height: number): Promise<void> {
  await expect
    .poll(() =>
      pane(page)
        .locator(".preview-image")
        .evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
    )
    .toEqual([width, height]);
}

/**
 * Committed screenshots are rewritten only when CAPTURE_EVIDENCE is set, so
 * an ordinary run leaves the working tree clean.
 */
function screenshotPath(name: string): string {
  return process.env.CAPTURE_EVIDENCE
    ? `screenshots/test/preview-containment/${name}`
    : test.info().outputPath(name);
}

/**
 * Serve a real, extreme-aspect raster image for each image fixture. A PNG,
 * not an SVG: WebKit reports an SVG's natural size from its rendered box.
 */
async function installImageFixtures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const png = (width: number, height: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#4a7cff";
      context.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png");
    };
    (globalThis as { __mockPreviewReadImage?: (path: string) => string }).__mockPreviewReadImage = (path) =>
      path.endsWith("tall.png") ? png(300, 4000) : png(4000, 300);
  });
}

interface Layout {
  viewport: Viewport;
  zoom: number;
  dock: Dock;
  size: Size;
  showPreviewInfo?: boolean;
}

/** Load `path` in the given window with the preview docked as requested. */
async function openWithPreview(page: Page, path: string, layout: Layout, settings: object = {}): Promise<void> {
  await page.setViewportSize(VIEWPORTS[layout.viewport]);
  await page.goto(`/?path=${path}`);
  await page.evaluate((stored) => localStorage.setItem("explorer-settings", JSON.stringify(stored)), {
    showPreviewPane: true,
    showPreviewInfo: layout.showPreviewInfo ?? true,
    previewPanePosition: layout.dock,
    zoomLevel: layout.zoom,
    ...SIZES[layout.size],
    ...settings,
  });
  await page.reload();
  await waitForEntries(page);
}

async function openNarrowSplit(page: Page, viewMode: ViewMode, layout: Layout): Promise<void> {
  await installImageFixtures(page);
  await openWithPreview(page, DIR, layout, { viewMode });
  await page.keyboard.press("Control+m");
  await expect(page.locator(".explorer-pane")).toHaveCount(2);
  await expect(page.locator(`.explorer-pane.active .${viewMode}-view`)).toBeVisible();
  await expect(pane(page)).toBeVisible();
  // The new pane selects its first entry once its listing arrives; clicking
  // earlier would be overridden by that initial selection.
  await expect(page.locator(".explorer-pane.active .selected")).toHaveCount(1);
}

/** Select an entry of the active pane, scrolling its virtualized list to it. */
async function selectEntry(page: Page, name: string): Promise<void> {
  const entry = page.locator(`.explorer-pane.active [data-path="${DIR}/${name}"]`);
  const scroller = page.locator(".explorer-pane.active .virtual-viewport").first();
  // Scroll one step and let the virtual list render the rows it exposes.
  const step = (reset: boolean) =>
    scroller.evaluate(
      (element, reset) =>
        new Promise<boolean>((resolve) => {
          const before = element.scrollTop;
          element.scrollTop = reset ? 0 : before + Math.max(element.clientHeight / 2, 24);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(reset || element.scrollTop > before)));
        }),
      reset,
    );
  let moved = await step(true);
  while ((await entry.count()) === 0 && moved) moved = await step(false);
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
  await expect(entry).toHaveClass(/selected/);
}

interface Containment {
  pageOverflow: number;
  /** Explorer file lists narrower than MIN_USABLE_WIDTH, in CSS pixels. */
  narrowFileLists: number[];
  /** Height of the content region in CSS pixels, or null when there is none. */
  contentHeight: number | null;
  /** The file name or metadata squeezed below a usable width. */
  cramped: string[];
  unreachable: string[];
}

/**
 * Report everything that is not contained. Runs in the page so every rect
 * comes from the same engine and coordinate space. Rects are zoomed with the
 * root UI zoom; widths and heights are reported in CSS pixels.
 */
function measure(page: Page): Promise<Containment> {
  return page.evaluate(
    ({ minWidth }) => {
      const zoom =
        Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-zoom")) || 1;
      const describe = (node: Node, rect: DOMRect) => {
        const element = node instanceof Element ? node : node.parentElement!;
        const label = `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join("")}`;
        return `${node instanceof Text ? "text in " : ""}${label} [${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}]`;
      };
      const within = (inner: DOMRect, outer: DOMRect, axis: "x" | "y") =>
        axis === "x"
          ? inner.left >= outer.left - 1 && inner.right <= outer.right + 1
          : inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;

      const overflowOf = (element: Element, axis: "x" | "y") => {
        const style = getComputedStyle(element);
        return axis === "x" ? style.overflowX : style.overflowY;
      };
      const clips = (element: Element, axis: "x" | "y") => overflowOf(element, axis) !== "visible";
      const scrolls = (element: Element, axis: "x" | "y") =>
        ["auto", "scroll"].includes(overflowOf(element, axis));

      const INTERACTIVE =
        "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable], [role=button], [role=link]";
      const BLOCK_CONTAINERS = ["block", "inline-block", "flow-root", "list-item", "table-cell"];
      /**
       * Whether `element` visibly truncates `node` with an ellipsis. Text
       * overflow applies only to the inline content of a block container, and
       * it hides atomic inlines and controls instead of truncating them, so
       * only text and plain inline elements qualify.
       */
      const truncates = (element: Element, node: Node) => {
        const style = getComputedStyle(element);
        if (!BLOCK_CONTAINERS.includes(style.display)) return false;
        if (!["hidden", "clip"].includes(style.overflowX) || style.textOverflow !== "ellipsis") return false;
        for (
          let inline = node instanceof Element ? node : node.parentElement;
          inline && inline !== element;
          inline = inline.parentElement
        ) {
          if (inline.matches(INTERACTIVE) || getComputedStyle(inline).display !== "inline") return false;
        }
        return true;
      };

      /**
       * A box is reachable when nothing between it and its region cuts it
       * off: every ancestor that clips it along the axis must scroll along
       * that axis and be reachable itself, or truncate it as inline text with
       * an ellipsis. The content region scrolls vertically by design;
       * horizontal overflow must be absorbed by an inner scroller (a table, a
       * code block, the CSV surface), never by scrolling the whole preview
       * sideways.
       */
      const reachable = (node: Node, rect: DOMRect, region: Element, axis: "x" | "y"): boolean => {
        for (let element = node.parentElement; element; element = element.parentElement) {
          const box = element.getBoundingClientRect();
          if (element === region) {
            return (
              within(rect, box, axis) ||
              (axis === "y" && scrolls(region, "y")) ||
              (axis === "x" && truncates(region, node))
            );
          }
          if (within(rect, box, axis) || !clips(element, axis)) continue;
          if (scrolls(element, axis) || (axis === "x" && truncates(element, node))) {
            return reachable(element, box, region, axis);
          }
          return false;
        }
        return false;
      };

      const preview = document.querySelector(".preview-pane")!;
      const previewRect = preview.getBoundingClientRect();
      const unreachable: string[] = [];
      const regions = [
        ...preview.querySelectorAll(
          ":scope > .preview-header, :scope > .diff-actions, :scope > .preview-content, :scope > .preview-info",
        ),
      ];
      for (const region of regions) {
        const regionRect = region.getBoundingClientRect();
        if (!within(regionRect, previewRect, "x") || !within(regionRect, previewRect, "y")) {
          unreachable.push(`region ${describe(region, regionRect)} leaves the pane`);
        }
        // An SVG draws its children in its own viewport, so only its box counts.
        const walker = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode: (node) =>
            node.parentElement instanceof SVGElement ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          let rects: DOMRect[];
          if (node instanceof Text) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            rects = [...range.getClientRects()];
          } else {
            rects = [(node as Element).getBoundingClientRect()];
          }
          for (const rect of rects) {
            if (rect.width === 0 || rect.height === 0) continue;
            for (const axis of ["x", "y"] as const) {
              if (!reachable(node, rect, region, axis)) {
                unreachable.push(`${axis}: ${describe(node, rect)} escapes its region or a clipping ancestor`);
              }
            }
          }
        }
      }

      // The name and the metadata may truncate, but not below a usable width
      // unless they need less than that.
      const cramped = [
        ...preview.querySelectorAll(":scope > .preview-header .preview-filename, :scope > .preview-info"),
      ].flatMap((element) => {
        const width = element.getBoundingClientRect().width / zoom;
        const natural = element.scrollWidth;
        return width + 1 < Math.min(natural, minWidth)
          ? [`${describe(element, element.getBoundingClientRect())} shows ${Math.round(width)} of ${natural} CSS px`]
          : [];
      });

      const content = preview.querySelector(":scope > .preview-content");
      const root = document.scrollingElement ?? document.documentElement;
      return {
        pageOverflow: Math.max(
          root.scrollWidth - root.clientWidth,
          document.body.scrollWidth - document.body.clientWidth,
        ),
        narrowFileLists: [...document.querySelectorAll(".explorer-pane .file-list")]
          .map((list) => list.getBoundingClientRect().width / zoom)
          .filter((width) => width < minWidth),
        contentHeight: content ? content.getBoundingClientRect().height / zoom : null,
        cramped,
        unreachable: [...new Set(unreachable)].slice(0, 20),
      };
    },
    { minWidth: MIN_USABLE_WIDTH },
  );
}

/** Assert the preview's current content is contained; `label` names it in failures. */
async function expectContained(page: Page, label: string, { fileLists = true } = {}): Promise<void> {
  const viewport = page.viewportSize()!;
  const paneBox = await pane(page).boundingBox();
  expect(paneBox, "preview pane has a box").not.toBeNull();
  expect(paneBox!.x + paneBox!.width, "pane right edge within the window").toBeLessThanOrEqual(viewport.width + 1);
  expect(paneBox!.y + paneBox!.height, "pane bottom edge within the window").toBeLessThanOrEqual(
    viewport.height + 1,
  );

  const report = await measure(page);
  // One pixel absorbs sub-pixel rounding of zoomed layout widths.
  expect.soft(report.pageOverflow, "page never overflows horizontally").toBeLessThanOrEqual(1);
  if (fileLists) expect.soft(report.narrowFileLists, "every file list keeps a usable width").toEqual([]);
  expect.soft(report.contentHeight, `${label}: the content region exists`).not.toBeNull();
  expect
    .soft(report.contentHeight ?? 0, `${label}: the content region keeps a usable height`)
    .toBeGreaterThanOrEqual(MIN_CONTENT_HEIGHT);
  expect.soft(report.cramped, `${label}: the name and metadata keep a usable width`).toEqual([]);
  expect.soft(report.unreachable, `${label}: nothing spills out of its region unreachably`).toEqual([]);
  // Stop at the first uncontained entry; the soft checks above name every problem.
  expect(test.info().errors.length, `${label}: containment checks that failed`).toBe(0);
}

interface Case extends Layout {
  viewMode: ViewMode;
}

const CASES: Case[] = [
  ...VIEW_MODES.flatMap((viewMode) =>
    DOCKS.flatMap((dock) =>
      ZOOMS.flatMap((zoom) =>
        (Object.keys(SIZES) as Size[]).map((size) => ({ viewMode, viewport: "wide" as const, dock, zoom, size })),
      ),
    ),
  ),
  // A narrow window at the largest zoom gives vertical docks their narrowest
  // width, where the name and metadata compete for one row. A right dock
  // keeps its preferred width however narrow the window is, so only its
  // minimum width leaves the explorer room there.
  ...DOCKS.flatMap((dock) =>
    (Object.keys(SIZES) as Size[])
      .filter((size) => dock !== "right" || size === "minimum")
      .map((size) => ({ viewMode: "details" as const, viewport: "narrow" as const, dock, zoom: 150, size })),
  ),
  // Without the name and metadata the content takes the whole pane.
  ...DOCKS.map((dock) => ({
    viewMode: "details" as const,
    viewport: "wide" as const,
    dock,
    zoom: 150,
    size: "minimum" as const,
    showPreviewInfo: false,
  })),
];

interface Evidence {
  entry: string;
  file: string;
}

/** Committed screenshots, by the case that renders them and the entry it shows. */
function evidenceFor({ viewMode, viewport, dock, zoom, size, showPreviewInfo }: Case): Evidence | null {
  if (viewMode !== "details" || zoom !== 150 || showPreviewInfo === false) return null;
  if (viewport === "wide" && size === "minimum" && dock === "right") {
    return { entry: "wide.md", file: "minimum-right-dock-150.png" };
  }
  if (viewport === "wide" && size === "minimum" && dock === "bottom") {
    return { entry: "long-line.ts", file: "minimum-bottom-dock-150.png" };
  }
  if (viewport === "narrow" && size === "default" && dock === "bottom") {
    return { entry: LONG_NAME, file: "narrow-window-bottom-dock-150-long-name.png" };
  }
  return null;
}

for (const layout of CASES) {
  const { viewMode, viewport, dock, zoom, size, showPreviewInfo } = layout;
  const variant = showPreviewInfo === false ? ", without name and metadata" : "";
  test(`every preview format is contained in a narrow ${viewMode} split, ${size} ${dock} dock at ${zoom}% in a ${viewport} window${variant}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openNarrowSplit(page, viewMode, layout);
    await expect(pane(page).locator(".preview-header")).toHaveCount(showPreviewInfo === false ? 0 : 1);
    for (const format of FORMATS) {
      await test.step(format.name, async () => {
        await selectEntry(page, format.name);
        await format.rendered(page);
        await expectContained(page, format.name);
      });
    }
    const evidence = evidenceFor(layout);
    if (evidence) {
      await selectEntry(page, evidence.entry);
      await formatNamed(evidence.entry).rendered(page);
      await page.screenshot({ path: screenshotPath(evidence.file) });
    }
  });
}

test("frontmatter keeps key and value side by side in the default right dock and stacks them in the minimum one", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const layoutOf = () =>
    pane(page)
      .locator(".md-property")
      .first()
      .evaluate((property) => {
        const key = property.querySelector("dt")!.getBoundingClientRect();
        const value = property.querySelector("dd")!.getBoundingClientRect();
        if (value.left >= key.right && value.top < key.bottom) return "side by side";
        if (value.top >= key.bottom - 1) return "stacked";
        return "overlapping";
      });
  for (const [size, zoom, expected] of [
    ["default", 100, "side by side"],
    ["default", 150, "side by side"],
    ["minimum", 100, "stacked"],
  ] as const) {
    await openNarrowSplit(page, "details", { viewport: "wide", dock: "right", zoom, size });
    await selectEntry(page, "wide.md");
    await formatNamed("wide.md").rendered(page);
    expect(await layoutOf(), `${size} right dock at ${zoom}%`).toBe(expected);
    if (size === "default" && zoom === 100) {
      await page.screenshot({ path: screenshotPath("frontmatter-default-right-dock.png") });
    }
  }
});

/** Open the mock repository's SCM panel with the preview docked as requested. */
async function openScm(page: Page, layout: Layout): Promise<void> {
  await openWithPreview(page, "/home/user/Documents/project", layout, { showGitStatus: true, showScmPanel: true });
  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });
}

async function expectDiffRendered(page: Page, name: string): Promise<void> {
  await expect(pane(page).locator(".preview-filename")).toHaveText(name);
  await expect(pane(page).locator('.diff-line[data-line-kind="add"]').first()).toBeVisible();
}

/**
 * Diffs open beside the SCM panel, not in a split, so these cases leave the
 * file-list width alone: the panel and a right dock share a medium window.
 */
const DIFF_LAYOUTS = [
  { viewport: "wide", zoom: 100 },
  { viewport: "medium", zoom: 150 },
] as const;

for (const dock of DOCKS) {
  for (const size of Object.keys(SIZES) as Size[]) {
    for (const { viewport, zoom } of DIFF_LAYOUTS) {
      test(`an SCM diff is contained in a ${size} ${dock} dock at ${zoom}% in a ${viewport} window`, async ({
        page,
      }) => {
        test.setTimeout(60_000);
        await openScm(page, { viewport, zoom, dock, size });

        await test.step("unstaged diff with a long path", async () => {
          await page.evaluate((path) => {
            (window as unknown as { __mockGitExternalModify: (path: string) => void }).__mockGitExternalModify(path);
          }, LONG_DIFF_PATH);
          await page.locator('[data-section="changes"] .row', { hasText: "UserAccountServiceImplementation" }).click();
          await expectDiffRendered(page, "UserAccountServiceImplementation.java");
          await expect(pane(page).locator(".preview-info .info-value")).toHaveText(LONG_DIFF_PATH);
          await expectContained(page, "long-path diff", { fileLists: false });
          if (dock === "bottom" && size === "default" && zoom === 150) {
            await page.screenshot({ path: screenshotPath("diff-long-path-bottom-dock-150.png") });
          }
        });

        await test.step("staged diff", async () => {
          await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();
          await expectDiffRendered(page, "App.tsx");
          await expect(pane(page).locator(".diff-staged")).toBeVisible();
          await expectContained(page, "staged diff", { fileLists: false });
        });
      });
    }
  }
}

for (const dock of DOCKS) {
  test(`a commit comparison is contained in a minimum ${dock} dock at 150% in a medium window`, async ({ page }) => {
    test.setTimeout(60_000);
    await openWithPreview(page, "/home/user/Documents/project", {
      viewport: "medium",
      zoom: 150,
      dock,
      size: "minimum",
    });
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Toggle Commit Graph");
    await page.keyboard.press("Enter");
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
    const newer = view.locator(".commit-row").nth(2);
    const older = view.locator(".commit-row").nth(6);
    const [newerOid, olderOid] = [await newer.getAttribute("data-oid"), await older.getAttribute("data-oid")];
    await newer.click();
    await page.getByRole("button", { name: "Compare this commit" }).click();
    await older.click();
    await page.locator(".detail-file", { hasText: "src/compared.ts" }).click();

    await expect(pane(page).locator(".preview-type-badge")).toHaveText(
      `compare ${olderOid!.slice(0, 7)} → ${newerOid!.slice(0, 7)}`,
    );
    await expectDiffRendered(page, "compared.ts");
    await expectContained(page, "commit comparison", { fileLists: false });
  });
}
