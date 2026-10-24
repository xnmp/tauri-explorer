#!/usr/bin/env node
/**
 * Static server for the browser-test bundle (#1381).
 *
 * Serves `E2E_BUILD_DIR` (default `build/`, from `E2E_BROWSER_BUILD=1 bun run
 * build`) on `PORT` (default 1420) the way Tauri's asset protocol and the
 * Vite dev server do for the app: files as themselves, any other path as the
 * SPA fallback `index.html`. Module chunks that `scripts/e2e-browser-build.mjs`
 * emits at their source URL (`/src/...ts`, `/src/...svelte`) are served as
 * JavaScript, because a module script with a non-JS MIME type is rejected.
 * A missing `/src/` or `/node_modules/` file is a 404, never the fallback, so a
 * spec that needs a module the build lacks fails loudly.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {Record<string, string>} */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svelte": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve a request path to the file to serve.
 * @param {string} root absolute build directory
 * @param {string} urlPath request pathname (still percent-encoded)
 * @param {(path: string) => boolean} isFile
 * @returns {{file: string, status: number} | null} null for a rejected path
 */
export function resolveRequest(root, urlPath, isFile) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (isFile(file)) return { file, status: 200 };
  const index = join(file, "index.html");
  if (isFile(index)) return { file: index, status: 200 };
  if (/^\/(?:src|node_modules|_app)\//.test(decoded) || extname(decoded) !== "") {
    return { file: "", status: 404 };
  }
  return { file: join(root, "index.html"), status: 200 };
}

/**
 * A single `bytes=` range, clamped to the file.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{start: number, end: number} | null | "invalid"} null serves the whole file
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** @param {string} path */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {{root: string, port: number}} options
 * @returns {Promise<import("node:http").Server>}
 */
export function serve({ root, port }) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const target = resolveRequest(root, pathname, isFile);
    if (!target || target.status === 404) {
      response.writeHead(target ? 404 : 400, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const size = statSync(target.file).size;
    const headers = {
      "content-type": TYPES[extname(target.file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "accept-ranges": "bytes",
    };
    // Media elements seek with Range requests; answer them as the dev server does.
    const range = parseRange(request.headers.range, size);
    if (range === "invalid") {
      response.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    if (range) {
      response.writeHead(206, {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": range.end - range.start + 1,
      });
    } else {
      response.writeHead(200, { ...headers, "content-length": size });
    }
    if (request.method === "HEAD") response.end();
    else createReadStream(target.file, range ?? {}).pipe(response);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "localhost", () => done(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.E2E_BUILD_DIR || "build");
  if (!isFile(join(root, "index.html"))) {
    console.error(`serve-e2e-build: ${root}/index.html is missing; run E2E_BROWSER_BUILD=1 bun run build`);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 1420);
  await serve({ root, port });
  console.log(`serve-e2e-build: ${root} on http://localhost:${port}`);
}
