<!--
  PreviewCsvTable — CSV preview (#666): one outer horizontal scroll surface,
  a sticky header and virtualized data rows sharing one column template
  (domain/csv-preview).
-->
<script lang="ts">
  import VirtualList from "./VirtualList.svelte";
  import { csvColumnTemplate, csvRowHeight, type CsvPreview } from "$lib/domain/csv-preview";

  const { csv }: { csv: CsvPreview } = $props();
</script>

  <div class="preview-csv" role="table" aria-label="CSV preview">
    <div class="preview-csv-table" style={`--csv-column-template: ${csvColumnTemplate(csv)};`}>
      <div class="preview-csv-row preview-csv-header" role="row">
        {#each csv.header as cell, index (index)}
          <div class="preview-csv-cell" role="columnheader">{cell}</div>
        {/each}
      </div>
      <VirtualList items={csv.rows} itemHeight={28} getItemHeight={csvRowHeight} getKey={(_row, index) => index} itemOverflow="visible" class="preview-csv-rows">
        {#snippet children(row)}
          <div class="preview-csv-row" role="row">
            {#each row as cell, index (index)}
              <div class="preview-csv-cell" role="cell">{cell}</div>
            {/each}
          </div>
        {/snippet}
      </VirtualList>
    </div>
  </div>

<style>
  .preview-csv {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    font-size: var(--preview-font-size, 12px);
    color: var(--text-secondary);
  }

  .preview-csv-table {
    display: flex;
    flex: 1;
    flex-direction: column;
    width: max-content;
    min-width: 100%;
    min-height: 0;
  }

  .preview-csv-row {
    display: grid;
    grid-template-columns: var(--csv-column-template);
  }

  .preview-csv-header {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--background-solid);
    border-bottom: 1px solid var(--divider);
    font-weight: 600;
  }

  .preview-csv-cell {
    min-width: 0;
    padding: 6px 10px;
    border-right: 1px solid var(--divider);
    border-bottom: 1px solid color-mix(in srgb, var(--divider) 65%, transparent);
    white-space: pre;
    line-height: 16px;
  }

  .preview-csv-table :global(.preview-csv-rows) {
    overflow-x: visible;
  }
</style>
