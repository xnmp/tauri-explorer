# 1270: command palette misses commands registered after it opens

**Symptom.** A palette opened while plugins were still activating showed "No
matching commands" for plugin commands (for example "Demo: Toggle Cards View",
registered ~0.5s after the file list appears) until it was reopened. This made
`plugin-preview-target-fullscreen.spec.ts` flaky.

**Root cause.** Commands lived in `createOwnedRegistry()`, a plain `Map`.
`CommandPalette`'s `$derived` read `getAvailableCommands()` once and nothing
told it the Map had changed.

**Fix.** `state/reactive-registry.svelte.ts` wraps the framework-free owned
registry with a `$state` revision that every register, dispose, delete and
clear writes; `values()` reads it. `commands.svelte.ts` uses it.

**Gotchas.**
- Bump with `revision = ++version`, never `revision++`. The latter reads the
  state, so an effect that registers commands (the Git graph's palette
  targets) subscribed to its own write and looped forever, freezing the page.
- `get(id)` stays untracked: it is a dispatch-time lookup.
- Other owned-registry users (fs providers, dialogs, ordered registry) are
  unchanged; they are not read by a long-lived open surface.

**Guards.** `tests/state/reactive-registry.test.ts` (client-compiled via the
folder-peek harness, since Vitest's SSR transform leaves `$state` inert) covers
late register/dispose, replace/delete/clear, untracked `get`, and the
self-retrigger loop. `e2e/command-palette-late-registration.spec.ts` enables
and disables the demo plugin while the palette is open.
