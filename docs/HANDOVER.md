# Handover — as of 2026-07-05

Snapshot for a fresh session. Read `CLAUDE.md` first (build commands, workflow rules,
subagent/worktree rules); this file is the *current situational state* on top of it.

## Where things stand

- **Released: v1.0.1** — the last two releases were `v1.0.0` (first stable) and
  `v1.0.1` (macOS boot-crash fix). Both live on GitHub Releases with all 6 artifacts
  (AppImage, deb, rpm, msi, NSIS setup, aarch64 dmg).
- **`dev` is clean and pushed** (`origin/dev` == `dev`). `dev` is **~200 commits ahead of
  `main`** — expected between releases; `main` only advances on a release PR.
- **Latest CI on dev is fully green** across all workflows (CI, WebKit, macOS Smoke,
  Tauri binary E2E on ubuntu+windows) as of commit `aaa0a69`.
- Working tree clean. No release in progress.

## Hard-won workflow facts (things that will bite you)

- **`dev` and `main` are protected** — you cannot `git add`/commit directly on them. Always
  branch first (`feat/`, `fix/`, `docs/`, `chore/`), commit there, then `git merge <branch>
  --no-ff` back. A hook enforces this.
- **Merge hooks require, on the *source* branch before merging:** (1) a matching **open**
  GitHub issue whose title contains the branch's dashed name, (2) committed screenshots in
  `screenshots/<branch>/` matching the `## Screenshots` checkboxes in the issue body (or
  "None required" for pure backend/refactor/docs), (3) a `docs/` change for features.
  Merges must be `git merge <branch> --no-ff` with **branch name first** (a hook rejects
  `--no-ff` before the branch).
- **`git merge --abort` is blocked** by a hook — use `git reset --merge` (or restore
  specific files) if a merge conflicts.
- **`git stash pop` with no arg is dangerous here** — the stash list has ~10 old entries;
  a bare `pop` applied an unrelated `stash@{0}` (a nav feature) and conflicted this session.
  If you must stash, use explicit refs and check `git stash list` first. Untracked files
  aren't stashed by default.
- **Version bump for a release** = edit 4 files (`package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock` via `cargo check`, `src-tauri/tauri.conf.json`) on a
  `chore/release-vX.Y.Z` branch, update `CHANGELOG.md`, merge to dev, PR dev→main, merge PR
  (auto-merge is **disabled** on this repo — merge manually once checks are green),
  `release.yml` builds artifacts on push to main. Guard prevents double-tagging.
- **agent-browser gotchas** (see memory `agent-browser-headless-shell.md`): `type` needs a
  selector (`fill "input[...]" "text"` for palette inputs); the daemon resolves relative
  screenshot paths against a *stale* cwd (screenshots often land in
  `~/Repos/tableau-frog/screenshots/...` — check and `mv` after every screenshot); pipe
  output through `grep -viE banner`.
- **Dev server (`bun run dev`, port 1420) dies/goes stale** — before Playwright/screenshots,
  verify it serves *current* code: `curl -s localhost:1420/src/routes/+page.svelte | grep
  <NewComponent>`; if stale, `fuser -k 1420/tcp` and restart.
