# #585 — Duplicate theme id crashes ThemePicker; mount crashes soft-lock hotkeys

**Symptom:** Installed app: "Switch Theme..." showed nothing and killed all shortcuts — *after* #584 guarded the dynamic-import path. Crash logs showed `each_key_duplicate` at every attempt.

**Root cause:** A user theme in `~/.config/tauri-explorer/themes/` reused a built-in id (`nord`). `discoverThemes()` collects every `[data-theme]` rule with `--theme-name` and did not dedupe, so ThemePicker's `{#each ... (theme.id)}` got two entries with one key and threw **during mount**. The open-flag was already set, nothing rendered, `hasModalOpen` gated all hotkeys — same soft-lock as #584 via a path the import guard cannot see.

**Fix:** (1) `domain/theme-list.ts` `dedupeThemesById` — last occurrence wins, matching the CSS cascade (user styles are injected after built-ins, so the surviving entry is what actually paints; collisions become overrides). (2) Every lazy dialog in `+page.svelte` is wrapped in `<svelte:boundary onerror={...}>` using `createDialogCrashHandler` — mount/render crashes roll back the open state and toast.

**Gotchas worth remembering:**
- "Set flag → reveal component" has TWO failure points: the chunk import (#584) and the component's own mount. Guarding only the import still soft-locks on a mount throw. `<svelte:boundary>` is the seam for the second.
- Svelte's `each_key_duplicate` is a **prod runtime error**, not a dev-only warning: any keyed each over externally-sourced data (user config, discovered CSS) needs dedupe/validation upstream.
- Installed-app frontend crashes are captured in `~/.local/share/io.github.xnmp.tauri-explorer/logs/` (`crashes/*.txt` with JS backtraces) — read these before theorizing; the first diagnosis here (chunk-load failure) was wrong and the log had the true error the whole time.
- E2E: a `<style>` appended via `addInitScript` at document_start gets discarded before the app boots; append to `document.head` inside a `DOMContentLoaded` listener — that survives and still precedes `initTheme()` discovery in onMount.
