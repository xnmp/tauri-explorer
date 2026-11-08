import { untrack } from "svelte";
import { DETAIL_COLUMNS, columnGridTemplate, normalizeColumnWidths,
  type ColumnKey, type ColumnWidths, type ColumnVisibility } from "$lib/domain/detail-columns";
import { PLUGIN_COLUMN_SIZE, type PluginDetailColumn } from "$lib/domain/plugin-detail-columns";
import { resizeSizeFromKey, type ResizeSizeOptions } from "$lib/domain/resize-size";
import { useControlledSize } from "$lib/composables/use-controlled-size.svelte";

/** One gesture owns one column. Retire it before changing the key so neither its
 * pending frame nor its final commit can be attributed to a replacement column.
 * Plugin columns (#1523) follow built-in columns, keyed by their qualified id. */
export function useColumnResize(initialWidths?: Partial<ColumnWidths>,
  getVisibility: () => ColumnVisibility = () => ({ date: true, type: true, size: true, length: true, resolution: true, opened: false }),
  getPluginColumns: () => readonly PluginDetailColumn[] = () => []) {
  let committed = $state<Record<string, number>>(normalizeColumnWidths(initialWidths));
  let column = $state<string>("name");
  const options = (key: string): ResizeSizeOptions & { label: string } => Object.hasOwn(DETAIL_COLUMNS, key)
    ? DETAIL_COLUMNS[key as ColumnKey]
    : { ...PLUGIN_COLUMN_SIZE, default: 120, label: key, ...plugin(key) };
  const plugin = (key: string) => {
    const found = getPluginColumns().find((candidate) => candidate.id === key);
    return found && { default: found.width, label: found.label };
  };
  const widthOf = (key: string) => committed[key] ?? options(key).default;
  const resize = useControlledSize(() => widthOf(column),
    value => { committed = { ...committed, [column]: value }; },
    () => options(column));
  const widths = $derived({ ...committed, [column]: resize.value } as ColumnWidths & Record<string, number>);
  const gridTemplateColumns = $derived([columnGridTemplate(widths, getVisibility()),
    ...getPluginColumns().map((plugin) => `${widths[plugin.id] ?? plugin.width}px`)].join(" "));

  $effect(() => {
    const visible = getVisibility();
    const shown = Object.hasOwn(DETAIL_COLUMNS, column) ? !!visible[column as keyof ColumnVisibility] : !!plugin(column);
    if (column !== "name" && !shown) untrack(resize.cancel);
  });

  function select(key: string) {
    resize.cancel();
    column = key;
  }
  function startResize(key: string, event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    select(key);
    resize.startResize(event);
  }
  function keydown(key: string, event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey
      || resizeSizeFromKey(widths[key] ?? widthOf(key), event.key, options(key)) === undefined) return;
    select(key);
    resize.keydown(event);
  }

  return { get columnWidths() { return widths; }, get gridTemplateColumns() { return gridTemplateColumns; },
    get isResizing() { return resize.isResizing; }, get activeColumn() { return resize.isResizing ? column : null; },
    /** Current width of any column, built-in or plugin. */
    width: (key: string) => widths[key] ?? widthOf(key), options,
    startResize, keydown, move: resize.move, finish: resize.finish, cancelPointer: resize.cancelPointer };
}
