import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { baseURLFor, DEV_BESIDE_BUNDLE_PORT, needsDevServer } from "../e2e/app-server";
import { classifyPageUrls, findPageUrls, shimSource } from "../scripts/e2e-browser-build.mjs";
import { parseRange, resolveRequest, serve } from "../scripts/serve-e2e-build.mjs";

describe("findPageUrls", () => {
  it("collects root-relative source and package URLs from every quote style", () => {
    const sources = [
      `await page.evaluate(() => import("/src/lib/state/window-tabs.svelte.ts"));`,
      `new Function("return import('/src/lib/state/settings.svelte.ts')");`,
      "const url = `/node_modules/svelte/src/index-client.js`;",
      `const moduleUrl = "/src/lib/api/mock-fixtures.ts"; await import(moduleUrl);`,
    ];
    expect(findPageUrls(sources)).toEqual([
      "/node_modules/svelte/src/index-client.js",
      "/src/lib/api/mock-fixtures.ts",
      "/src/lib/state/settings.svelte.ts",
      "/src/lib/state/window-tabs.svelte.ts",
    ]);
  });

  it("ignores Node-side relative imports and strips queries", () => {
    const sources = [
      `import { mockControl } from "../src/lib/api/mock-control";`,
      `fetch("/src/lib/api/fixtures/video-preview.webm?t=1")`,
    ];
    expect(findPageUrls(sources)).toEqual(["/src/lib/api/fixtures/video-preview.webm"]);
  });

  it("returns nothing for empty or URL-free sources", () => {
    expect(findPageUrls([])).toEqual([]);
    expect(findPageUrls(["", "page.goto('/?path=/home/user')"])).toEqual([]);
  });
});

describe("classifyPageUrls", () => {
  const files = new Set([
    "src/lib/state/window-tabs.svelte.ts",
    "src/test-support/modal/PaneTestDialog.svelte",
    "node_modules/svelte/src/index-client.js",
    "src/lib/api/fixtures/preview-landmarks.pdf",
  ]);
  const isFile = (path: string) => files.has(path);

  it("emits modules as chunks and other files as assets", () => {
    expect(
      classifyPageUrls(
        [
          "/node_modules/svelte/src/index-client.js",
          "/src/lib/api/fixtures/preview-landmarks.pdf",
          "/src/lib/state/window-tabs.svelte.ts",
          "/src/test-support/modal/PaneTestDialog.svelte",
        ],
        isFile,
      ),
    ).toEqual({
      modules: [
        "node_modules/svelte/src/index-client.js",
        "src/lib/state/window-tabs.svelte.ts",
        "src/test-support/modal/PaneTestDialog.svelte",
      ],
      assets: ["src/lib/api/fixtures/preview-landmarks.pdf"],
    });
  });

  it("drops mock filesystem paths that name no file, and traversal", () => {
    expect(
      classifyPageUrls(["/src/components/Button", "/src/../package.json"], (path) =>
        path !== "src/components/Button",
      ),
    ).toEqual({ modules: [], assets: [] });
  });
});

describe("shimSource", () => {
  it("re-exports the shared chunk, with default only when it has one", () => {
    const named = shimSource({
      shimPath: "src/lib/state/window-tabs.svelte.ts",
      chunkFile: "_app/immutable/entry/window-tabs.svelte.abc.js",
      exports: ["windowTabsManager"],
      css: [],
    });
    expect(named).toBe('export * from "../../../_app/immutable/entry/window-tabs.svelte.abc.js";\n');
    const component = shimSource({
      shimPath: "src/lib/components/PluginsDialog.svelte",
      chunkFile: "_app/immutable/entry/PluginsDialog.def.js",
      exports: ["default"],
      css: ["_app/immutable/assets/Modal.css"],
    });
    expect(component).toContain('["../../../_app/immutable/assets/Modal.css"]');
    expect(component).toContain('export { default } from "../../../_app/immutable/entry/PluginsDialog.def.js";');
  });
});