- **Perf tests flake under CPU load** — this machine runs unrelated heavy jobs (load avg
  20–60); `performance.spec.ts` budget failures usually pass on isolated rerun. The CI perf
  gate now also requires a 0.5ms absolute delta (#189) so sub-ms benches don't flap.
- **Platform smoke suites catch real cross-platform bugs Linux-only checks miss** (a
  `#[cfg]` misplacement broke macOS/Windows builds in #204). Don't dismiss macOS/Windows CI
  failures as flakes without reading the log. The terminal smoke was a genuine race (#201),
  not a flake — PTY output raced listener registration.

## The one thing blocked on the user

- **Vercel deploy of the showcase site.** `website/` is a complete, self-contained static
  site — it *is* an interactive replica of the app (Ctrl+P quick-open, command palette,
  Ctrl+/ cheatsheet, 5 selectable themes, all working; marketing copy is a browsable fake
  filesystem). Ready to deploy, but **there are no Vercel credentials on this machine** (the
  personal-website repo deploys via the Vercel↔GitHub integration, no local token, and
  `~/.vercel/auth.json` is empty). The user must run `bunx vercel login` themselves, then
  deploy from `website/` (`vercel deploy --prod`). The README links to
  `https://tauri-explorer.vercel.app` — **correct that URL** if Vercel assigns a different
  one.

## Open work / backlog

- **Security + architecture audit just landed (nothing from it fixed yet):**
  `docs/reviews/security-architecture-audit-2026-07-05.md` — two fresh adversarial sweeps,
  prioritized into 4 tiers with `file:line` and a fix per finding:
  - **Tier 1 (do first, all cheap real bugs):** image-decode DoS (`image::Limits` at 4 sites
    in `thumbnails.rs`/`palette.rs`), `selectedPaths` reassigned to plain `Set`
    (`pane-mutations.ts:70,138` → use `setSelection()`), crash-report `0o600`, pin
    `update_check` `html_url` to github.com, editor `--` separator, CSP `object-src 'none'`.
  - **Tier 2 (launch-honesty):** Nano Banana `--yolo` argument model; the plugin system
    "capability boundary" is theater — either enforce it or reframe the docs (the
    `theme-from-image` plugin is one offender that imports `invoke` directly).
  - **Tier 3 (biggest 6-month risk, post-launch epic):** the Rust↔TS contract is 100%
    hand-maintained across 110 commands with 3 casing conventions and existing drift —
    adopt `tauri-specta`/`ts-rs` codegen + add real-binary git e2e coverage (git has zero
    `e2e-tauri` specs today; the mock has no parity test).
  - **Tier 4:** god-object splits (`window-tabs.svelte.ts` 1036 LOC, `files.ts` 1438 LOC),
    3 unreconciled fuzzy scorers, duplicated `open_repo()`/`to_app_err()` in git modules,
    per-pane view mode also rewriting the global default.
- **Only 1 open GitHub issue: #164** (theme via palette "requires two attempts" on Windows)
  — blocked on a Windows repro; the new `e2e-tauri/specs/theme-switch.spec.ts` is the guard
  and it *passed* on the Windows runner, so #164 didn't reproduce in CI. May already be
  fixed incidentally, or needs specific local conditions.
- **Standing constraints:** the VSCode Git Graph rendering model was used as *behavioral
  reference only* — never port its code verbatim (license). macOS build is aarch64-only
  (no Intel). Binaries are unsigned (Gatekeeper/SmartScreen warn) — code
  signing/notarization/auto-updater all need paid certs + signing keys (documented in
  CHANGELOG "Known limitations").
- **Post-launch menu (no production data needed):** manual Mac hardware pass + Cmd audit,
  code signing, visual-regression screenshot suite, a11y audit (svelte-check has warnings),
  cargo-fuzz on archive/search/path commands, filesystem soak (huge dirs, symlink loops,
  permission-denied, FIFOs), cold-start profiling, AUR publication, shipping portal files
  in deb/rpm.

## Recent feature arc (all merged to dev, for context)

Per-pane tabs, git commit graph (VSCode behavioral parity), integrated terminal,
virtualized views, crash reporting, update checker, shortcut cheatsheet + first-run hint,
portal file-picker with Ctrl+P quick-open, WebKit e2e suite (caught a real marquee bug),
macOS launch smoke (caught the real macOS boot crash), extended Windows smoke
(clipboard/theme/hostile-filenames), "Report a Bug"/"Open Logs Folder" palette commands,
the showcase website with selectable themes, and the **Theme from Image plugin**
(right-click an image or "Create Theme from Wallpaper" → median-cut palette extraction →
generated theme written to the user themes dir and applied). Lessons captured in
`docs/lessons_learnt.md`.

## Quick verification

```
bun run check            # type check (expect 0 ERRORS)
bunx vitest run          # unit tests (~850, all green)
cd src-tauri && cargo test && cargo clippy -- -D warnings && cargo fmt --check
npx playwright test      # browser e2e (details view; ALL_VIEW_MODES=1 for all 3)
WEBKIT=1 npx playwright test --project=webkit   # WKWebView proxy (webkit must be installed)
```
