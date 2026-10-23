/**
 * Opt-in V8 coverage collector for the test-impact map (#1368).
 *
 * With E2E_COVERAGE=1 (Chromium only), an auto fixture in e2e/fixtures.ts
 * runs each test inside `collectImpactCoverage`: every page the test opens —
 * the default page, `context.newPage()`, pages of contexts made with
 * `browser.newContext()`/`browser.newPage()`, and popups — records precise
 * (block) JS coverage and its same-origin requests. The test then writes one
 * record (scripts/impact-collect.mjs) to E2E_COVERAGE_DIR: the repo files it
 * loaded and exercised, the original source lines it covered, and the repo
 * files it fetched. Static per-file data goes to E2E_COVERAGE_DIR/meta once.
 *
 * Pages created through the patched `newPage` start coverage before the
 * method returns, so nothing the test does afterwards is missed. Popups start
 * when their `page` event arrives, which may miss their first module
 * evaluation but not later calls. No spec opens pages in `beforeAll` or
 * worker fixtures; coverage there would not be recorded.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { RECORD_VERSION, reduceCoverage, requestedRepoFile, type FileMeta } from "../scripts/impact-collect.mjs";

type Entry = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>[number];

export const impactCoverageEnabled = process.env.E2E_COVERAGE === "1";

/** Per-worker cache of static per-module data, keyed by served version. */
const seen = new Map<string, FileMeta>();

export async function collectImpactCoverage(
  browser: Browser,
  context: BrowserContext,
  testInfo: TestInfo,
  use: () => Promise<void>,
) {
  const root = testInfo.config.configFile ? dirname(testInfo.config.configFile) : process.cwd();
  const baseURL = testInfo.project.use.baseURL;
  const origin = baseURL ? new URL(baseURL).origin : null;
  const started = new Map<Page, Promise<void>>();
  const collected: Entry[] = [];
  const requests = new Set<string>();
  const failures: string[] = [];

  const start = (page: Page) => {
    let pending = started.get(page);
    if (!pending) {
      page.on("request", (request) => {
        const own = origin ?? (() => { try { return new URL(page.url()).origin; } catch { return null; } })();
        const file = own ? requestedRepoFile(request.url(), own, root) : null;
        if (file) requests.add(file);
      });
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
    if (page.isClosed()) { failures.push("page closed before its coverage was taken"); return; }
    try { collected.push(...(await page.coverage.stopJSCoverage())); }
    catch (error) { failures.push(`stop: ${String(error)}`); }
  };

  const restore: Array<() => void> = [];
  const patch = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    const original = target[key];
    target[key] = value;
    restore.push(() => { target[key] = original; });
  };
  const instrumentPage = (page: Page) => {
    void start(page);
    const closePage = page.close.bind(page);
    page.close = async (options) => { await collect(page); return closePage(options); };
  };
  const instrument = (ctx: BrowserContext) => {
    for (const page of ctx.pages()) instrumentPage(page);
    ctx.on("page", instrumentPage);
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
    const spec = relative(root, testInfo.file).split("\\").join("/");
    const { metas, ...summary } = reduceCoverage(collected, { root, seen });
    const dir = process.env.E2E_COVERAGE_DIR ?? join(root, "test-results", "impact-coverage");
    mkdirSync(join(dir, "meta"), { recursive: true });
    for (const meta of metas) {
      const id = createHash("sha1").update(`${meta.path}\0${meta.blob}`).digest("hex");
      writeFileSync(join(dir, "meta", `${id}.json`), JSON.stringify(meta));
    }
    const name = `${spec.replace(/[^\w.-]+/g, "_")}-${testInfo.testId}-${testInfo.retry}.json`;
    writeFileSync(join(dir, name), JSON.stringify({
      v: RECORD_VERSION,
      id: testInfo.testId,
      spec,
      title: testInfo.titlePath.slice(1),
      location: `${spec}:${testInfo.line}`,
      retry: testInfo.retry,
      status: testInfo.status,
      failures,
      ...summary,
      requests: [...requests].sort(),
    }));
  }
}