describe("app server per spec", () => {
  const spec = (name: string) => fileURLToPath(new URL(`../e2e/${name}`, import.meta.url));

  it("classifies request interception as needing the dev server", () => {
    expect(needsDevServer(`await page.route("**/FilePicker.svelte*", (r) => r.abort());`)).toBe(true);
    expect(needsDevServer("await context.routeFromHAR(file);")).toBe(true);
    expect(needsDevServer(`await page.goto("/?path=/home/user");`)).toBe(false);
    expect(needsDevServer("")).toBe(false);
    expect(needsDevServer("// e2e-app-server: dev (#1384). Retire-when: #1384 closed")).toBe(true);
  });

  it("keeps the configured server outside bundle mode", () => {
    const saved = process.env.E2E_BUILD_DIR;
    delete process.env.E2E_BUILD_DIR;
    try {
      expect(baseURLFor(spec("lazy-dialog-failure.spec.ts"), "http://localhost:1420")).toBe("http://localhost:1420");
    } finally {
      if (saved !== undefined) process.env.E2E_BUILD_DIR = saved;
    }
  });

  it("sends routing specs to the dev server and others to the bundle, including via fixtures", () => {
    const saved = process.env.E2E_BUILD_DIR;
    process.env.E2E_BUILD_DIR = "build";
    try {
      const configured = "http://localhost:1420";
      // fixtures.ts and its imports must not themselves look like interception.
      expect(baseURLFor(spec("activity-bar.spec.ts"), configured)).toBe(configured);
      expect(baseURLFor(spec("lazy-dialog-failure.spec.ts"), configured)).toBe(
        `http://localhost:${DEV_BESIDE_BUNDLE_PORT}`,
      );
      // An unreadable spec is the safe side: the dev server.
      expect(baseURLFor(spec("does-not-exist.spec.ts"), configured)).toBe(
        `http://localhost:${DEV_BESIDE_BUNDLE_PORT}`,
      );
    } finally {
      if (saved === undefined) delete process.env.E2E_BUILD_DIR;
      else process.env.E2E_BUILD_DIR = saved;
    }
  });
});

describe("resolveRequest", () => {
  const root = "/srv/build";
  const present = new Set([
    "/srv/build/index.html",
    "/srv/build/_app/immutable/entry/start.js",
    "/srv/build/src/lib/state/window-tabs.svelte.ts",
  ]);
  const isFile = (path: string) => present.has(path);

  it("serves existing files as themselves", () => {
    expect(resolveRequest(root, "/src/lib/state/window-tabs.svelte.ts", isFile)).toEqual({
      file: "/srv/build/src/lib/state/window-tabs.svelte.ts",
      status: 200,
    });
  });

  it("serves the SPA fallback for app routes", () => {
    expect(resolveRequest(root, "/", isFile)).toEqual({ file: "/srv/build/index.html", status: 200 });
    expect(resolveRequest(root, "/settings", isFile)).toEqual({
      file: "/srv/build/index.html",
      status: 200,
    });
  });

  it("404s a missing module or asset instead of answering with HTML", () => {
    expect(resolveRequest(root, "/src/lib/state/missing.ts", isFile)?.status).toBe(404);
    expect(resolveRequest(root, "/node_modules/svelte/src/index-client.js", isFile)?.status).toBe(404);
    expect(resolveRequest(root, "/_app/immutable/chunks/gone.js", isFile)?.status).toBe(404);
    expect(resolveRequest(root, "/favicon.ico", isFile)?.status).toBe(404);
  });

  it("rejects traversal and malformed encodings", () => {
    expect(resolveRequest(root, "/../etc/passwd", isFile)).toBeNull();
    expect(resolveRequest(root, "/%2e%2e/etc/passwd", isFile)).toBeNull();
    expect(resolveRequest(root, "/%E0%A4%A", isFile)).toBeNull();
  });
});

describe("parseRange", () => {
  it("serves whole files without a usable range", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });

  it("clamps open, suffix and oversized ranges to the file", () => {
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=-30", 100)).toEqual({ start: 70, end: 99 });
    expect(parseRange("bytes=0-1000", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects ranges outside the file", () => {
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=5-2", 100)).toBe("invalid");
    expect(parseRange("bytes=0-", 0)).toBe("invalid");
  });
});

describe("serve", () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "e2e-build-"));
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dir, "src/lib/module.svelte.ts"), "export const answer = 42;");
    server = await serve({ root: dir, port: 0 });
    const address = server.address();
    base = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves source-URL chunks as JavaScript so module scripts accept them", async () => {
    const response = await fetch(`${base}/src/lib/module.svelte.ts`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(await response.text()).toBe("export const answer = 42;");
  });

  it("answers app routes with the SPA page and missing modules with 404", async () => {
    const page = await fetch(`${base}/?path=/home/user`);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("<title>app</title>");
    expect((await fetch(`${base}/src/lib/absent.ts`)).status).toBe(404);
  });

  it("answers byte ranges for media seeking", async () => {
    const response = await fetch(`${base}/src/lib/module.svelte.ts`, { headers: { range: "bytes=7-11" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 7-11/25");
    expect(await response.text()).toBe("const");
    expect((await fetch(`${base}/index.html`, { headers: { range: "bytes=999-" } })).status).toBe(416);
  });
});
