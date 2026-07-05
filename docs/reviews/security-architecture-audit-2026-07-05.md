# Security + Architecture Audit — 2026-07-05

Two independent fresh-context adversarial reviews run just before the v1.0 public
promotion: one offensive-security sweep, one principal-engineer architecture sweep.
Both were read-only reconnaissance (no code changed) and cite `file:line` for every
claim. This doc is the consolidated, prioritized result.

**Scale for context:** ~58k LOC (frontend + backend), 110 Tauri commands, 51 state
stores, 855 unit tests / 68 Playwright specs / 9 real-binary specs.

---

## Verdict

The app is **well-built** — strong defensive posture and mostly clean architecture.
**No command injection, path traversal, or XSS was found**, and several structural
hypotheses (view-mode triplication, panic surface) turned out false. The real work is
a handful of concentrated issues: an easy image-decode DoS, an over-trusting LLM
integration, a plugin "boundary" that doesn't exist, and a hand-maintained IPC contract
that is the biggest long-term risk. None are functional launch blockers; several are
about not over-claiming publicly.

---

## Preserve this (both reviewers praised, independently)

- No shell-string interpolation anywhere; libgit2 + ripgrep-as-library instead of
  shelling out. Process spawns use argv arrays throughout.
- `config.rs` path validation resisted a genuine attempt to break it (`../`, absolute,
  `\`, symlink-through, NUL/newline all rejected). Zip-slip guarded (`archive.rs`).
- All three `{@html}` sinks escape correctly (`PreviewPane`, `ContentSearchDialog`).
  No `innerHTML`/`eval`/`Function` anywhere.
- Strict CSP: `script-src 'self'`, `connect-src` locked to local IPC (blocks network
  exfil). No `shell:*` capability exposed to the webview.
- View-mode rendering is **not** triplicated — shared composables
  (`use-item-interactions`, `use-pointer-drag`, `use-inline-rename`, `use-drop-target`).
  **Do not let anyone "re-DRY" this.**
- Selection algorithm isolated in `state/selection.ts`; command palette dogfoods one
  shared `registerCommands()` path; store layer has **zero** `$effect` misuse.
- Rust concurrency discipline above average: no `MutexGuard` held across `.await`,
  consistent poison recovery, bounded caches, sound cooperative cancellation.
- `.unwrap()` panic surface is a red herring: 451 raw hits → **7** in production code,
  6 provably safe by local invariant.

---

## Prioritized findings

### Tier 1 — cheap fixes for real bugs; do before launch

> **Status: all Tier 1 findings fixed in #208 (fix/security-hardening-tier1).**

| ID | Sev | Finding | Location | Fix |
|----|-----|---------|----------|-----|
| S1 | HIGH | **Image-decode memory bomb (DoS).** No `image::Limits` at any of 4 decode sites; a crafted image (e.g. IHDR claiming 65500×65500) allocates a multi-GB buffer *before* the 64px resize. Trigger: browse a folder containing one malicious image → thumbnail/palette OOMs the app. | `thumbnails.rs:296,388,827`, `palette.rs:81-87` | Set `image::Limits` (max dims ~16384, max_alloc ~256MB) before `.decode()`; add `fs::metadata().len()` cap (~200MB) before read. |
| A1 | HIGH | **`selectedPaths` reassigned to a plain `Set`**, breaking the store's documented "always a `SvelteSet`, mutate in place" contract. Granular per-row reactivity dies until the next `setSelection()`; captured `$derived`/`$effect` stop tracking. Live latent bug. | `pane-mutations.ts:70,138` | Replace both with `setSelection([...])` (helper already exists). |
| S3 | LOW | Crash-report files written without `0o600` (unlike `config.rs`). Backtraces can carry absolute paths. Not auto-sent. | `crash_report.rs:60-62` | `set_permissions(0o600)` after write. |
| S4 | LOW | `update_check` returns GitHub's `html_url` unvalidated; opened via `open_external_url` (which enforces `https://` but not the host). Compromised upstream → phishing URL. No RCE. | `update_check.rs:20-79` | Require `html_url` to start with `https://github.com/`. |
| S5 | LOW | Editor arg injection via leading-`-` filenames (no shell → worst case editor misbehavior). | `external_apps.rs:162-189` | Insert `--` before path, as `git_actions.rs` already does. |
| S6 | LOW | CSP could add `object-src 'none'; base-uri 'self'` (currently only implied). | `tauri.conf.json` | Add explicit directives. |

### Tier 2 — honesty / robustness before public scrutiny

> **Status: S2, S7, A2 addressed in #209 (fix/tier2-hardening).** S2: source/output
> staged under neutral names + `--allowed-tools edit_image` replaces `--yolo` (verified
> against a live gemini run; nanobanana ≥1.0.10 also rejects `--output`, which the old
> invocation passed). S7: asset scope converted to allow/deny with credential-dir
> denies. A2: plugins.md reframed (feature modules, not a capability boundary).

- **S2 (HIGH) — Nano Banana feeds attacker-influenceable strings to `gemini --yolo`.**
  `nano_banana.rs:120-144`. No OS shell is invoked and `GEMINI_API_KEY` is handled
  correctly (env, not argv, not logged). But `--yolo` auto-approves every tool call the
  model makes, and a malicious *filename* becomes part of the gemini slash-command it
  re-parses. Even with quoting intact, it's a prompt-injection surface amplified by
  auto-approval. Fix: pass source/prompt/output as separate CLI flags if supported; drop
  `--yolo` or constrain gemini's tool-allowlist; add a tokenizer round-trip fuzz test.
  *(`ai_rename`/`ai_organize` already use the correct pattern — separate argv, no `--yolo`,
  output allowlist-validated.)*

- **A2 (HIGH) — The plugin system is theater.** `plugins.md:54` claims plugins "never
  call `invoke` directly — everything routes through the context." False for every
  shipped plugin: `theme-from-image/index.ts:15,22,29` imports `invoke` directly; all 5
  plugins import `$lib/state/*` and `$lib/api/*`; `ai-organize` calls the core
  `performFileTransfer` mutation with no `ctx`. **No enforcement** exists, and the backend
  has **no plugin concept** — plugin commands are ordinary compiled-in commands, globally
  invokable regardless of enable state. `PluginContext` covers 5 contribution points with
  genuinely good disposal bookkeeping, but none of the real capability surface. A
  third-party plugin today would have unrestricted access; there is no isolation layer to
  "turn on." **Do not describe this as a capability boundary at v1.0.** Cheapest honest
  fix: reframe docs — these are *feature modules with a UI toggle*. If third-party plugins
  are actually on the roadmap: make `PluginContext` the only allowed import (ESLint
  `no-restricted-imports` on `plugins/**`), add `ctx.fs`/`ctx.nav`/`ctx.modal`, and gate
  commands per-plugin-id in Rust.

- **S7 (MEDIUM) — asset-protocol scope is very broad** (whole-drive on Windows:
  `*:/**/*`, `//**/*`; `$HOME/**/*` + mounts elsewhere). By-design for a file manager, but
  any *future* XSS becomes arbitrary local-file read via `<img src="asset://...">`
  (`connect-src` still blocks exfil, so a local channel would be needed). Fix: dynamically
  scope to open directories, or document as accepted risk with sensitive-dir negations.

### Tier 3 — highest-leverage structural investment; biggest 6-month risk

- **A3 (HIGH) — The Rust↔TS contract is 100% hand-maintained.** No codegen. 110 commands,
  10+ mirrored struct pairs, **three coexisting casing conventions** (`FileEntry`/git
  types leak snake_case into `domain/file.ts`; `SearchResult` uses per-field
  `#[serde(rename)]`; nothing uses blanket `rename_all`). Drift already present:
  `is_symlink` is required-on-wire in Rust but `optional` in TS. Compounding it, 68
  Playwright specs run **only** against `mock-invoke.ts` (1599 lines) with **no mock/real
  parity test**, the mock throws plain `Error` while the backend serializes `{kind,
  message}` (so `extractErrorKind` — currently dead — would always return null), 5 real
  commands are unmocked, and **git (the riskiest subsystem, `git.rs` 977 LOC) has zero
  real-binary specs**. This is where a "works in tests, broken in the real binary"
  incident will originate. Fix: adopt `tauri-specta`/`ts-rs` to generate TS types from
  Rust (kills the drift class permanently, forces one casing); add `e2e-tauri` git specs
  and a mock/real parity smoke test.

### Tier 4 — steady maintainability debt (non-urgent, compounding)

- **A4 (MED)** `window-tabs.svelte.ts` (1036 lines) bundles ≥6 responsibilities; extract
  tab-display/git-root formatting and the closed-tab stack.
- **A5 (MED)** `files.ts` (1438 lines) mixes 11 concerns; split into
  `api/{search,thumbnails,archive,git,config}.ts`; give the 7 raw-`invoke` escapees typed
  wrappers.
- **A6 (MED)** Three unreconciled fuzzy scorers (`domain/fuzzy-score.ts` +
  `QuickOpen.svelte:86-202` + `CommandPalette.svelte:74-117`); lift ranking into `domain/`.
- **A7 (MED)** Per-pane `setViewMode()` also writes the global default
  (`explorer.svelte.ts:447`) — decide per-pane *or* global, not both.
- **A8 (MED)** `open_repo()` and `to_app_err()` byte-identical in `git.rs` and
  `git_log.rs`; extract `git_common.rs`.
- **A9 (MED)** Refresh policy spread across 3 gating mechanisms (`pane-watch` cooldown,
  `pane-refresh` fingerprint, `refresh-manager` debounce); consolidate ownership.
- **A10 (MED)** `ExplorerPane.svelte:98-125` pushes derived state cross-store via chained
  `$effect` (the repo's own anti-pattern) — expose a pure combinator instead.
- **Low:** domain-purity leaks both directions (`zoom.ts:72` DOM read; ref-grouping math
  in `GitGraphView`; `NavigationBar:159` reimplements `isDriveRoot` with a buggier regex);
  `fs_watcher.rs:87 .expect()` can panic startup under inotify exhaustion;
  `search.rs:264,498` non-async commands violate the async rule; 12 Rust files have zero
  tests; doc drift (`cross-cutting.md`, `frontend.md` undercounts).

---

## Recommended order

1. **Tier 1** now — all small, all real, S1 is a one-image DoS.
2. **Tier 2** before/at launch — S2 and A2 are both HIGH and both about not over-claiming;
   the plugin-docs reframe is nearly free.
3. **Tier 3 (A3)** as the first post-launch epic — the right investment, but a real project,
   not a launch blocker.
4. **Tier 4** as background debt.
