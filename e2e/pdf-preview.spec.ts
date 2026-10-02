import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries } from "./helpers";
import { readFileSync } from "node:fs";
import type { MockControl } from "../src/lib/api/mock-control";

for (const mode of ALL_VIEW_MODES) {
  test(`${mode}: distinct pending PDF selection shows loading and keeps the current single-page document`, async ({ page }) => {
    const root = "/pdf-selection-proof";
    const first = `${root}/old-multipage.pdf`;
    const second = `${root}/current-single-page.pdf`;
    const single = [...readFileSync(new URL("../e2e-tauri/fixtures/preview-single-page.pdf", import.meta.url))];
    // Equal-length color replacement retains the real PDF's xref offsets.
    // A stale old page is blue, visibly distinct from the current red page.
    const multiple = [...Buffer.from(readFileSync(new URL("../src/lib/api/fixtures/preview-landmarks.pdf", import.meta.url))
      .toString("ascii").replace("1 0 0 rg 265.0", "0 0 1 rg 265.0"), "ascii")];
    await page.addInitScript((viewMode) => {
      localStorage.setItem("explorer-settings", JSON.stringify({ viewMode, showPreviewPane: false, zoomLevel: 150, previewPaneWidth: 420 }));
    }, mode);
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await page.evaluate(async ({ root, first, second }) => {
      const fixtureUrl = "/src/lib/api/mock-fixtures.ts";
      const { mockFiles } = await import(/* @vite-ignore */ fixtureUrl);
      mockFiles[root] = [first, second].map((path) => ({ path, name: path.split("/").at(-1)!, kind: "file", size: 2000, modified: "2026-10-02T00:00:00Z" }));
      const w = window as unknown as {
        __mockControl?: MockControl;
        __pdfSelectionReads: Array<{ path: string; resolve(value: ArrayBuffer): void; completed: boolean }>;
      };
      w.__pdfSelectionReads = [];
      (w.__mockControl ??= {}).previewReadPdf = (path) => new Promise<ArrayBuffer>((resolve) => {
        const read = { path, completed: false, resolve: (value: ArrayBuffer) => { read.completed = true; resolve(value); } };
        w.__pdfSelectionReads.push(read);
      });
    }, { root, first, second });
    await page.keyboard.press("Control+l");
    await page.locator(".path-input").fill(root);
    await page.locator(".path-input").press("Enter");
    await expect(page.locator(`.${mode}-view`)).toBeVisible();
    await page.locator(`.entry-item[data-path="${first}"]`).click();
    await page.keyboard.press("Space");
    await expect(page.locator(".pdf-message[role=status]")).toHaveText("Loading PDF…");
    await expect(page.locator(".pdf-page.ready")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __pdfSelectionReads: Array<{ path: string; completed: boolean }>;
    }).__pdfSelectionReads.map((read) => ({ path: read.path, completed: read.completed })))).toEqual([{ path: first, completed: false }]);
    await page.locator(`.entry-item[data-path="${second}"]`).click();
    await expect(page.locator(".pdf-preview")).toHaveAttribute("data-path", second);
    await expect(page.locator(".pdf-message[role=status]")).toHaveText("Loading PDF…");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pdfSelectionReads: unknown[] }).__pdfSelectionReads.length)).toBe(2);
    const finish = async (path: string, bytes: number[]) => page.evaluate(({ path, bytes }) => {
      const reads = (window as unknown as { __pdfSelectionReads: Array<{ path: string; resolve(value: ArrayBuffer): void }> }).__pdfSelectionReads;
      const read = reads.find((item) => item.path === path);
      if (!read) throw new Error(`No pending read for ${path}`);
      read.resolve(new Uint8Array(bytes).buffer);
    }, { path, bytes });
    await finish(second, single);
    await expect(page.locator(".pdf-page.ready")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => centerColor(page)).toEqual([255, 0, 0, 255]);
    await expect(page.locator(".page-count")).toHaveText("1 / 1");
    await expect(page.getByRole("button", { name: "Previous PDF page", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next PDF page", exact: true })).toBeDisabled();
    await finish(first, multiple);
    await expect.poll(() => page.evaluate((oldPath) => (window as unknown as {
      __pdfSelectionReads: Array<{ path: string; completed: boolean }>;
    }).__pdfSelectionReads.find((read) => read.path === oldPath)?.completed, first)).toBe(true);
    // Cancellation before bytes arrive prevents the old worker from starting.
    // Loaded-document termination is covered separately by the lifetime cases.
    expect(await page.evaluate((oldPath) => {
      const events = JSON.parse(document.documentElement.dataset.e2ePdfWorkers || "[]") as Array<{ path: string; phase: string }>;
      return events.some((event) => event.path === oldPath && event.phase === "created");
    }, first)).toBe(false);
    await expect(page.locator(".pdf-preview")).toHaveAttribute("data-path", second);
    await expect(page.locator(".page-count")).toHaveText("1 / 1");
    await expect(page.locator(".pdf-message[role=alert]")).toHaveCount(0);
    await expect.poll(() => centerColor(page)).toEqual([255, 0, 0, 255]);
    await zoomTo(page, 130);
    const enlarged = await geometry(page);
    expect(Math.abs(enlarged.centerX - enlarged.viewportCenterX)).toBeLessThan(2);
    expect(Math.abs(enlarged.centerY - enlarged.viewportCenterY)).toBeLessThan(2);
    await expect.poll(() => centerColor(page)).toEqual([255, 0, 0, 255]);
  });
}

