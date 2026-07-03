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

/** Statically-imported built-in plugins (explicit imports — no dynamic load). */
const BUILT_IN_PLUGINS: Plugin[] = [demoPlugin, nanoBananaPlugin];

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

function createPluginRegistry() {
  const active = new Map<string, { plugin: Plugin; dispose: () => void }>();

  function isEnabled(plugin: Plugin): boolean {
    const map = settingsStore.pluginsEnabled ?? {};
    return map[plugin.id] ?? plugin.enabledByDefault ?? true;
  }

  async function activate(plugin: Plugin): Promise<void> {
    if (active.has(plugin.id)) return;
    const { ctx, dispose } = createPluginContext(plugin.id);
    try {
      await plugin.activate(ctx);
      active.set(plugin.id, { plugin, dispose });
    } catch (err) {
      dispose();
      console.error(`[plugins] failed to activate "${plugin.id}":`, err);
    }
  }

  function deactivate(id: string): void {
    const entry = active.get(id);
    if (!entry) return;
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
      for (const plugin of BUILT_IN_PLUGINS) {
        if (isEnabled(plugin)) await activate(plugin);
      }
    },

    /** Persist the new enabled state and activate/deactivate immediately. */
    async setEnabled(id: string, enabled: boolean): Promise<void> {
      settingsStore.setPluginEnabled(id, enabled);
      const plugin = BUILT_IN_PLUGINS.find((p) => p.id === id);
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
      return BUILT_IN_PLUGINS.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        enabled: isEnabled(p),
      }));
    },
  };
}

export const pluginRegistry = createPluginRegistry();
