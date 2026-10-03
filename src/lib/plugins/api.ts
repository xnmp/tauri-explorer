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
import { inspectorRegistry, type InspectorContribution } from "./inspector-registry.svelte";
import { toastStore, type ToastType } from "$lib/state/toast.svelte";
import { readConfigFile } from "$lib/api/config";
import { writeConfigQueued } from "$lib/state/persisted";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { FileEntry } from "$lib/domain/file";
import { parentDir, sameDirectory } from "$lib/domain/path";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pluginJobsController, type PluginJobKind } from "$lib/state/plugin-jobs";
import { extractError, type ApiResult } from "$lib/api/common";
import { logFrontendError } from "$lib/api/crash";
import { subscribeToLocalFileChanges } from "$lib/state/file-events";

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
  /** Listen for a backend/window event; auto-disposed on deactivate. A
   *  handler that throws or rejects is reported under the plugin's name. */
  listen<T = unknown>(name: string, handler: (payload: T) => void | Promise<void>): void;
}

/** Outcome of a workspace file operation (structural subset of the shared
 *  ordered move session's result). `error === "skipped"` means a no-op,
 *  conflict skip, or user cancel — the session already toasted and recorded
 *  undo for everything else. */
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
  /** Observe completed workspace mutations, including cross-window broadcasts.
   * Auto-disposed when the plugin deactivates. External filesystem changes
   * continue to arrive through the directory watcher/selection updates. */
  onFilesChanged(handler: (directories: readonly string[]) => void | Promise<void>): void;
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
  /** Return the handler's work as a promise: a rejection is reported to the
   *  user under the plugin's name and written to the app log. Work started
   *  with `void` and never returned is invisible to that reporting. */
  registerCommand(cmd: Command): void;
  registerContextMenuItem(item: ContextMenuItem): void;
  registerSettingsSection(section: SettingsSectionDescriptor): void;
  registerFsProvider(scheme: string, provider: FsProvider): void;
  /** Contribute a modal dialog component, addressable by its stable id. */
  registerDialog(descriptor: DialogDescriptor): void;
  /** Contribute a selection-aware inspector panel; removed on deactivation. */
  registerInspector(descriptor: InspectorContribution): void;
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
 *
 * A plugin's command, menu action, event handler or activation that fails is
 * reported to the user under `pluginName` and written to the app log (#782,
 * #890); `reportFailure` is that report for the registry's activation path.
 * Commands still reject, so `executeCommand` reports the failure to its
 * caller; menu actions and event handlers resolve, because their callers fire
 * them without awaiting and a reported failure is not an unhandled rejection.
 * File-system provider failures are only logged: they still reject to the
 * listing caller, which already shows the error to the user.
 *
 * `order` is the plugin's position in the plugin list. Menu items and settings
 * sections are placed by it, so their order does not depend on which
 * activation happened to register first.
 */
export function createPluginContext(
  pluginId: string,
  pluginName = pluginId,
  order = Number.MAX_SAFE_INTEGER,
): {
  ctx: PluginContext;
  dispose: () => void;
  reportFailure: (error: unknown, contribution: string) => void;
} {
  const disposers: (() => void)[] = [];
  let disposed = false;
  const track = (fn: () => void) => {
    if (disposed) fn();
    else disposers.push(fn);
  };
  const storage = createPluginStorage(pluginId);
  // Tauri rejects with a serialized AppError ({ kind, message }), not an Error.
  const log = (error: unknown, contribution: string): string => {
    const message = extractError(error);
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
    console.error(`[plugins] "${pluginId}" ${contribution} failed:`, error);
    void logFrontendError(`[plugins] "${pluginId}" ${contribution} failed: ${message}${stack}`)
      .catch(() => {});
    return message;
  };
  const report = (error: unknown, contribution: string) => {
    toastStore.error(`${pluginName}: ${log(error, contribution)}`);
  };

  const ctx: PluginContext = {
    registerCommand(cmd: Command): void {
      const handler = async () => {
        try {
          await cmd.handler();
        } catch (error) {
          report(error, `command ${cmd.id}`);
          throw error;
        }
      };
      track(registerCommandContribution({ ...cmd, handler }));
    },
    registerContextMenuItem(item: ContextMenuItem): void {
      const handler = async (entries: FileEntry[]) => {
        try {
          await item.handler(entries);
        } catch (error) {
          report(error, `menu action ${item.id}`);
        }
      };
      track(contextMenuItems.register({ ...item, handler }, order));
    },
    registerSettingsSection(section: SettingsSectionDescriptor): void {
      track(pluginSettingsSections.register(pluginId, section, storage, order));
    },
    registerFsProvider(scheme: string, provider: FsProvider): void {
      const list = async (path: string) => {
        try {
          return await provider.list(path);
        } catch (error) {
          log(error, `fs provider ${scheme}`);
          throw error;
        }
      };
      track(registerFsProvider(scheme, { list }, false));
    },
    registerDialog(descriptor: DialogDescriptor): void {
      track(dialogRegistry.register(descriptor));
    },
    registerInspector(descriptor: InspectorContribution): void {
      track(inspectorRegistry.register(descriptor, order));
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
      listen<T>(name: string, handler: (payload: T) => void | Promise<void>): void {
        let un: UnlistenFn | null = null;
        let listenerDisposed = false;
        const deliver = async (payload: T) => {
          try {
            await handler(payload);
          } catch (error) {
            report(error, `event handler ${name}`);
          }
        };
        listen<T>(name, (event) => {
          if (!listenerDisposed && !disposed) void deliver(event.payload);
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
      onFilesChanged: (handler) => {
        track(subscribeToLocalFileChanges((directories) => {
          if (disposed) return;
          const changed = [...directories];
          void Promise.resolve().then(() => {
            if (!disposed) return handler(changed);
          }).catch((error) => report(error, "workspace file change handler"));
        }));
      },
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
      // Shares the ordered move session with cut/paste and drag-drop (#881):
      // the same conflict prompt, undo recording, ordering, and refresh.
      moveFile: async (sourcePath, targetDir) => {
        // The session reports a same-directory relocation as a committed,
        // "succeeded" item (it legitimately touches nothing, per
        // move_session.rs), so it toasts "Moved 1 item" and this would
        // otherwise report `{ok: true}`. That breaks the documented
        // `PluginMoveResult` no-op contract (`error: "skipped"`), which a
        // caller like the AI-organize dialog depends on to tell "nothing to
        // do" apart from "moved". Short-circuit before the session runs.
        if (sameDirectory(parentDir(sourcePath), targetDir)) {
          return { ok: false, error: "skipped" };
        }
        const { moveFiles } = await import("$lib/state/move-operations");
        const { error, complete } = await moveFiles([sourcePath], targetDir, {
          onRefresh: () => {
            for (const exp of windowTabsManager.getAllExplorers()) void exp.refresh({ silent: true });
          },
        });
        if (error) return { ok: false, error };
        return complete ? { ok: true } : { ok: false, error: "skipped" };
      },
    },
    openSettings: () => dialogStore.openSettings(),
  };

  return {
    ctx,
    reportFailure: report,
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
