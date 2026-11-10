<!--
  InstalledPluginSettings — installed plugin packages in the Plugins menu:
  install, enable and remove, plus activation failures. Rows use the shared
  Settings row, switch and button chrome so the list reads like every other
  Settings surface (#1529).
-->
<script lang="ts">
  import { matchesSettingsQuery } from "$lib/domain/settings-search";
  import { onMount } from "svelte";
  import { isTauri } from "$lib/api/common";
  import { listen } from "@tauri-apps/api/event";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import { installPackage, uninstallPackage, setPackageEnabled, installedPackages, packageFailure, refreshInstalledPackages, packageError, type InstalledPackage } from "$lib/plugins/installed";
  import SettingRow from "./settings/SettingRow.svelte";
  import SettingToggle from "./settings/SettingToggle.svelte";
  import "./settings/settings-button.css";

  let { query = "" }: { query?: string } = $props();
  let packages = $state<readonly InstalledPackage[]>([]);
  let busy = $state(false);
  let error = $state("");
  let loaded = $state(false);
  const visible = $derived(packages.filter(entry => matchesSettingsQuery(query, entry.manifest.name, entry.manifest.description, entry.manifest.version)));

  async function refresh() { await refreshInstalledPackages(pluginRegistry); packages = [...installedPackages()]; loaded = true; }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    busy = true; error = "";
    try { await action(); await refresh(); } catch (cause) { error = packageError(cause); } finally { busy = false; }
  }
  onMount(() => {
    let active = true; let unlisten: (() => void) | undefined;
    void refresh().catch((cause) => { if (active) error = packageError(cause); });
    if (isTauri()) void listen("plugins:changed", () => { if (active) void refresh().catch((cause) => { error = packageError(cause); }); }).then((dispose) => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  });
</script>

<div class="packages">
  <SettingRow class="install-row" label="Installed packages" description="Add a .teplugin package from disk." hidden={false}>
    <button class="settings-button" disabled={busy} onclick={() => perform(() => installPackage(pluginRegistry))}>Install plugin…</button>
  </SettingRow>
  {#if error}<p class="package-error" role="alert">{error}</p>{/if}
  {#if loaded && packages.length === 0}
    <p class="packages-empty">No plugin packages installed.</p>
  {/if}
  {#each visible as entry (entry.manifest.id)}
    <SettingRow class="package-row" label={entry.manifest.name} description={entry.manifest.description} hidden={false}>
      {#snippet info()}
        <span class="package-version">Version {entry.manifest.version}</span>
        {#if packageFailure(entry.manifest.id)}<p class="package-error" role="alert">{packageFailure(entry.manifest.id)}</p>{/if}
      {/snippet}
      <div class="package-controls">
        <SettingToggle
          checked={entry.enabled}
          disabled={busy}
          aria-label={`Enable ${entry.manifest.name}`}
          onchange={(event) => perform(() => setPackageEnabled(entry.manifest.id, event.currentTarget.checked, pluginRegistry))}
        />
        <button class="settings-button danger" disabled={busy} aria-label={`Remove ${entry.manifest.name}`} onclick={() => perform(() => uninstallPackage(entry.manifest.id, pluginRegistry))}>Remove</button>
      </div>
    </SettingRow>
  {/each}
</div>

<style>
  .packages {
    display: flex;
    flex-direction: column;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--divider);
  }
  .packages :global(.setting-row) {
    gap: 16px;
  }
  .packages :global(.setting-row:last-child) {
    border-bottom: none;
  }
  .package-controls {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 12px;
  }
  .package-version {
    font-size: 12px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .package-error {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--system-critical-text, var(--system-critical));
  }
  .packages > .package-error {
    margin: 0 0 8px;
  }
  .packages-empty {
    margin: 0;
    padding: 12px 0;
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>
