# #1367 — PR CI scoping and the slow Playwright install

Install-bound timeouts were not a browser-download problem. `npx playwright
install --with-deps` spent 19–40 minutes fetching ~117 MB of apt packages from
a mirror running at ~54 kB/s; the browser download itself took 5 s, so caching
`~/.cache/ms-playwright` would not have helped. The browser jobs now run in the
Playwright image pinned to bun.lock's version. Before switching, the
font-, marquee-pixel- and GStreamer-video-sensitive WebKit specs were run
locally in that image (42/42 passed), because the image's font set differs
from the hosted runner's.

Container jobs differ from runner jobs in ways that fail silently:
`${{ runner.temp }}` names the host path (an upload then finds nothing and
`if-no-files-found: ignore` hides it), `unzip` is absent (the test-cache
restore swallowed the error as a cache miss), `setup-bun` needs `unzip`, and
`ImageOS`/`ImageVersion` describe the host, not the image. Read paths from
the in-container environment and name the container in the cache identity.

Turborepo always hashes the root `package.json` as a global file; task
`inputs` exclusions cannot remove it. A version bump therefore invalidated
every cached target. The browser target rewrites the checkout's version to a
placeholder before hashing (its suite reads the mock backend's version only).

Most feature PRs edit `docs/code-map/map-feature.md`. Treating it as a
selection input ran everything; selecting with both the base and head maps and
taking the union keeps narrowing sound when a file moves between clusters.

Dry runs on #1362–#1366 all selected full WebKit, correctly: they touched
FileList/FileItem/peek (WKWebView-sensitive) or e2e fixtures. Keyword clusters
remain broad (a script-only change to a plugin registry maps to 174 of 266
specs); a coverage-based map is #1368.

A cancelled matrix job concludes `cancelled`, and its in-flight step is also
`cancelled`, when it hits its job `timeout-minutes`; a superseded PR run is
cancelled as a whole. The auto-rerun therefore acts only on a run concluded
`failure`, first attempt, whose failed non-gate jobs all stopped at setup.
`workflow_run` workflows execute the default branch's copy, so a change to the
re-run workflow cannot be exercised by the PR that introduces it.

The Playwright image resolves `monospace` to a different font than the hosted
runner. `text-preview-fullscreen.spec.ts` measured one glyph's range height,
which follows the font's rounded ascent/descent: at 115% zoom it went 16 to
17 px instead of 18.4 in the container. A layout assertion about zoom should
measure a CSS-derived length (here the line pitch over ten lines), not a glyph
box whose size depends on the resolved font.
