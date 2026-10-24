/**
 * Browser-test build flavour (#1381).
 *
 * CI builds the frontend once and serves the bundle to every browser
 * Playwright shard (`scripts/serve-e2e-build.mjs`) instead of starting a Vite
 * dev server per shard. Some specs reach live module instances from the page,
 * e.g. `import("/src/lib/state/window-tabs.svelte.ts")`. On the dev server that
 * URL is the app's own module; in an ordinary bundle it does not exist.
 *
 * With `E2E_BROWSER_BUILD=1`, this plugin emits every module that a spec names
 * by such a root-relative URL as an entry chunk with its full export
 * signature, and writes a small module AT THAT URL that loads the chunk's
 * stylesheets and re-exports it. Rollup never duplicates a module, so the app
 * imports the same chunk file and the spec and the app share one instance, as
 * they do under Vite dev. Non-module files a spec fetches the same way (video
 * and PDF fixtures) are copied to their URL too.
 *
 * The flavour is the production bundle otherwise: E2E hooks stay off
 * (`VITE_E2E_HOOKS` is unset, as on the dev server), and an ordinary build
 * without the env variable is unchanged, so the release bundle and
 * `check:bundle` see none of this. A spec URL that names a missing file is
 * ignored (specs also contain mock filesystem paths such as `/src/components`);
 * if a spec really needs it, it fails loudly with a 404 rather than passing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

const MODULE_EXTENSIONS = /\.(?:[cm]?[jt]s|svelte)$/;
const URL_LITERAL = /["'`](\/(?:src|node_modules)\/[^"'`\s?#]+)/g;

/**
 * Root-relative `/src/...` and `/node_modules/...` URLs that spec sources name
 * in string literals.
 * @param {string[]} sources
 * @returns {string[]} unique, sorted
 */
export function findPageUrls(sources) {
  const urls = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(URL_LITERAL)) urls.add(match[1]);
  }
  return [...urls].sort();
}

/**
 * Split the URLs that name real files into modules (emitted as chunks) and
 * plain assets (copied verbatim).
 * @param {string[]} urls
 * @param {(relativePath: string) => boolean} isFile
 * @returns {{modules: string[], assets: string[]}} repository-relative paths
 */
export function classifyPageUrls(urls, isFile) {
  /** @type {string[]} */
  const modules = [];
  /** @type {string[]} */
  const assets = [];
  for (const url of urls) {
    const path = url.slice(1);
    if (path.split("/").includes("..") || !isFile(path)) continue;
    (MODULE_EXTENSIONS.test(path) ? modules : assets).push(path);
  }
  return { modules, assets };
}

/** @param {string} dir */
function specSources(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => /\.[cm]?[jt]s$/.test(file))
    .map((file) => readFileSync(join(dir, file), "utf8"));
}

/**
 * The module served at a spec's URL: it loads the stylesheets the real chunk
 * statically depends on (an entry chunk gets no CSS preloading, unlike the
 * app's own dynamic imports), then re-exports that chunk, whose module
 * instance the app shares.
 * @param {{shimPath: string, chunkFile: string, exports: string[], css: string[]}} target
 * @returns {string}
 */
export function shimSource({ shimPath, chunkFile, exports, css }) {
  const relative = (/** @type {string} */ file) => {
    const path = posix.relative(posix.dirname(shimPath), file);
    return path.startsWith(".") ? path : `./${path}`;
  };
  const from = JSON.stringify(relative(chunkFile));
  const lines = [];
  if (css.length > 0) {
    lines.push(
      `await Promise.all(${JSON.stringify(css.map(relative))}.map((path) => {`,
      "  const href = new URL(path, import.meta.url).href;",
      "  if ([...document.styleSheets].some((sheet) => sheet.href === href)) return null;",
      "  return new Promise((done) => {",
      '    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });',
      "    link.onload = link.onerror = done;",
      "    document.head.append(link);",
      "  });",
      "}));",
    );
  }
  lines.push(`export * from ${from};`);
  if (exports.includes("default")) lines.push(`export { default } from ${from};`);
  return `${lines.join("\n")}\n`;
}

/**
 * Stylesheets a chunk and its static imports carry (Vite's `importedCss`).
 * @param {string} fileName
 * @param {Record<string, any>} bundle
 * @returns {string[]}
 */
function staticCss(fileName, bundle, seen = new Set()) {
  if (seen.has(fileName)) return [];
  seen.add(fileName);
  const chunk = bundle[fileName];
  if (!chunk || chunk.type !== "chunk") return [];
  return [
    ...(chunk.viteMetadata?.importedCss ?? []),
    ...chunk.imports.flatMap((/** @type {string} */ file) => staticCss(file, bundle, seen)),
  ];
}

/**
 * @param {{enabled: boolean, root?: string, specDir?: string}} options
 * @returns {import("vite").Plugin}
 */
export function e2eBrowserBuild({ enabled, root = process.cwd(), specDir = "e2e" }) {
  let ssr = false;
  /** @type {Array<{path: string, ref: string}>} */
  let emitted = [];
  return {
    name: "tauri-explorer:e2e-browser-build",
    apply: "build",
    configResolved(config) {
      ssr = Boolean(config.build.ssr);
    },
    buildStart() {
      emitted = [];
      if (!enabled || ssr) return;
      const isFile = (/** @type {string} */ path) => {
        const full = resolve(root, path);
        return existsSync(full) && statSync(full).isFile();
      };
      const refs = classifyPageUrls(findPageUrls(specSources(resolve(root, specDir))), isFile);
      for (const path of refs.modules) {
        const ref = this.emitFile({
          type: "chunk",
          id: resolve(root, path),
          name: `e2e-page/${path.replace(/\.[^./]+$/, "")}`,
          preserveSignature: "strict",
        });
        emitted.push({ path, ref });
      }
      for (const path of refs.assets) {
        this.emitFile({ type: "asset", fileName: path, source: readFileSync(resolve(root, path)) });
      }
    },
    generateBundle(_options, bundle) {
      for (const { path, ref } of emitted) {
        const chunkFile = this.getFileName(ref);
        const chunk = bundle[chunkFile];
        if (!chunk || chunk.type !== "chunk") this.error(`e2e-browser-build: no chunk for ${path}`);
        const css = [...new Set(staticCss(chunkFile, bundle))].sort();
        this.emitFile({
          type: "asset",
          fileName: path,
          source: shimSource({ shimPath: path, chunkFile, exports: chunk.exports, css }),
        });
      }
    },
  };
}
