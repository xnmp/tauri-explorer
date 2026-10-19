import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";
const ROOT = "/preview-regressions";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const root = "/preview-regressions";
    const canvas = document.createElement("canvas");
    canvas.width = 1024; canvas.height = 577;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#558db2"; context.fillRect(0, 0, 1024, 577);
    context.fillStyle = "#d2ecff"; context.font = "60px sans-serif";
    context.fillText("7680 × 4320 source", 150, 260);
    const url = canvas.toDataURL();
    (globalThis as { __mockControl?: MockControl }).__mockControl = {
      directoryEntries: () => ["LICENSE", "notes.txt", "notes.md", "index.ts", "wallpaper.jpg", "other.jpg"].map(name => ({
        name, path: `${root}/${name}`, kind: "file", size: 10_000_000, modified: "2026-10-18T00:00:00Z",
      })),
      previewReadText: path => path.endsWith(".md")
        ? "# Heading\nParagraph text with `inline code`.\n\n```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Test | 42 |"
        : path.endsWith(".ts") ? "export const answer = 42;"
        : "MIT License\nCopyright (c) 2026 xnmp\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.",
      previewImageSource: () => ({ kind: "rendition", path: "/cache/wallpaper.preview.png" }),
      previewReadImage: () => url,
      imageResolution: path => path.endsWith("other.jpg") ? { width: 3000, height: 4000 } : { width: 7680, height: 4320 },
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?path=${ROOT}`);
  await applySettingsAndReload(page, { showPreviewPane: true, showPreviewInfo: true, previewPanePosition: "right", previewPaneWidth: 480, previewFontSize: 18 });
  await waitForEntries(page);
});

test("plain text stays in the theme text colour without guessed syntax tokens", async ({ page }) => {
  for (const name of ["LICENSE", "notes.txt"]) {
    await page.locator(`.entry-item[data-path="${ROOT}/${name}"]`).click();
    const preview = page.locator(".preview-text");
    await expect(preview).toContainText("Permission is hereby granted");
    await expect(preview).toHaveCSS("font-size", "18px");
    await expect(preview.locator('[class*="hljs"]')).toHaveCount(0);
    const colours = await preview.evaluate(element => {
      const swatch = document.createElement("span");
      swatch.style.color = "var(--text-secondary)";
      element.appendChild(swatch);
      const expected = getComputedStyle(swatch).color;
      swatch.remove();
      return { actual: getComputedStyle(element).color, expected };
    });
    expect(colours.actual).toBe(colours.expected);
    if (process.env.CAPTURE_EVIDENCE && name === "LICENSE") await page.screenshot({ path: "screenshots/fix/preview/1244-plain-license.png" });
  }
});

test("prose and code share the configured base size and markdown scales with it", async ({ page }) => {
  await page.locator(`.entry-item[data-path="${ROOT}/index.ts"]`).click();
  const code = page.locator(".preview-code code");
  await expect(code).toContainText("answer");
  await expect(code).toHaveCSS("font-size", "18px");
  await expect(code.locator(".hljs-keyword").first()).toHaveCSS("font-size", "18px");
  if (process.env.CAPTURE_EVIDENCE) await page.screenshot({ path: "screenshots/fix/preview/1245-code-font.png" });
  await page.locator(`.entry-item[data-path="${ROOT}/notes.md"]`).click();
  const markdown = page.locator(".preview-markdown");
  await expect(markdown.locator("p")).toHaveCSS("font-size", "18px");
  await expect(markdown.locator("p code")).toHaveCSS("font-size", "18px");
  await expect(markdown.locator("pre code")).toHaveCSS("font-size", "18px");
  await expect(markdown.locator("td").first()).toHaveCSS("font-size", "18px");
  expect(await markdown.locator("h1").evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThan(18);
  if (process.env.CAPTURE_EVIDENCE) await page.screenshot({ path: "screenshots/fix/preview/1245-markdown-font.png" });
});

test("pixel metadata describes the original when the image shows a smaller rendition", async ({ page }) => {
  const pixels = page.locator(".preview-info .info-row", { hasText: "Pixels" }).locator(".info-value");
  await page.locator(`.entry-item[data-path="${ROOT}/wallpaper.jpg"]`).click();
  await expect(page.locator("img.preview-image")).toBeVisible();
  await expect(pixels).toHaveText("7680 × 4320");
  expect(await page.locator("img.preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1024);
  if (process.env.CAPTURE_EVIDENCE) await page.screenshot({ path: "screenshots/fix/preview/1299-source-pixels.png" });
  await page.locator(`.entry-item[data-path="${ROOT}/other.jpg"]`).click();
  await expect(pixels).toHaveText("3000 × 4000");
});
