/**
 * Built-in plugin registry + lifecycle.
 *
 * Plugins are statically imported (CSP forbids runtime JS loading) and toggled
 * on/off at runtime. Enable state persists in settings (`pluginsEnabled`);
 * absent ids fall back to each plugin's `enabledByDefault` (default true).
 *
 * `initPlugins()` runs once at startup and activates every enabled plugin.
 * Toggling calls `setEnabled`, which activates or fully deactivates (disposing
 * all contributions) on the spot.
 */

import { createPluginContext, type Plugin } from "./api";
import { settingsStore } from "$lib/state/settings.svelte";
import { demoPlugin } from "./demo";
import { nanoBananaPlugin } from "./nano-banana";
import { aiRenamePlugin } from "./ai-rename";
import { aiOrganizePlugin } from "./ai-organize";
import { themeFromImagePlugin } from "./theme-from-image";
import { upscalePlugin } from "./upscale";
import { pluginJobsController } from "$lib/state/plugin-jobs";

/** Statically-imported built-in plugins (explicit imports — no dynamic load). */
const BUILT_IN_PLUGINS: Plugin[] = [demoPlugin, nanoBananaPlugin, aiRenamePlugin, aiOrganizePlugin, themeFromImagePlugin, upscalePlugin];

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

function createPluginRegistry(
  plugins: Plugin[] = BUILT_IN_PLUGINS,
  jobLifecycle: Pick<typeof pluginJobsController, "dispose"> = pluginJobsController,
) {
  const active = new Map<string, { plugin: Plugin; dispose: () => void }>();
  // In-flight activations, so a disable arriving mid-activate can't be lost
  // (deactivate would find nothing in `active` and no-op, leaving a
  // "disabled" plugin fully registered once the await resolves).
  type Activation = {
    dispose: () => void;
    promise: Promise<void>;
    cancelled: boolean;
    deactivated: boolean;
  };
  const activating = new Map<string, Activation>();
  let closed = false;
  let disposal: Promise<void> | null = null;

  function isEnabled(plugin: Plugin): boolean {
    const map = settingsStore.pluginsEnabled ?? {};
    return map[plugin.id] ?? plugin.enabledByDefault ?? true;
  }

  function activate(plugin: Plugin): Promise<void> {
    if (closed) return Promise.resolve();
    if (active.has(plugin.id)) return Promise.resolve();
    const inFlight = activating.get(plugin.id);
    if (inFlight) {
      return inFlight.cancelled
        ? inFlight.promise.then(() => (isEnabled(plugin) ? activate(plugin) : undefined))
        : inFlight.promise;
    }

    const { ctx, dispose } = createPluginContext(plugin.id);
    const activation: Activation = {
      dispose,
      promise: Promise.resolve(),
      cancelled: false,
      deactivated: false,
    };
    activating.set(plugin.id, activation);
    const deactivateActivation = () => {
      if (!activation.deactivated) {
        activation.deactivated = true;
        try {
          plugin.deactivate?.();
        } catch (err) {
          console.error(`[plugins] deactivate hook for "${plugin.id}" threw:`, err);
        }
      }
      dispose();
    };

    const run = (async () => {
      try {
        await plugin.activate(ctx);
        if (activation.cancelled || !isEnabled(plugin)) {
          deactivateActivation();
          return;
        }
        active.set(plugin.id, { plugin, dispose });
      } catch (err) {
        // Activation may have acquired plugin-private resources before it
        // failed. Give its hook one chance to release them as well as the
        // context-owned contributions.
        deactivateActivation();
        console.error(`[plugins] failed to activate "${plugin.id}":`, err);
      } finally {
        if (activating.get(plugin.id) === activation) activating.delete(plugin.id);
      }
    })();
    activation.promise = run;
    return run;
  }

  function deactivate(id: string): void {
    const inFlight = activating.get(id);
    if (inFlight) {
      inFlight.cancelled = true;
      // Context contributions disappear immediately. The plugin hook runs
      // after activate settles, so resources acquired after its final await
      // are covered too; a re-enable waits for that cleanup before retrying.
      inFlight.dispose();
      return;
    }
    const entry = active.get(id);
    if (!entry) return; // not active (an in-flight activate re-checks isEnabled)
    try {
      entry.plugin.deactivate?.();
    } catch (err) {
      console.error(`[plugins] deactivate hook for "${id}" threw:`, err);
    }
    entry.dispose();
    active.delete(id);
  }

  return {
    /** Activate all currently-enabled built-in plugins. Call once at startup. */
    async initPlugins(): Promise<void> {
      if (closed) return;
      // Job event ownership starts lazily inside jobs.accept, before its
      // backend invocation. Unused optional jobs do no startup IPC work.
      for (const plugin of plugins) {
        if (closed) return;
        if (isEnabled(plugin)) await activate(plugin);
      }
    },

    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      const inFlight = [...activating.values()];
      for (const activation of inFlight) {
        activation.cancelled = true;
        activation.dispose();
      }
      for (const id of [...active.keys()]) deactivate(id);
      disposal = (async () => {
        await Promise.allSettled(inFlight.map((activation) => activation.promise));
        await jobLifecycle.dispose();
      })();
      return disposal;
    },

    /** Persist the new enabled state and activate/deactivate immediately. */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      settingsStore.setPluginEnabled(id, enabled);
      if (closed) return;
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) return;
      if (enabled) await activate(plugin);
      else deactivate(id);
    },

    /** True when a plugin is currently activated. */
    isActive(id: string): boolean {
      return active.has(id);
    },

    /** Reactive list for the settings UI (enabled state tracks settings). */
    get plugins(): PluginInfo[] {
      return plugins.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        enabled: isEnabled(p),
      }));
    },
  };
}

/** Factory export for tests (injectable plugin list). */
export { createPluginRegistry };

export const pluginRegistry = createPluginRegistry();
