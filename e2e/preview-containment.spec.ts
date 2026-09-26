/**
 * E2E: every preview format stays inside its pane in a narrow split at 80,
 * 100 and 150 % UI zoom, in each dock position (#792).
 *
 * "Inside" is reachability, not clipping: the preview pane clips with
 * `overflow: hidden`, so content that spills past its region would silently
 * disappear. Anything wider or taller than its region (header, content, info)
 * must sit inside a scroll container within that region, or be visibly
 * truncated with an ellipsis. The page itself must never scroll horizontally,
 * and every explorer pane must keep a usable file-list region.
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, waitForEntries, type ViewMode } from "./helpers";

const DIR = "/home/preview-containment";
const LONG_NAME =
  "an-exceptionally-long-file-name-that-must-truncate-inside-the-preview-header-instead-of-widening-the-pane.txt";
const LONG_CHILD =
  "a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated.log";
const ZOOMS = [80, 100, 150] as const;
const DOCKS = ["right", "bottom", "top"] as const;
/** The default dock size and the smallest the resize bounds allow (settings-numbers.ts). */
const SIZES = {
  default: { previewPaneWidth: 0, previewPaneHeight: 0 },
  minimum: { previewPaneWidth: 160, previewPaneHeight: 120 },
} as const;
/** Narrowest region, in CSS pixels, that still shows a readable name or value. */
const MIN_USABLE_WIDTH = 96;

interface Format {
  name: string;
  /** Resolves once the format's own content (not a spinner) has rendered. */
  rendered: (page: Page) => Promise<void>;
}

const pane = (page: Page) => page.locator(".preview-pane");

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
      const [value, row] = await pane(page)
        .locator(".md-property")
        .first()
        .evaluate((property) => [
          property.querySelector("dd")!.getBoundingClientRect().width,
          property.getBoundingClientRect().width,
        ]);
      expect(value, "frontmatter value column width").toBeGreaterThanOrEqual(Math.min(MIN_USABLE_WIDTH, row * 0.9));
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
      await expect(pane(page).locator(".preview-filename")).toHaveText(LONG_NAME);
      await expect(pane(page).locator(".preview-code, .preview-text").first()).toContainText("short content");
    },
  },
];

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

async function openNarrowSplit(
  page: Page,
  viewMode: ViewMode,
  zoom: number,
  dock: (typeof DOCKS)[number],
  size: keyof typeof SIZES,
): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 720 });
  await installImageFixtures(page);
  await page.goto(`/?path=${DIR}`);
  await page.evaluate((settings) => localStorage.setItem("explorer-settings", JSON.stringify(settings)), {
    showPreviewPane: true,
    previewPanePosition: dock,
    zoomLevel: zoom,
    viewMode,
    ...SIZES[size],
  });
  await page.reload();
  await waitForEntries(page);
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
  narrowFileLists: number[];
  unreachable: string[];
}

/**
 * Report everything that is not contained. Runs in the page so every rect
 * comes from the same engine and coordinate space.
 */
