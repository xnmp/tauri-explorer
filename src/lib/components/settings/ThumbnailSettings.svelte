<!--
  ThumbnailSettings — the Appearance thumbnail rows: the Tiles "Thumbnail
  Size" and the "Thumbnails in Details and List" toggle (#1465), which shows
  48px thumbnails in taller Details and List rows.
-->
<script lang="ts">
  import { settingsStore, type ThumbnailSize } from "$lib/state/settings.svelte";
  import { SETTINGS_ROWS as rows } from "$lib/domain/settings-rows";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";

  interface Props {
    /** The dialog's search filter. */
    matches: (...terms: string[]) => boolean;
  }

  const { matches }: Props = $props();
</script>

<SettingRow label="Thumbnail Size"
  description="Size of image thumbnails in tiles view"
  hidden={!matches(...rows.thumbnailSize)}>
  <select
    class="settings-select"
    value={settingsStore.thumbnailSize}
    onchange={(e) => settingsStore.update({ thumbnailSize: e.currentTarget.value as ThumbnailSize })}
  >
    <option value="small">Small</option>
    <option value="medium">Medium</option>
    <option value="large">Large</option>
    <option value="xlarge">Extra Large</option>
  </select>
</SettingRow>

<SettingRow label="Thumbnails in Details and List"
  description="Show image and video thumbnails in taller Details and List rows"
  hidden={!matches(...rows.rowThumbnails)}>
  <SettingToggle checked={settingsStore.state.rowThumbnails}
    onchange={() => settingsStore.update({ rowThumbnails: !settingsStore.state.rowThumbnails })} />
</SettingRow>
