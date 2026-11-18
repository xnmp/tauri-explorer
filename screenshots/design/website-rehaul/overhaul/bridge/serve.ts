/**
 * Serve the marketing-site mocks with the embedded app demo (`bun run demo:serve`).
 *
 *   /app/...  → build-demo/ (`bun run build:demo`; unknown routes fall back to its index.html)
 *   /...      → screenshots/design/website-rehaul/overhaul/, then its parent
 *               (so fixtures' `../peel-mock/assets/` URLs resolve)
 *
 * Kept beside the bridge (not in scripts/) because it is a site tool, not a CI input.
 * PORT overrides the default 1455 (1420 belongs to the dev server).
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

// This file lives in <repo>/screenshots/design/website-rehaul/overhaul/bridge/.
const siteDir = resolve(import.meta.dir, "..");
const fallbackDir = resolve(siteDir, "..");
const appDir = resolve(siteDir, "../../../../build-demo");
const port = Number(process.env.PORT ?? 1455);

/** A regular file inside `root` for the URL path, or null (never escapes `root`). */
function fileUnder(root: string, urlPath: string): string | null {
  const candidate = normalize(join(root, decodeURIComponent(urlPath)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  const path = existsSync(candidate) && statSync(candidate).isDirectory() ? join(candidate, "index.html") : candidate;
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

if (!existsSync(join(appDir, "index.html"))) {
  console.warn("build-demo/ is missing; run `bun run build:demo` first. Serving the site pages only.");
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/app") return Response.redirect("/app/", 302);
    let path: string | null;
    if (pathname.startsWith("/app/")) {
      const rest = pathname.slice("/app".length);
      path = fileUnder(appDir, rest) ?? (/\.[a-z0-9]+$/i.test(rest) ? null : fileUnder(appDir, "/index.html"));
    } else {
      path = fileUnder(siteDir, pathname) ?? fileUnder(fallbackDir, pathname);
    }
    if (!path) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(path), { headers: { "Cache-Control": "no-store" } });
  },
});

console.log(`Site demo: http://127.0.0.1:${server.port}/real.html?fs=station`);
