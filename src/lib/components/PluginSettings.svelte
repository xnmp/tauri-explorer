<script lang="ts">
  import { matchesSettingsQuery } from "$lib/domain/settings-search";
  import InstalledPluginSettings from "./InstalledPluginSettings.svelte";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";

  let { query = "" }: { query?: string } = $props();
  const matchesSearch = (...terms: string[]) => matchesSettingsQuery(query, ...terms);
</script>

<section class="settings-section">
  <h3 class="section-title">Plugins</h3>
  <InstalledPluginSettings {query} />
  {#each pluginRegistry.plugins as plugin (plugin.id)}
    <div class="setting-row" class:hidden={!matchesSearch("Plugins", plugin.name, plugin.description)}>
      <div class="setting-info">
        <span class="setting-label">{plugin.name}</span>
        <span class="setting-description">{plugin.description}</span>
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          aria-label={`Enable ${plugin.name}`}
          checked={plugin.enabled}
          onchange={(e) => pluginRegistry.setEnabled(plugin.id, e.currentTarget.checked)}
        />
        <span class="toggle-slider"></span>
      </label>
    </div>
  {/each}
</section>

<!-- Plugin-contributed settings sections (descriptor-driven) -->
{#each pluginSettingsSections.sections as section (section.pluginId + ":" + section.id)}
  <section class="settings-section" class:hidden={!section.rows.some(row => matchesSearch(section.title, row.label, row.description ?? "")) && !section.actions.some(action=>matchesSearch(section.title,action.label,action.description??"")) && !matchesSearch(section.title)}>
    <h3 class="section-title">{section.title}</h3>
    {#each section.rows as row (row.id)}
      <div class="setting-row" class:hidden={!matchesSearch(section.title, row.label, row.description ?? "")}>
        <div class="setting-info">
          <span class="setting-label">{row.label}</span>
          {#if row.description}
            <span class="setting-description">{row.description}</span>
          {/if}
        </div>
        {#if row.type === "toggle"}
          <label class="toggle">
            <input
              type="checkbox"
              aria-label={row.label}
              checked={!!section.valueOf(row)}
              onchange={(e) => section.setValue(row.id, e.currentTarget.checked)}
            />
            <span class="toggle-slider"></span>
          </label>
        {:else if row.type === "select"}
          <select
            aria-label={row.label}
            class="theme-select"
            value={String(section.valueOf(row) ?? "")}
            onchange={(e) => section.setValue(row.id, e.currentTarget.value)}
          >
            {#each row.options ?? [] as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        {:else}
          <input
            aria-label={row.label}
            class="text-input"
            type={row.type === "password" ? "password" : "text"}
            value={String(section.valueOf(row) ?? "")}
            onchange={(e) => section.setValue(row.id, e.currentTarget.value)}
          />
        {/if}
      </div>
    {/each}
    {#each section.actions as action (action.id)}
      <div class="setting-row" class:hidden={!matchesSearch(section.title,action.label,action.description??"")}>
        <div class="setting-info"><span class="setting-label">{action.label}</span>{#if action.description}<span class="setting-description">{action.description}</span>{/if}</div>
        <button class="settings-action" onclick={()=>action.run()}>{action.label}</button>
      </div>
    {/each}
  </section>
{/each}

<style>
  .hidden { display: none !important; }
  .settings-action {flex-shrink:0;padding:6px 10px;border:1px solid var(--control-stroke);border-radius:var(--radius-sm);background:var(--control-fill);color:var(--text-primary);font:inherit;font-size:13px;cursor:pointer;}
  .settings-action:focus-visible {outline:2px solid var(--focus-stroke-outer);outline-offset:2px;}

  .settings-section { margin-bottom: 24px; }
  .settings-section:last-child { margin-bottom: 0; }
  .section-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0 0 8px; padding-bottom: 8px; border-bottom: 1px solid var(--divider); }
  .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--divider); }
  .setting-row:last-child { border-bottom: none; }
  .setting-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .setting-label { font-size: 14px; font-weight: 500; color: var(--text-primary); }
  .setting-description { font-size: 12px; color: var(--text-tertiary); }
  .text-input, .theme-select { width: 220px; min-width: 0; max-width: 50%; padding: 6px 8px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; font-size: 13px; }
  .text-input:focus-visible, .theme-select:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .toggle {
    position: relative;
    display: inline-block;
    flex: 0 0 44px;
    height: 24px;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--control-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: 12px;
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast);
  }

  .toggle-slider::before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: transform var(--transition-fast);
  }

  .toggle input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle input:checked + .toggle-slider::before {
    transform: translateX(20px);
    background: var(--text-on-accent);
  }

  .toggle input:focus-visible + .toggle-slider {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }
</style>
