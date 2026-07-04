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

/** Statically-imported built-in plugins (explicit imports — no dynamic load). */
const BUILT_IN_PLUGINS: Plugin[] = [demoPlugin, nanoBananaPlugin, aiRenamePlugin, aiOrganizePlugin];

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

function createPluginRegistry(plugins: Plugin[] = BUILT_IN_PLUGINS) {
  const active = new Map<string, { plugin: Plugin; dispose: () => void }>();
  // In-flight activations, so a disable arriving mid-activate can't be lost
  // (deactivate would find nothing in `active` and no-op, leaving a
  // "disabled" plugin fully registered once the await resolves).
  const activating = new Map<string, Promise<void>>();

  function isEnabled(plugin: Plugin): boolean {
    const map = settingsStore.pluginsEnabled ?? {};
    return map[plugin.id] ?? plugin.enabledByDefault ?? true;
  }

  function activate(plugin: Plugin): Promise<void> {
    if (active.has(plugin.id)) return Promise.resolve();
    const inFlight = activating.get(plugin.id);
    if (inFlight) return inFlight;

    const run = (async () => {
      const { ctx, dispose } = createPluginContext(plugin.id);
      try {
        await plugin.activate(ctx);
        if (!isEnabled(plugin)) {
          // Disabled while activating — tear down what just registered.
          try {
            plugin.deactivate?.();
          } catch (err) {
            console.error(`[plugins] deactivate hook for "${plugin.id}" threw:`, err);
          }
          dispose();
          return;
        }
        active.set(plugin.id, { plugin, dispose });
      } catch (err) {
        dispose();
        console.error(`[plugins] failed to activate "${plugin.id}":`, err);
      } finally {
        activating.delete(plugin.id);
      }
    })();
    activating.set(plugin.id, run);
    return run;
  }

  function deactivate(id: string): void {
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
      for (const plugin of plugins) {
        if (isEnabled(plugin)) await activate(plugin);
      }
    },

    /** Persist the new enabled state and activate/deactivate immediately. */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      settingsStore.setPluginEnabled(id, enabled);
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
