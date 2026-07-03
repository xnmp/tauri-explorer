/**
 * Plugin API surface.
 *
 * Loading model — decided by CSP. `script-src 'self'` (tauri.conf.json) rules
 * out runtime-loaded plugin JS. Plugins are therefore build-time-bundled
 * modules statically imported into the registry, with runtime enable/disable.
 * See docs/architecture/plugins.md.
 *
 * A plugin declares `activate(ctx)` and (optionally) `deactivate()`. Every
 * contribution made through the context is tracked and disposed automatically
 * when the plugin deactivates, so toggling a plugin off cleanly unregisters
 * everything it added — commands, context-menu items, settings sections, fs
 * providers and event listeners.
 */

import type { Command } from "$lib/state/commands.svelte";
import { registerCommand, unregisterCommand } from "$lib/state/commands.svelte";
import { contextMenuItems, type ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import { registerFsProvider, type FsProvider } from "./fs-providers";
import { pluginSettingsSections } from "./settings-registry.svelte";
import { jobsStore } from "$lib/state/jobs.svelte";
import { toastStore, type ToastType } from "$lib/state/toast.svelte";
import { readConfigFile } from "$lib/api/files";
import { writeConfigQueued } from "$lib/state/persisted";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

/** Source-tagged handle over the shared jobs store for a single plugin. */
export interface PluginJobs {
  add(id: number, label: string, detail: string): void;
  complete(id: number, outputPath: string): void;
  fail(id: number, error: string): void;
}

export interface PluginToast {
  show(message: string, variant?: ToastType): void;
  error(message: string): void;
}

export interface PluginEvents {
  /** Listen for a backend/window event; auto-disposed on deactivate. */
  listen<T = unknown>(name: string, handler: (payload: T) => void): void;
}

/**
 * The capability surface handed to a plugin's `activate`. Plugins never call
 * `invoke` directly — every side effect routes through this object so it can be
 * tracked and torn down.
 */
export interface PluginContext {
  registerCommand(cmd: Command): void;
  registerContextMenuItem(item: ContextMenuItem): void;
  registerSettingsSection(section: SettingsSectionDescriptor): void;
  registerFsProvider(scheme: string, provider: FsProvider): void;
  jobs: PluginJobs;
  toast: PluginToast;
  events: PluginEvents;
  storage: PluginStorage;
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
  const track = (fn: () => void) => disposers.push(fn);
  const storage = createPluginStorage(pluginId);

  const ctx: PluginContext = {
    registerCommand(cmd: Command): void {
      registerCommand(cmd);
      track(() => unregisterCommand(cmd.id));
    },
    registerContextMenuItem(item: ContextMenuItem): void {
      track(contextMenuItems.register(item));
    },
    registerSettingsSection(section: SettingsSectionDescriptor): void {
      track(pluginSettingsSections.register(pluginId, section, storage));
    },
    registerFsProvider(scheme: string, provider: FsProvider): void {
      track(registerFsProvider(scheme, provider));
    },
    jobs: {
      add: (id, label, detail) => jobsStore.addJob(id, label, detail, pluginId),
      complete: (id, outputPath) => jobsStore.completeJob(id, outputPath),
      fail: (id, error) => jobsStore.failJob(id, error),
    },
    toast: {
      show: (message, variant) => toastStore.show(message, variant),
      error: (message) => toastStore.error(message),
    },
    events: {
      listen<T>(name: string, handler: (payload: T) => void): void {
        let un: UnlistenFn | null = null;
        let disposed = false;
        listen<T>(name, (event) => handler(event.payload))
          .then((fn) => {
            if (disposed) fn();
            else un = fn;
          })
          .catch(() => {
            // Outside Tauri (browser/mock) the event system is unavailable.
          });
        track(() => {
          disposed = true;
          un?.();
        });
      },
    },
    storage,
  };

  return {
    ctx,
    dispose: () => {
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
