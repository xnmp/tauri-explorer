import { untrack } from "svelte";
import { DETAIL_COLUMNS, columnGridTemplate, normalizeColumnWidths,
  type ColumnKey, type ColumnWidths, type ColumnVisibility } from "$lib/domain/detail-columns";
import { resizeSizeFromKey } from "$lib/domain/resize-size";
import { useControlledSize } from "$lib/composables/use-controlled-size.svelte";

/** One gesture owns one column. Retire it before changing the key so neither its
 * pending frame nor its final commit can be attributed to a replacement column. */
export function useColumnResize(initialWidths?: Partial<ColumnWidths>,
  getVisibility: () => ColumnVisibility = () => ({ date: true, type: true, size: true })) {
  let committed = $state(normalizeColumnWidths(initialWidths));
  let column = $state<ColumnKey>("name");
  const resize = useControlledSize(() => committed[column],
    value => { committed = { ...committed, [column]: value }; },
    () => DETAIL_COLUMNS[column]);
  const widths = $derived({ ...committed, [column]: resize.value });
  const gridTemplateColumns = $derived(columnGridTemplate(widths, getVisibility()));

  $effect(() => {
    const visible = getVisibility();
    if (column !== "name" && !visible[column]) untrack(resize.cancel);
  });

  function select(key: ColumnKey) {
    resize.cancel();
    column = key;
  }
  function startResize(key: ColumnKey, event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    select(key);
    resize.startResize(event);
  }
  function keydown(key: ColumnKey, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey
      || resizeSizeFromKey(widths[key], event.key, DETAIL_COLUMNS[key]) === undefined) return;
    select(key);
    resize.keydown(event);
  }

  return { get columnWidths() { return widths; }, get gridTemplateColumns() { return gridTemplateColumns; },
    get isResizing() { return resize.isResizing; }, get activeColumn() { return resize.isResizing ? column : null; },
    startResize, keydown, move: resize.move, finish: resize.finish, cancelPointer: resize.cancelPointer };
}