function measure(page: Page): Promise<Containment> {
  return page.evaluate((minFileList) => {
    const describe = (node: Node, rect: DOMRect) => {
      const element = node instanceof Element ? node : node.parentElement!;
      const label = `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join("")}`;
      return `${node instanceof Text ? "text in " : ""}${label} [${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}×${Math.round(rect.height)}]`;
    };
    const within = (inner: DOMRect, outer: DOMRect, axis: "x" | "y") =>
      axis === "x"
        ? inner.left >= outer.left - 1 && inner.right <= outer.right + 1
        : inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;

    const scrolls = (element: Element, axis: "x" | "y") => {
      const style = getComputedStyle(element);
      const overflow = axis === "x" ? style.overflowX : style.overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    const truncates = (element: Element) => {
      const style = getComputedStyle(element);
      return (style.overflowX === "hidden" || style.overflowX === "clip") && style.textOverflow === "ellipsis";
    };

    /**
     * A box is reachable when it lies inside its region, or its nearest
     * scroller (or ellipsis truncation) along that axis is itself reachable.
     * The content region scrolls vertically by design; horizontal overflow
     * must be absorbed by an inner scroller (a table, a code block, the CSV
     * surface), never by scrolling the whole preview sideways.
     */
    const reachable = (node: Node, rect: DOMRect, region: Element, axis: "x" | "y"): boolean => {
      if (within(rect, region.getBoundingClientRect(), axis)) return true;
      for (let element = node.parentElement; element; element = element.parentElement) {
        if (element === region) return axis === "y" && scrolls(region, "y");
        if (scrolls(element, axis) || (axis === "x" && truncates(element))) {
          return reachable(element, element.getBoundingClientRect(), region, axis);
        }
      }
      return false;
    };

    const preview = document.querySelector(".preview-pane")!;
    const previewRect = preview.getBoundingClientRect();
    const unreachable: string[] = [];
    const regions = [
      ...preview.querySelectorAll(":scope > .preview-header, :scope > .preview-content, :scope > .preview-info"),
    ];
    for (const region of regions) {
      const regionRect = region.getBoundingClientRect();
      if (!within(regionRect, previewRect, "x") || !within(regionRect, previewRect, "y")) {
        unreachable.push(`region ${describe(region, regionRect)} leaves the pane`);
      }
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
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
              unreachable.push(`${axis}: ${describe(node, rect)} escapes ${describe(region, regionRect)}`);
            }
          }
        }
      }
    }

    const root = document.scrollingElement ?? document.documentElement;
    return {
      pageOverflow: Math.max(
        root.scrollWidth - root.clientWidth,
        document.body.scrollWidth - document.body.clientWidth,
      ),
      narrowFileLists: [...document.querySelectorAll(".explorer-pane .file-list")]
        .map((list) => list.getBoundingClientRect().width)
        .filter((width) => width < minFileList),
      unreachable: [...new Set(unreachable)].slice(0, 20),
    };
  }, MIN_USABLE_WIDTH);
}

const CASES = VIEW_MODES.flatMap((viewMode) =>
  DOCKS.flatMap((dock) =>
    ZOOMS.flatMap((zoom) =>
      (Object.keys(SIZES) as (keyof typeof SIZES)[]).map((size) => ({ viewMode, dock, zoom, size })),
    ),
  ),
);

for (const { viewMode, dock, zoom, size } of CASES) {
  test(`every preview format is contained in a narrow ${viewMode} split, ${size} ${dock} dock at ${zoom}%`, async ({
    page,
  }) => {
    await openNarrowSplit(page, viewMode, zoom, dock, size);
    const viewport = page.viewportSize()!;
    for (const format of FORMATS) {
      await test.step(format.name, async () => {
        await selectEntry(page, format.name);
        await format.rendered(page);

        const paneBox = await pane(page).boundingBox();
        expect(paneBox, "preview pane has a box").not.toBeNull();
        expect(paneBox!.x + paneBox!.width, "pane right edge within the window").toBeLessThanOrEqual(
          viewport.width + 1,
        );
        expect(paneBox!.y + paneBox!.height, "pane bottom edge within the window").toBeLessThanOrEqual(
          viewport.height + 1,
        );

        const report = await measure(page);
        // One pixel absorbs sub-pixel rounding of zoomed layout widths.
        expect(report.pageOverflow, "page never overflows horizontally").toBeLessThanOrEqual(1);
        expect(report.narrowFileLists, "every file list keeps a usable width").toEqual([]);
        expect(report.unreachable, `${format.name}: nothing spills out of its region unreachably`).toEqual([]);
      });
    }
    if (viewMode === "details" && zoom === 150 && size === "minimum" && dock !== "top") {
      await selectEntry(page, dock === "right" ? "wide.md" : "long-line.ts");
      await FORMATS.find((format) => format.name === (dock === "right" ? "wide.md" : "long-line.ts"))!.rendered(page);
      await page.screenshot({ path: `screenshots/test/preview-containment/minimum-${dock}-dock-150.png` });
    }
  });
}
