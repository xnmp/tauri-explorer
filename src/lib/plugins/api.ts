/**
 * Plugin API surface.
 *
 * Loading model — decided by CSP. `script-src 'self'` (tauri.conf.json) rules
 * out runtime-loaded plugin JS. Plugins are therefore build-time-bundled
 * modules statically imported into the registry, with runtime enable/disable.
 * See the Plugins cluster in docs/code-map/map-feature.md.
 *
 * A plugin declares `activate(ctx)` and (optionally) `deactivate()`. Every
 * contribution made through the context is tracked and disposed automatically
 * when the plugin deactivates, so toggling a plugin off cleanly unregisters
 * everything it added — commands, context-menu items, settings sections, fs
 * providers and event listeners.
 */

import type { Command } from "$lib/state/commands.svelte";
import { registerCommandContribution } from "$lib/state/commands.svelte";
import { contextMenuItems, type ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import { registerFsProvider, type FsProvider } from "./fs-providers";
import { pluginSettingsSections } from "./settings-registry.svelte";
import { dialogRegistry, type DialogDescriptor } from "./dialog-registry.svelte";
import { toastStore, type ToastType } from "$lib/state/toast.svelte";
import { readConfigFile } from "$lib/api/config";
import { writeConfigQueued } from "$lib/state/persisted";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { performFileTransfer } from "$lib/state/file-transfer";
import type { FileEntry } from "$lib/domain/file";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pluginJobsController, type PluginJobKind } from "$lib/state/plugin-jobs";
import type { ApiResult } from "$lib/api/common";

// ----- Settings descriptors -----

export type SettingRowType = "text" | "password" | "toggle" | "select";

export interface SettingRowDescriptor {
  id: string;
  label: string;
  description?: string;
  type: SettingRowType;
  /** Options for `type: "select"`. */
  options?: { value: string; label: string }[];
  /** Default value shown until (and unless) the user changes it. */
  default?: string | boolean;
}

export interface SettingsSectionDescriptor {
  id: string;
  title: string;
  rows: SettingRowDescriptor[];
}

// ----- Storage -----

