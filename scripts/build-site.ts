/**
 * `bun scripts/build-site.ts <out-dir>`: assemble the marketing site (the
 * Workshop, #1789) into a tree Vercel can deploy.
 *
 * The Vercel project's Root Directory is `website`, so the tree is
 * `<out-dir>/website/...`; deploy with `bunx vercel deploy` from `<out-dir>`
 * (the project link, `website/.vercel/project.json`, is copied to
 * `<out-dir>/.vercel/` when it exists; it is gitignored).
 *
 *   /            the Workshop (workshop.html) with its scripts, styles, fixtures and assets
 *   /app/...     the embedded app: `build-demo/` (run `bun run build:demo` first)
 *   /api/...     the user-report relay, with `website/package.json` and its lockfile
 *
 * Same URL layout as `scripts/demo-serve.ts`, so what was checked locally is
 * what ships. Page files are taken from git (`git ls-files`), so agent
 * captures and other untracked files never ship; the one exception is the
 * film, which is deliberately untracked and copied when present.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoDir = resolve(import.meta.dir, "..");
const pagesDir = "screenshots/design/website-rehaul/overhaul";
const sharedAssets = "screenshots/design/website-rehaul/peel-mock/assets";
const FRONT_PAGE = "workshop.html";
/** Untracked on purpose (17 MB); shipped when the file is there. */
const UNTRACKED_MEDIA = [`${pagesDir}/assets-expedition/the-valley.mp4`];
/** Other mocks, harnesses and notes that are not part of the public site. */
const NOT_PUBLISHED = /(^|\/)(README\.md|index\.html|base\.html|machine\.html|prompt\.html|real\.html)$/;
const RELAY_FILES = ["api/_report-core.js", "api/_report-triage.js", "api/report.js", "package.json", "bun.lock"];

function tracked(dir: string): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "--", dir], { cwd: repoDir, encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`git ls-files failed for ${dir}: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

function copy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

/** Vercel config: the relay's rules, plus the app's SPA fallback and cache lifetimes. */
function vercelConfig(): string {
  const config = JSON.parse(readFileSync(join(repoDir, "website/vercel.json"), "utf8"));
  // Files win over rewrites on Vercel. `_app/` is excluded so a missing chunk
  // is a 404, never the app's HTML served as a script.
  config.rewrites = [{ source: "/app/((?!_app/).*)", destination: "/app/index.html" }];
  config.headers = [
    ...(config.headers ?? []).filter((rule: { source: string }) => rule.source !== "/img/(.*)"),
    { source: "/app/_app/immutable/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
    { source: "/assets-(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=2592000" }] },
  ];
  return JSON.stringify(config, null, 2) + "\n";
}

function main(): void {
  const outArg = process.argv[2];
  if (!outArg) throw new Error("usage: bun scripts/build-site.ts <out-dir>");
  const outDir = resolve(outArg);
  if (outDir === repoDir || repoDir.startsWith(outDir)) throw new Error(`refusing to write the site over ${outDir}`);
  const appDir = join(repoDir, "build-demo");
  if (!existsSync(join(appDir, "index.html"))) throw new Error("build-demo/ is missing; run `bun run build:demo` first");

  const site = join(outDir, "website");
  rmSync(site, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });

  for (const file of tracked(pagesDir)) {
    const rel = file.slice(pagesDir.length + 1);
    if (NOT_PUBLISHED.test(rel)) continue;
    copy(join(repoDir, file), join(site, rel === FRONT_PAGE ? "index.html" : rel));
  }
  for (const file of UNTRACKED_MEDIA) {
    if (existsSync(join(repoDir, file))) copy(join(repoDir, file), join(site, file.slice(pagesDir.length + 1)));
    else console.warn(`not shipped (file absent): ${file}`);
  }
  // Fixtures name these as `../peel-mock/assets/…`, which is `/peel-mock/assets/…` from the front page.
  for (const file of tracked(sharedAssets)) {
    copy(join(repoDir, file), join(site, "peel-mock/assets", file.slice(sharedAssets.length + 1)));
  }
  cpSync(appDir, join(site, "app"), { recursive: true });
  for (const file of RELAY_FILES) copy(join(repoDir, "website", file), join(site, file));
  copy(join(repoDir, "website/favicon.png"), join(site, "favicon.png"));
  writeFileSync(join(site, "vercel.json"), vercelConfig());

  const link = join(repoDir, "website/.vercel/project.json");
  if (existsSync(link)) copy(link, join(outDir, ".vercel/project.json"));
  else console.warn("no website/.vercel/project.json: a deploy from here would create a new Vercel project");
  console.log(`Site written to ${site}`);
}

main();
