<!--
  Translucency Opacity (#1735): the macOS Native Blur slider. The page maps
  its percent to the island coverage variables (domain/vibrancy-opacity).
-->
<script lang="ts">
  import { settingsStore } from "$lib/state/settings.svelte";
  import { SETTINGS_ROWS } from "$lib/domain/settings-rows";
  import { TRANSLUCENCY_OPACITY_MAX, TRANSLUCENCY_OPACITY_MIN } from "$lib/domain/vibrancy-opacity";
  import SettingRow from "./SettingRow.svelte";

  const { hidden }: { hidden: boolean } = $props();
  const [label] = SETTINGS_ROWS.translucencyOpacity;
</script>

<SettingRow {label}
  description="How much of the frosted-glass material the panels hide ({settingsStore.translucencyOpacity}%, lower = more see-through)"
  {hidden}>
  <input
    class="translucency-opacity-input"
    type="range"
    min={TRANSLUCENCY_OPACITY_MIN}
    max={TRANSLUCENCY_OPACITY_MAX}
    step="1"
    value={settingsStore.translucencyOpacity}
    oninput={(e) => settingsStore.update({ translucencyOpacity: Number(e.currentTarget.value) })}
  />
</SettingRow>

<style>
  .translucency-opacity-input {
    width: 140px;
    accent-color: var(--accent);
    cursor: pointer;
  }
</style>