test("PDF pointer cancellation ends a held pan and later motion does not move the page", async ({
  page,
}) => {
  await openPdf(page, 150);
  await zoomTo(page, 400);
  const viewport = page.locator(".pdf-viewport");
  await viewport.evaluate((element) =>
    element.addEventListener(
      "pointerdown",
      (event) => {
        (element as HTMLElement).dataset.testPointer = String(
          (event as PointerEvent).pointerId,
        );
      },
      { once: true },
    ),
  );
  const box = (await viewport.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x - 30, start.y - 30);
  await expect(viewport).toHaveClass(/panning/);
  await viewport.evaluate((element) =>
    element.dispatchEvent(
      new PointerEvent("pointercancel", {
        bubbles: true,
        pointerId: Number((element as HTMLElement).dataset.testPointer),
      }),
    ),
  );
  await expect(viewport).not.toHaveClass(/panning/);
  const cancelled = await page.locator(".pdf-page").boundingBox();
  await page.mouse.move(start.x - 70, start.y - 70);
  await page.mouse.up();
  expect(await page.locator(".pdf-page").boundingBox()).toEqual(cancelled);
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
});

test("PDF rejected internal link shows a visible error above the previously rendered page", async ({
  page,
}) => {
  const bytes = [
    ...Buffer.from(
      readFileSync(
        new URL(
          "../src/lib/api/fixtures/preview-landmarks.pdf",
          import.meta.url,
        ),
      )
        .toString("ascii")
        .replace("/Dest [5 0 R", "/Dest [9 0 R"),
      "ascii",
    ),
  ];
  await page.addInitScript((values) => {
    const w = window as unknown as { __mockControl?: MockControl };
    (w.__mockControl ??= {}).previewReadPdf = async () =>
      new Uint8Array(values).buffer;
  }, bytes);
  await openPdf(page);
  await page.locator('a.pdf-link[href="#"]').click();
  const alert = page.locator(".pdf-message[role=alert]");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Cannot preview PDF");
  await expect(page.locator(".pdf-page.ready")).toHaveCount(0);
});

test("PDF repeated open/close releases loaded fonts and owned workers", async ({
  page,
}) => {
  await openPdf(page);
  const fontCount = () =>
    page.evaluate(
      () =>
        [...document.fonts].filter((font) => /^g_d\d+_/.test(font.family))
          .length,
    );
  for (let cycle = 0; cycle < 3; cycle++) {
    await expect(page.locator(".pdf-page.ready")).toBeVisible();
    await expect.poll(fontCount).toBeGreaterThan(0);
    await page.locator(".pdf-viewport").focus();
    await page.keyboard.press("Space");
    await expect(page.locator(".preview-pane")).toBeHidden();
    await expect.poll(fontCount).toBe(0);
    if (cycle < 2) await page.keyboard.press("Space");
  }
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events = JSON.parse(
          document.documentElement.dataset.e2ePdfWorkers || "[]",
        ) as Array<{ id: string; phase: string }>;
        return events
          .filter((e) => e.phase === "created")
          .every((e) =>
            events.some((t) => t.id === e.id && t.phase === "terminated"),
          );
      }),
    )
    .toBe(true);
});

