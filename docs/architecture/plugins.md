# Plugin System (#142)

The plugin system is a **frontend modularity + capability-routing layer**. It
lets self-contained features (a virtual filesystem, an AI action, an extra
settings panel) register their contributions through one typed surface and be
toggled on/off at runtime, without editing the core UI.

Backend commands stay compiled-in Rust (as `nano_banana.rs` is today) — plugins
route capabilities on the frontend; sidecar processes remain the pattern for
external tools.

## Loading model — decided by CSP

`tauri.conf.json` sets `script-src 'self'`. That rules out runtime-loaded plugin
JS: no `eval`, no `blob:`/remote `<script>`, no dynamic third-party import.

Therefore plugins are **build-time-bundled modules** under
`src/lib/plugins/<id>/`, statically imported into the registry
(`plugins/registry.svelte.ts` → `BUILT_IN_PLUGINS`). What is dynamic is **enable
state**, persisted in settings (`pluginsEnabled: Record<string, boolean>`);
absent ids fall back to each plugin's `enabledByDefault` (default `true`).

Third-party *runtime* loading would need a CSP redesign (a signed-plugin origin,
a worker sandbox, or a native host) and is explicitly **out of scope**.

## Lifecycle

```
+page.svelte onMount
  → settingsStore.init()          (loads persisted pluginsEnabled)
    → pluginRegistry.initPlugins() (activates every enabled built-in)

Settings → Plugins toggle
  → pluginRegistry.setEnabled(id, enabled)
    → persists pluginsEnabled
    → activate(plugin)  OR  deactivate(id) + dispose all contributions
```

`createPluginContext(pluginId)` (in `plugins/api.ts`) returns `{ ctx, dispose }`.
Every registration made through `ctx` pushes a disposer; `dispose()` runs them
all in reverse order. Toggling a plugin off therefore cleanly unregisters
everything it added — commands, context-menu items, settings sections, fs
providers, and event listeners.

> **Gotcha:** Svelte 5 `$state` arrays deep-proxy their elements. A disposer that
> removes "the element I pushed" must match by a stable **id field**, not object
> reference (`items.filter(i => i.id !== item.id)`) — the stored element is a
> proxy that never `===` the raw object you captured. See
> `context-menu-items.svelte.ts` / `settings-registry.svelte.ts`.

## PluginContext surface

A plugin declares `activate(ctx)` and optional `deactivate()`. Plugins **never
call `invoke` directly** — everything routes through the context so it is
tracked and torn down.

| Capability | Method | Backed by |
|-----------|--------|-----------|
| Command palette / shortcut | `ctx.registerCommand(cmd)` | `state/commands.svelte.ts` (category `"plugins"`) |
| Context-menu item | `ctx.registerContextMenuItem({ id, label, icon?, when(entries), handler })` | `state/context-menu-items.svelte.ts` → `ContextMenu.svelte` |
| Settings section | `ctx.registerSettingsSection({ id, title, rows })` | `plugins/settings-registry.svelte.ts` → `SettingsDialog.svelte` |
| Virtual filesystem | `ctx.registerFsProvider(scheme, { list(path) })` | `plugins/fs-providers.ts` → `api/files.ts` |
| Background jobs | `ctx.jobs.add/complete/fail` | `state/jobs.svelte.ts` (job tagged `source: pluginId`) |
| Toasts | `ctx.toast.show / error` | `state/toast.svelte.ts` |
| Events | `ctx.events.listen(name, handler)` | Tauri event bus (auto-disposed) |
| Persistent config | `ctx.storage.get() / set(value)` | `plugin.<id>.json` via the config commands |

`SettingRowDescriptor` rows are `text | password | toggle | select`, rendered
descriptor-driven and bound to the plugin's `storage` blob.

### Storage

`ctx.storage` reads/writes `plugin.<id>.json` in the app config dir through the
existing `read_config_file` / `write_config_file` commands (via
`writeConfigQueued`). `validate_filename` forbids path separators, so plugin
config uses the **prefixed flat name** `plugin.<id>.json` — never a subdirectory.

## Virtual filesystem (the `scheme://` seam)

A provider serves a URL scheme (`demo://`, and later `keep://`). Dispatch:

- `domain/virtual-path.ts` — pure helpers: `isVirtualPath`, `parseVirtualPath`,
  `virtualScheme`, `virtualBreadcrumbs`. A scheme is ≥2 chars so it never
  collides with a Windows drive letter (`C://…` is not virtual).
- `api/files.ts` `fetchDirectory` / `startStreamingDirectory` route to
  `providerFor(path).list(path)` before touching the real-fs backend. Providers
  return a full `DirectoryListing` inline (`listing_id: null`) — no streaming.
- Real-path-only operations are skipped for virtual paths: `toNativeSeparators`
  (returns the scheme path untouched), the pane watcher (`pane-watch.ts`), the
  git-status trigger (`ExplorerPane.svelte`), and breadcrumb parsing
  (`state/navigation.ts`) gets a virtual carve-out mirroring the UNC case.

`FileEntry` paths under a provider keep the scheme prefix, so navigating into
`demo://subfolder` dispatches back to the same provider.

## Adding a built-in plugin

1. Create `src/lib/plugins/<id>/index.ts` exporting a `Plugin`
   (`id`, `name`, `description`, optional `enabledByDefault`, `activate`).
2. In `activate(ctx)`, register only what you need — each call is auto-disposed.
3. Add the plugin to `BUILT_IN_PLUGINS` in `plugins/registry.svelte.ts`.
4. It now appears in **Settings → Plugins** with an enable toggle.

See `plugins/demo/index.ts` for a reference that exercises every seam (command,
nav command, context-menu item, settings section, and a `demo://` fs provider).
It ships `enabledByDefault: false` and is what `e2e/plugin-system.spec.ts`
drives.
