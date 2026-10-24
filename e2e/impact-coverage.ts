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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page, TestInfo } from "@playwright/test";
import { CHUNK_MODULES_FILE } from "../scripts/e2e-browser-build.mjs";
import { chunkSegments } from "../scripts/impact-bundle.mjs";
import { RECORD_VERSION, reduceCoverage, requestedRepoFile, type FileMeta } from "../scripts/impact-collect.mjs";
import { repoPathFromUrl } from "../scripts/impact-coverage.mjs";

type Entry = {
  url: string;
  source?: string;
  functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
};

/**
 * `E2E_COVERAGE=1`: Playwright's block coverage on the dev server (the
 * nightly map). `E2E_COVERAGE=function`: function-level V8 coverage over CDP
 * (#1386), cheap enough for every dev push; on the shared bundle
 * (`E2E_BUILD_DIR`) its chunks map back to source through their hidden maps.
 */
export const impactCoverageEnabled = process.env.E2E_COVERAGE === "1" || process.env.E2E_COVERAGE === "function";
const functionMode = process.env.E2E_COVERAGE === "function";

/** Per-worker cache of static per-module data, keyed by served version. */
const seen = new Map<string, FileMeta | true>();
/** Per-worker caches of bundle chunk mappings and dev-server module sources. */
const chunks = new Map<string, (ReturnType<typeof chunkSegments> & { modules: string[] }) | null>();
let chunkModules: Record<string, string[]> | undefined;
const sources = new Map<string, string | null>();

/** The bundle chunk a script URL names, with its hidden source map, if any. */
function bundleChunk(url: string, bundleOrigin: string | null, buildDir: string | null) {
  if (!buildDir || !bundleOrigin) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== bundleOrigin || !parsed.pathname.startsWith("/_app/") || !parsed.pathname.endsWith(".js")) return null;
  const path = parsed.pathname.slice(1);
  if (!chunks.has(path)) {
    try {
      chunkModules ??= JSON.parse(readFileSync(join(buildDir, CHUNK_MODULES_FILE), "utf8")) as Record<string, string[]>;
      const modules = chunkModules[path] ?? [];
      // Facade and dependency-only chunks hold no repository module and may
      // have no map; they map to nothing rather than to a failure.
      chunks.set(path, modules.length === 0
        ? { paths: [], sourcesContent: [], offsets: new Int32Array(), files: new Int32Array(), lines: new Int32Array(), modules }
        : {
          ...chunkSegments(path, readFileSync(join(buildDir, path), "utf8"),
            JSON.parse(readFileSync(join(buildDir, `${path}.map`), "utf8"))),
          modules,
        });
    } catch {
      chunks.set(path, null);
    }
  }
  return chunks.get(path) ?? null;
}

/** A dev-server module's served source (with its inline map), fetched once per worker. */
async function devSource(url: string): Promise<string | null> {
  if (!sources.has(url)) {
    try {
      const response = await fetch(url);
      sources.set(url, response.ok ? await response.text() : null);
    } catch {
      sources.set(url, null);
    }
  }
  return sources.get(url) ?? null;
}

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
  const sessions = new Map<Page, CDPSession>();
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
      pending = (functionMode
        ? (async () => {
          const session = await page.context().newCDPSession(page);
          sessions.set(page, session);
          await session.send("Profiler.enable");
          await session.send("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
        })()
        : page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false }))
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
    try {
      if (functionMode) {
        const session = sessions.get(page);
        sessions.delete(page);
        if (!session) { failures.push("no coverage session"); return; }
        const { result } = await session.send("Profiler.takePreciseCoverage");
        collected.push(...result.filter((script) => /^https?:/.test(script.url)));
        await session.detach().catch(() => undefined);
      } else {
        collected.push(...(await page.coverage.stopJSCoverage()));
      }
    } catch (error) { failures.push(`stop: ${String(error)}`); }
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
    const buildDir = process.env.E2E_BUILD_DIR ? resolve(root, process.env.E2E_BUILD_DIR) : null;
    const chunk = (url: string) => bundleChunk(url, origin, buildDir);
    if (functionMode) {
      // Modules from a dev server (specs beside the bundle, or no bundle)
      // carry their inline source map only in the served text.
      for (const script of collected) {
        const fromBundle = Boolean(buildDir && origin && script.url.startsWith(`${origin}/`));
        // A bundle chunk without its mapping data would drop that chunk's
        // modules silently: mark the record incomplete instead.
        if (fromBundle && /\/_app\/.*\.js$/.test(new URL(script.url).pathname) && !chunk(script.url)) {
          failures.push(`no source map or module list for ${script.url}`);
        }
        if (!fromBundle && repoPathFromUrl(script.url)) script.source = (await devSource(script.url)) ?? undefined;
      }
    }
    const { metas, ...summary } = reduceCoverage(collected, { root, seen, chunk });
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