async function openPdf(page: Page, zoom = 100, dock = "right") {
  await page.addInitScript(
    ({ zoom, dock }) => {
      localStorage.setItem(
        "explorer-settings",
        JSON.stringify({
          showPreviewPane: false,
          previewPaneWidth: 420,
          previewPaneHeight: 330,
          previewPanePosition: dock,
          zoomLevel: zoom,
          theme: "light",
        }),
      );
    },
    { zoom, dock },
  );
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "report.pdf" }).click();
  await page.keyboard.press("Space");
  await expect(page.locator(".pdf-page.ready")).toBeVisible({ timeout: 15000 });
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const viewport = document
      .querySelector(".pdf-viewport")!
      .getBoundingClientRect();
    const pageRect = document
      .querySelector(".pdf-page")!
      .getBoundingClientRect();
    return {
      x: pageRect.x,
      y: pageRect.y,
      width: pageRect.width,
      height: pageRect.height,
      centerX: pageRect.x + pageRect.width / 2,
      centerY: pageRect.y + pageRect.height / 2,
      vx: viewport.x,
      vy: viewport.y,
      vw: viewport.width,
      vh: viewport.height,
      viewportCenterX: viewport.x + viewport.width / 2,
      viewportCenterY: viewport.y + viewport.height / 2,
    };
  });
}
async function centerColor(page: Page) {
  return page
    .locator(".pdf-canvas canvas")
    .evaluate((element: HTMLCanvasElement) => [
      ...element
        .getContext("2d")!
        .getImageData(
          Math.floor(element.width / 2),
          Math.floor(element.height / 2),
          1,
          1,
        ).data,
    ]);
}
async function zoomTo(page: Page, percent: number) {
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  for (let value = 100; value < percent; value += 10)
    await page
      .getByRole("button", { name: "Zoom PDF in", exact: true })
      .click();
  await expect(page.locator(".pdf-zoom")).toHaveText(`${percent}%`);
  await expect(page.locator(".pdf-page.ready")).toBeVisible();
}

