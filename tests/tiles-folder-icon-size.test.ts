/**
 * Tiles view icon size at the Small preset, measured in a real browser (#1049).
 *
 * The regression is a CSS layout result (a bare 64px icon `<svg>` flex-shrunk
 * to the 48px icon slot before the tile scale is applied), so no Node-side
 * seam can observe it. This test serves the real app from a private Vite dev
 * server, drives it with Playwright's Chromium, and asserts the rendered size
 * the user sees. The broader per-preset coverage and the evidence screenshots
 * live in `e2e/tile-folder-icon-size.spec.ts`; this file exists so the unit
 * gate (`vitest run`) catches the regression too.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THUMBNAIL_SIZE_CONFIG } from "../src/lib/domain/tile-layout";

const STARTUP_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

const PLAIN_FOLDER = "/home/user/Documents";
const GIT_FOLDER = "/home/user/my-project";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function waitForServer(url: string, child: ChildProcess, log: string[]): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite dev exited early (${child.exitCode}):\n${log.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`vite dev never became ready at ${url}:\n${log.join("")}`);
}

/** Rendered width/height (CSS px, after the tile scale) of a tile's icon graphic. */
async function renderedIconSize(page: Page, selector: string): Promise<{ w: number; h: number }> {
  const slot = page.locator(selector);
  await slot.waitFor({ state: "visible", timeout: 10_000 });
  return slot.evaluate((element) => {
    const graphic = element.querySelector(":scope > svg, :scope > .icon-cat, :scope > .folder-thumb > svg, :scope > .folder-thumb > .icon-cat");
    if (!graphic) throw new Error(`no icon graphic under ${element.className}`);
    const r = graphic.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
}

/** Right-click genuinely empty space below the last entry so the background menu opens. */
async function openBackgroundMenu(page: Page): Promise<void> {
  const content = page.locator(".file-list .content").first();
  const box = await content.boundingBox();
  const lastBox = await page.locator(".entry-item").last().boundingBox();
  if (!box || !lastBox) throw new Error("file list not laid out");
  const clickY = Math.min(Math.round(lastBox.y + lastBox.height - box.y) + 12, Math.round(box.height) - 8);
  await content.click({ button: "right", position: { x: 10, y: clickY } });
  await page.locator(".context-menu").waitFor({ state: "visible", timeout: 5_000 });
}

describe("Tiles view folder icon size at the Small preset (#1049)", () => {
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page;
  const serverLog: string[] = [];

  beforeAll(async () => {
    const port = await freePort();
    const url = `http://localhost:${port}/`;
    server = spawn("bunx", ["vite", "dev"], {
      cwd: process.cwd(),
      env: { ...process.env, DEV_PORT: String(port), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    server.stdout?.on("data", (chunk) => serverLog.push(String(chunk)));
    server.stderr?.on("data", (chunk) => serverLog.push(String(chunk)));
    await waitForServer(url, server, serverLog);

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    page = await browser.newPage({ viewport: { width: 1100, height: 720 } });

    await page.goto(`${url}?path=/home/user`);
    await page.locator(".entry-item").first().waitFor({ timeout: 60_000 });

    // Tiles view via the background context menu, like a user would.
    await openBackgroundMenu(page);
    await page.locator('.context-menu .menu-item:has-text("Tiles")').click();
    await page.locator(".tiles-view .entry-item").first().waitFor({ timeout: 10_000 });

    // Small preset via the real Settings dialog.
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog");
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const row = dialog.locator(".setting-row").filter({ has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }) });
    await row.scrollIntoViewIfNeeded();
    await row.locator("select").selectOption("small");
    await dialog.locator(".close-btn").click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    await page.locator(".tile-surface").evaluate(
      (surface, size) => new Promise<void>((resolve) => {
        const check = () => getComputedStyle(surface).getPropertyValue("--tile-icon-size").trim() === size ? resolve() : requestAnimationFrame(check);
        check();
      }),
      `${THUMBNAIL_SIZE_CONFIG.small.displaySize}px`,
    );
  }, STARTUP_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.pid && server.exitCode === null) {
      try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
    }
  });

  it("renders a plain folder and a git-repo folder at the same 48px icon size", async () => {
    const size = THUMBNAIL_SIZE_CONFIG.small.displaySize;
    const plain = await renderedIconSize(page, `.tiles-view .entry-item[data-path="${PLAIN_FOLDER}"] .tile-icon`);
    const git = await renderedIconSize(page, `.tiles-view .entry-item[data-path="${GIT_FOLDER}"] .tile-icon`);
    expect(plain).toEqual({ w: size, h: size });
    expect(git).toEqual({ w: size, h: size });
  }, TEST_TIMEOUT_MS);

  it("renders the inline New folder tile's icon at the 48px icon size", async () => {
    const size = THUMBNAIL_SIZE_CONFIG.small.displaySize;
    await openBackgroundMenu(page);
    await page.locator('.context-menu .menu-item:has-text("New folder")').click();
    await page.locator(".new-folder-input").waitFor({ state: "visible", timeout: 5_000 });
    const measured = await renderedIconSize(page, ".tile-inline-new-folder .tile-icon");
    await page.keyboard.press("Escape");
    expect(measured).toEqual({ w: size, h: size });
  }, TEST_TIMEOUT_MS);
});
