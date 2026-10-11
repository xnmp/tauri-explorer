import { test, expect, type Page } from "./fixtures";

/** Chromium cannot reproduce WebKitGTK's surface dropout. Pin the observable
 * opacity and entrance-keyframe contract established by native recordings. */
async function probe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { frames: 0, translucent: 0, composited: [] as string[] };
    (window as any).modalOpening = state;
    const inspect = () => {
      for (const overlay of document.querySelectorAll<HTMLElement>(".modal-overlay")) {
        if (getComputedStyle(overlay).visibility === "hidden") continue;
        state.frames++;
        for (const element of [overlay, ...overlay.querySelectorAll<HTMLElement>(".modal-card, .plugin-dialog, .settings-dialog, .panel, .dialog-icon")]) {
          if (getComputedStyle(element).opacity !== "1") state.translucent++;
        }
        for (const animation of overlay.getAnimations({ subtree: true })) {
          if (animation.effect?.getTiming().iterations === Infinity) continue;
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          if (frames.some(frame => ["opacity", "transform", "translate", "scale", "rotate", "filter", "backdropFilter"].some(property => property in frame))) {
            const target = (animation.effect as KeyframeEffect).target as Element;
            state.composited.push(target.className);
          }
        }
      }
    };
    // Inspect at insertion as well as each frame: WebKit may complete an
    // entrance before dispatching animation events or the next rAF.
    new MutationObserver(inspect).observe(document.body, { childList: true, subtree: true });
    const frame = () => { inspect(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
}

async function stable(page: Page): Promise<void> {
  await page.waitForTimeout(700);
  const result = await page.evaluate(() => (window as any).modalOpening);
  expect(result.frames).toBeGreaterThan(0);
  expect(result.translucent).toBe(0);
  expect(result.composited).toEqual([]);
}

test("delete confirmation stays opaque through opening and Escape preserves the files", async ({ page }, info) => {
  await page.goto("/?path=/home/user");
  const row = page.locator(".entry-item").first();
  await row.waitFor(); await row.click(); await row.focus();
  const count = await page.locator(".entry-item").count();
  await probe(page);
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alertdialog")).toContainText("Delete");
  await stable(page);
  await expect(page.getByRole("alertdialog")).toHaveCSS("backdrop-filter", "blur(4px)");
  await page.screenshot({ path: info.outputPath("builtin-modal.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator(".entry-item")).toHaveCount(count);
  await expect(row).toBeFocused();
});

test("settings opens without composited entrance animations and remains usable", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
  await probe(page);
  await page.keyboard.press("Control+,");
  const search = page.locator(".settings-search");
  await expect(search).toBeFocused();
  await stable(page);
  await search.fill("theme");
  await expect(page.locator(".settings-dialog")).toContainText(/theme/i);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
});

test("the shared modal overrides legacy plugin fade/scale CSS", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
  await page.keyboard.press("Control+,");
  await page.locator(".settings-dialog").waitFor();
  // Match a plugin's component-scoped specificity and load its CSS after the
  // host, so passing requires the shared modal's stronger entrance policy.
  await page.addStyleTag({ content: ".settings-dialog.plugin-dialog { animation: legacy-plugin-in 150ms linear; } @keyframes legacy-plugin-in { from { opacity:0; transform:scale(.98); } to { opacity:1; transform:scale(1); } }" });
  await probe(page);
  await page.locator(".settings-dialog").evaluate(element => element.classList.add("plugin-dialog"));
  await stable(page);
  await expect(page.locator(".settings-search")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
});