for (const appZoom of [100, 150]) {
  test(`PDF fit, 130% center and mixed-size page content at app ${appZoom}%`, async ({
    page,
  }) => {
    await openPdf(page, appZoom);
    let before = await geometry(page);
    expect(Math.abs(before.centerX - before.viewportCenterX)).toBeLessThan(2);
    expect(Math.abs(before.centerY - before.viewportCenterY)).toBeLessThan(2);
    expect(before.width).toBeLessThan(before.vw);
    expect(before.height).toBeLessThan(before.vh);
    expect(await centerColor(page)).toEqual([255, 0, 0, 255]);
    await zoomTo(page, 130);
    const after = await geometry(page);
    expect(after.width / before.width).toBeCloseTo(1.3, 2);
    expect(Math.abs(after.centerX - after.viewportCenterX)).toBeLessThan(2);
    expect(Math.abs(after.centerY - after.viewportCenterY)).toBeLessThan(2);
    await page
      .getByRole("button", { name: "Next PDF page", exact: true })
      .click();
    await expect(page.locator(".page-count")).toHaveText("2 / 3");
    await expect.poll(() => centerColor(page)).toEqual([153, 0, 204, 255]);
    before = await geometry(page);
    expect(before.width).toBeGreaterThan(before.height);
    expect(Math.abs(before.centerX - before.viewportCenterX)).toBeLessThan(2);
    await page
      .getByRole("button", { name: "Next PDF page", exact: true })
      .click();
    await expect.poll(() => centerColor(page)).toEqual([255, 128, 0, 255]);
    await expect(
      page.getByRole("button", { name: "Next PDF page", exact: true }),
    ).toBeDisabled();
  });
  for (const fullscreen of [false, true])
    test(`PDF hand navigation, wheel anchor and fit reset at app ${appZoom}% fullscreen ${fullscreen}`, async ({
      page,
    }) => {
      await openPdf(page, appZoom);
      if (fullscreen)
        await page
          .getByRole("button", { name: "View PDF fullscreen", exact: true })
          .click();
      await zoomTo(page, 400);
      const initial = await geometry(page);
      const start = { x: initial.viewportCenterX, y: initial.viewportCenterY };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 60, start.y - 50, { steps: 5 });
      await expect(page.locator(".pdf-viewport")).toHaveClass(/panning/);
      expect(
        await page
          .locator(".pdf-viewport")
          .evaluate((e) => getComputedStyle(e).cursor),
      ).toBe("grabbing");
      await page.mouse.up();
      const panned = await geometry(page);
      expect(panned.centerX - initial.centerX).toBeCloseTo(-60, 0);
      expect(panned.centerY - initial.centerY).toBeCloseTo(-50, 0);
      const anchor = { x: start.x + 20, y: start.y + 20 };
      const normalized = {
        x: (anchor.x - panned.x) / panned.width,
        y: (anchor.y - panned.y) / panned.height,
      };
      await page.mouse.move(anchor.x, anchor.y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -100);
      await page.keyboard.up("Control");
      await expect(page.locator(".pdf-zoom")).toHaveText("460%");
      const wheeled = await geometry(page);
      expect(
        Math.abs(wheeled.x + normalized.x * wheeled.width - anchor.x),
      ).toBeLessThan(2);
      expect(
        Math.abs(wheeled.y + normalized.y * wheeled.height - anchor.y),
      ).toBeLessThan(2);
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      const fit = await geometry(page);
      expect(Math.abs(fit.centerX - fit.viewportCenterX)).toBeLessThan(2);
      expect(Math.abs(fit.centerY - fit.viewportCenterY)).toBeLessThan(2);
      if (fullscreen)
        await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
      else
        await expect(page.locator(".preview-pane")).not.toHaveClass(
          /fullscreen/,
        );
      await expect(page.locator(".entry-item.selected")).toContainText(
        "report.pdf",
      );
    });
  test(`PDF links remain usable and a drag over a link does not activate at app ${appZoom}%`, async ({
    page,
  }) => {
    await openPdf(page, appZoom);
    await zoomTo(page, 130);
    const link = page.locator(
      'a.pdf-link[href="https://example.com/pdf-proof"]',
    );
    const box = (await link.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 35,
      box.y + box.height / 2 - 30,
      { steps: 4 },
    );
    await page.mouse.up();
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __mockControl?: MockControl }).__mockControl
            ?.openedPdfUrl ?? null,
      ),
    ).toBeNull();
    await link.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __mockControl?: MockControl }).__mockControl
              ?.openedPdfUrl ?? null,
        ),
      )
      .toBe("https://example.com/pdf-proof");
    await page.evaluate(() => {
      delete (window as unknown as { __mockControl: MockControl }).__mockControl
        .openedPdfUrl;
    });
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await link.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __mockControl?: MockControl }).__mockControl
              ?.openedPdfUrl ?? null,
        ),
      )
      .toBe("https://example.com/pdf-proof");
    await page.locator('a.pdf-link[href="#"]').click();
    await expect(page.locator(".page-count")).toHaveText("2 / 3");
    await expect.poll(() => centerColor(page)).toEqual([153, 0, 204, 255]);
  });
  test(`PDF fullscreen and keyboard navigation at app ${appZoom}%`, async ({
    page,
  }) => {
    await openPdf(page, appZoom);
    await page.locator(".pdf-canvas canvas").click();
    await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
    await page.keyboard.press("PageDown");
    await expect.poll(() => centerColor(page)).toEqual([153, 0, 204, 255]);
    await page.keyboard.press("+");
    await expect(page.locator(".pdf-zoom")).toHaveText("110%");
    await page.keyboard.press("0");
    await expect(page.locator(".pdf-zoom")).toHaveText("100%");
    await page.keyboard.press("Escape");
    await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
    await expect.poll(() => centerColor(page)).toEqual([153, 0, 204, 255]);
  });
}

