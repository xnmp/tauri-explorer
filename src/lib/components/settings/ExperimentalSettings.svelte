<!--
  ExperimentalSettings — the Experimental section's feature-flag rows (#175).
  `matches` is the dialog's settings-filter predicate for a row's terms.
-->
<script lang="ts">
  import { settingsStore } from "$lib/state/settings.svelte";
  import { SETTINGS_ROWS as rows } from "$lib/domain/settings-rows";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";

  interface Props {
    matches: (...terms: string[]) => boolean;
  }

  const { matches }: Props = $props();
</script>

<SettingRow label="Integrated Terminal"
  description="Enable the embedded terminal panel (Alt+M T)"
  hidden={!matches(...rows.enableTerminal)}>
  <SettingToggle checked={settingsStore.enableTerminal} onchange={() => settingsStore.toggleEnableTerminal()} />
</SettingRow>

<SettingRow label="Git Commit Graph"
  description="Show the repo's commit graph in the active pane (command palette: Git: Toggle Commit Graph, Ctrl+Alt+G)"
  hidden={!matches(...rows.enableGitGraph)}>
  <SettingToggle checked={settingsStore.enableGitGraph} onchange={() => settingsStore.toggleEnableGitGraph()} />
</SettingRow>
