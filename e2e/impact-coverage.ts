/**
 * Opt-in V8 coverage collector for the test-impact map (#1368).
 *
 * With E2E_COVERAGE=1 (Chromium only), an auto fixture in e2e/fixtures.ts
 * runs each test inside `collectImpactCoverage`: every page the test opens —
 * the default page, `context.newPage()`, pages of contexts made with
 * `browser.newContext()`/`browser.newPage()`, and popups — records precise JS
 * coverage, and the test writes one record of the repo files it loaded and
 * exercised (scripts/impact-coverage.mjs) to E2E_COVERAGE_DIR.
 *
 * Pages created through the patched `newPage` start coverage before the
 * method returns, so nothing the test does afterwards is missed. Popups start
 * when their `page` event arrives, which may miss their first module
 * evaluation but not later calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { summarizeCoverage } from "../scripts/impact-coverage.mjs";

type Entry = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>[number];

export const impactCoverageEnabled = process.env.E2E_COVERAGE === "1";

export async function collectImpactCoverage(
  browser: Browser,
  context: BrowserContext,
  testInfo: TestInfo,
  use: () => Promise<void>,
) {
  const started = new Map<Page, Promise<void>>();
  const collected: Entry[] = [];
  const failures: string[] = [];

  const start = (page: Page) => {
    let pending = started.get(page);
    if (!pending) {
      pending = page.coverage
        .startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
        .catch((error: unknown) => { failures.push(`start: ${String(error)}`); });
      started.set(page, pending);
    }
    return pending;
  };
  const collect = async (page: Page) => {
    const pending = started.get(page);
    if (!pending) return;
    started.delete(page);
    await pending;
    if (page.isClosed()) return;
    try { collected.push(...(await page.coverage.stopJSCoverage())); }
    catch (error) { failures.push(`stop: ${String(error)}`); }
  };

  const restore: Array<() => void> = [];
  const patch = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    const original = target[key];
    target[key] = value;
    restore.push(() => { target[key] = original; });
  };
  const instrument = (ctx: BrowserContext) => {
    for (const page of ctx.pages()) void start(page);
    ctx.on("page", (page) => void start(page));
    const newPage = ctx.newPage.bind(ctx);
    patch(ctx, "newPage", async () => {
      const page = await newPage();
      await start(page);
      return page;
    });
    const close = ctx.close.bind(ctx);
    patch(ctx, "close", async (options?: Parameters<BrowserContext["close"]>[0]) => {
      await Promise.all(ctx.pages().map(collect));
      return close(options);
    });
    ctx.on("page", (page) => {
      const closePage = page.close.bind(page);
      page.close = async (options) => { await collect(page); return closePage(options); };
    });
  };

  instrument(context);
  const newContext = browser.newContext.bind(browser);
  patch(browser, "newContext", async (options?: Parameters<Browser["newContext"]>[0]) => {
    const ctx = await newContext(options);
    instrument(ctx);
    return ctx;
  });
  const browserNewPage = browser.newPage.bind(browser);
  patch(browser, "newPage", async (options?: Parameters<Browser["newPage"]>[0]) => {
    const page = await browserNewPage(options);
    instrument(page.context());
    await start(page);
    return page;
  });

  try {
    await use();
  } finally {
    await Promise.all([...started.keys()].map(collect));
    for (const undo of restore.reverse()) undo();
    const root = testInfo.config.configFile ? dirname(testInfo.config.configFile) : process.cwd();
    const spec = relative(root, testInfo.file).split("\\").join("/");
    const summary = summarizeCoverage(collected);
    const dir = process.env.E2E_COVERAGE_DIR ?? "test-results/impact-coverage";
    mkdirSync(dir, { recursive: true });
    const name = `${spec.replace(/[^\w.-]+/g, "_")}-${testInfo.testId}-${testInfo.retry}.json`;
    writeFileSync(join(dir, name), JSON.stringify({ spec, test: testInfo.title, failures, ...summary }));
    if (process.env.E2E_COVERAGE_RAW === "1") {
      writeFileSync(join(dir, `${name}.urls`), [...new Set(collected.map((e) => e.url))].sort().join("\n"));
    }
  }
}