for (const dock of ["right", "top", "bottom"]) {
  test(`PDF narrow pane stays usable docked ${dock}`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openPdf(page, 150, dock);
    const fit = await geometry(page);
    expect(Math.abs(fit.centerX - fit.viewportCenterX)).toBeLessThan(2);
    expect(fit.height).toBeLessThan(fit.vh);
    expect(fit.width).toBeLessThan(fit.vw);
    await page
      .getByRole("button", { name: "Next PDF page", exact: true })
      .click();
    await expect.poll(() => centerColor(page)).toEqual([153, 0, 204, 255]);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect
      .poll(async () => {
        const g = await geometry(page);
        return Math.abs(g.centerX - g.viewportCenterX);
      })
      .toBeLessThan(2);
  });
}

test("PDF malformed data reports an error and no previous document canvas", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __mockControl?: MockControl };
    (w.__mockControl ??= {}).previewReadPdf = async () =>
      new TextEncoder().encode("broken document").buffer;
  });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "report.pdf" }).click();
  await page.keyboard.press("Space");
  await expect(page.locator(".pdf-message[role=alert]")).toContainText(
    "Cannot preview PDF",
    { timeout: 15000 },
  );
  await expect(page.locator(".pdf-page.ready")).toHaveCount(0);
});

test("PDF fullscreen respects modal keyboard ownership", async ({ page }) => {
  await openPdf(page, 150);
  await page
    .getByRole("button", { name: "View PDF fullscreen", exact: true })
    .click();
  await page.keyboard.press("Control+,");
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  await settings.locator("select").first().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("PageDown");
  await expect(page.locator(".page-count")).toHaveText("1 / 3");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
});

test("PDF delayed old bytes cannot replace a refreshed revision; unmount ends its worker", async ({
  page,
}) => {
  const bytes = [
    ...readFileSync(
      new URL("../src/lib/api/fixtures/preview-landmarks.pdf", import.meta.url),
    ),
  ];
  await page.addInitScript(() => {
    const resolvers: Array<(value: ArrayBuffer) => void> = [];
    const w = window as unknown as {
      __pdfResolvers: typeof resolvers;
      __mockControl?: MockControl;
    };
    w.__pdfResolvers = resolvers;
    (w.__mockControl ??= {}).previewReadPdf = () =>
      new Promise((resolve) => resolvers.push(resolve));
    localStorage.setItem(
      "explorer-settings",
      JSON.stringify({ showPreviewPane: false }),
    );
  });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "report.pdf" }).click();
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pdfResolvers: unknown[] }).__pdfResolvers
            .length,
      ),
    )
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as { __mockControl: MockControl }).__mockControl
      .previewRevision!("/home/user/Documents/report.pdf"),
  );
  await page.keyboard.press("F5");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __pdfResolvers: unknown[] }).__pdfResolvers
            .length,
      ),
    )
    .toBe(2);
  await page.evaluate(
    (values) =>
      (
        window as unknown as {
          __pdfResolvers: Array<(data: ArrayBuffer) => void>;
        }
      ).__pdfResolvers[1](new Uint8Array(values).buffer),
    bytes,
  );
  await expect(page.locator(".pdf-page.ready")).toBeVisible({ timeout: 15000 });
  await page.evaluate(() =>
    (
      window as unknown as {
        __pdfResolvers: Array<(data: ArrayBuffer) => void>;
      }
    ).__pdfResolvers[0](new TextEncoder().encode("STALE BAD PDF").buffer),
  );
  expect(await centerColor(page)).toEqual([255, 0, 0, 255]);
  await expect(page.locator(".pdf-message[role=alert]")).toHaveCount(0);
  await page.locator(".pdf-viewport").focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".preview-pane")).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const events = JSON.parse(
          document.documentElement.dataset.e2ePdfWorkers || "[]",
        ) as Array<{ id: string; phase: string }>;
        return (
          events
            .filter((e) => e.phase === "ready")
            .every((e) =>
              events.some((t) => t.id === e.id && t.phase === "terminated"),
            ) && events.some((e) => e.phase === "ready")
        );
      }),
    )
    .toBe(true);
});