/** Plugin-scoped JSON storage, persisted as `plugin.<id>.json`. */
export interface PluginStorage {
  get(): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

/** Window-owned background jobs survive plugin activation changes. */
export interface PluginJobs {
  accept(
    registration: { kind: PluginJobKind; label: string; detail: string },
    start: () => Promise<ApiResult<number>>,
  ): Promise<ApiResult<number>>;
}

export interface PluginToast {
  show(message: string, variant?: ToastType): void;
  error(message: string): void;
}

export interface PluginEvents {
  /** Listen for a backend/window event; auto-disposed on deactivate. */
  listen<T = unknown>(name: string, handler: (payload: T) => void): void;
}

/** Outcome of a workspace file operation (structural subset of the shared
 *  transfer result). `error === "skipped"` means a no-op or user cancel. */
export interface PluginMoveResult {
  ok: boolean;
  error?: string;
}

/**
 * Read/act on the active file-explorer pane. This is the seam plugins use to
 * reach the workspace — they never import the window/tab or explorer stores
 * directly, so this surface stays the single, honest list of what a plugin can
 * do to the file view.
 */
export interface PluginWorkspace {
  /** Entries selected in the active pane. Empty when nothing is selected or
   *  there is no active explorer pane. */
  getSelection(): FileEntry[];
  /** Entries currently listed in the active pane (after sort/filter). Used to
   *  gather in-context candidates such as sibling folders. */
  getVisibleEntries(): FileEntry[];
  /** Navigate the active pane to a path — e.g. open a plugin's virtual folder. */
  navigate(path: string): Promise<void>;
  /** Refresh every open pane so listings reflect filesystem changes the plugin
   *  caused (a written output file, a moved entry). Silent — no loading flash. */
  refreshPanes(): Promise<void>;
  /** Move a file into a destination directory through the shared transfer flow
   *  (conflict prompt, undo, toast, cross-window broadcast, pane refresh). */
  moveFile(sourcePath: string, targetDir: string): Promise<PluginMoveResult>;
}

/**
 * The capability surface handed to a plugin's `activate`. Plugins never call
 * `invoke` or reach into app stores directly — the common side effects route
 * through this object so they can be tracked, torn down, and audited in one
 * place: contribution registration, toasts, events, plugin storage, the
 * workspace (selection / navigation / pane refresh / moves), and opening
 * Settings.
 *
 * The one documented exception is a plugin purpose-built to extend a specific
 * core subsystem (e.g. the theme engine): it may import that subsystem's store
 * directly rather than grow this shared context with a single-consumer method.
 * Such cases carry a justification comment at the import site.
 */
export interface PluginContext {
  registerCommand(cmd: Command): void;
  registerContextMenuItem(item: ContextMenuItem): void;
  registerSettingsSection(section: SettingsSectionDescriptor): void;
  registerFsProvider(scheme: string, provider: FsProvider): void;
  /** Contribute a modal dialog component, addressable by its stable id. */
  registerDialog(descriptor: DialogDescriptor): void;
  /** Open a registered dialog, passing props to its component. `open` and an
   *  `onClose` (which closes the dialog) are injected by the renderer. */
  openDialog(id: string, props?: Record<string, unknown>): void;
  /** Close an open dialog by id. */
  closeDialog(id: string): void;
  jobs: PluginJobs;
  toast: PluginToast;
  events: PluginEvents;
  storage: PluginStorage;
  /** Read/act on the active file-explorer pane. */
  workspace: PluginWorkspace;
  /** Open the app Settings dialog (e.g. from a "configure API key" prompt). */
  openSettings(): void;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  /** When false, the plugin ships disabled and must be turned on in Settings. */
  enabledByDefault?: boolean;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void;
}

/** Plugin-scoped storage backed by `plugin.<id>.json` via the config commands. */
export function createPluginStorage(pluginId: string): PluginStorage {
  const filename = `plugin.${pluginId}.json`;
  return {
    async get(): Promise<Record<string, unknown>> {
      const result = await readConfigFile(filename);
      if (result.ok && result.data) {
        try {
          const parsed = JSON.parse(result.data);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          // Corrupt file — treat as empty.
        }
      }
      return {};
    },
    async set(value: Record<string, unknown>): Promise<void> {
      await writeConfigQueued(filename, JSON.stringify(value, null, 2));
    },
  };
}

/**
 * Build a plugin context plus a `dispose` that runs every tracked teardown.
 * Disposers run in reverse registration order.
 */
export function createPluginContext(pluginId: string): {
  ctx: PluginContext;
  dispose: () => void;
} {
  const disposers: (() => void)[] = [];
  let disposed = false;
  const track = (fn: () => void) => {
    if (disposed) fn();
    else disposers.push(fn);
  };
  const storage = createPluginStorage(pluginId);


  const ctx: PluginContext = {
    registerCommand(cmd: Command): void {
      track(registerCommandContribution(cmd));
    },
    registerContextMenuItem(item: ContextMenuItem): void {
      track(contextMenuItems.register(item));
    },
    registerSettingsSection(section: SettingsSectionDescriptor): void {
      track(pluginSettingsSections.register(pluginId, section, storage));
    },
    registerFsProvider(scheme: string, provider: FsProvider): void {
      track(registerFsProvider(scheme, provider, false));
    },
    registerDialog(descriptor: DialogDescriptor): void {
      track(dialogRegistry.register(descriptor));
    },
    openDialog(id: string, props?: Record<string, unknown>): void {
      dialogRegistry.open(id, props ?? {});
    },
    closeDialog(id: string): void {
      dialogRegistry.close(id);
    },
    jobs: pluginJobsController,
    toast: {
      show: (message, variant) => toastStore.show(message, variant),
      error: (message) => toastStore.error(message),
    },
    events: {
      listen<T>(name: string, handler: (payload: T) => void): void {
        let un: UnlistenFn | null = null;
        let listenerDisposed = false;
        listen<T>(name, (event) => {
          if (!listenerDisposed && !disposed) handler(event.payload);
        })
          .then((fn) => {
            if (listenerDisposed || disposed) fn();
            else un = fn;
          })
          .catch(() => {
            // Outside Tauri (browser/mock) the event system is unavailable.
          });
        track(() => {
          listenerDisposed = true;
          un?.();
        });
      },
    },
    storage,
    workspace: {
      getSelection: () => windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? [],
      getVisibleEntries: () => windowTabsManager.getActiveExplorer()?.displayEntries ?? [],
      navigate: async (path) => {
        await windowTabsManager.getActiveExplorer()?.navigateTo(path);
      },
      // Refresh every explorer instance (across tabs), silently — a plugin's
      // background job may have written a file into any pane's directory.
      refreshPanes: async () => {
        await Promise.all(
          windowTabsManager.getAllExplorers().map((exp) => exp.refresh({ silent: true })),
        );
      },
      moveFile: (sourcePath, targetDir) =>
        performFileTransfer(sourcePath, targetDir, false, {
          onRefresh: () => {
            for (const exp of windowTabsManager.getAllExplorers()) void exp.refresh({ silent: true });
          },
        }),
    },
    openSettings: () => dialogStore.openSettings(),
  };

  return {
    ctx,
    dispose: () => {
      disposed = true;
      while (disposers.length) {
        const fn = disposers.pop();
        try {
          fn?.();
        } catch (err) {
          console.error(`[plugins] disposer for "${pluginId}" threw:`, err);
        }
      }
    },
  };
}
