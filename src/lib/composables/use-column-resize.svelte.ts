/**
 * Column resize composable for FileList details view.
 * Issue: tauri-explorer-1k9k
 *
 * Extracts column resize logic from FileList to reduce complexity.
 */

export interface ColumnWidths {
  name: number;
  date: number;
  type: number;
  size: number;
}

export type ColumnKey = keyof ColumnWidths;

const MIN_COL_WIDTH = 80;
const MIN_NAME_WIDTH = 150;

const DEFAULT_WIDTHS: ColumnWidths = {
  name: 300,
  date: 180,
  type: 140,
  size: 100,
};

export function useColumnResize(initialWidths?: Partial<ColumnWidths>) {
  let columnWidths = $state<ColumnWidths>({ ...DEFAULT_WIDTHS, ...initialWidths });
  let isResizing = $state(false);
  let resizeColumn = $state<ColumnKey | null>(null);
  let resizeStartX = $state(0);
  let resizeStartWidth = $state(0);

  const gridTemplateColumns = $derived(
    `${columnWidths.name}px ${columnWidths.date}px ${columnWidths.type}px ${columnWidths.size}px`
  );

  function startResize(column: ColumnKey, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    isResizing = true;
    resizeColumn = column;
    resizeStartX = event.clientX;
    resizeStartWidth = columnWidths[column];
  }

  function handleResize(event: MouseEvent): void {
    if (!isResizing || !resizeColumn) return;
    const delta = event.clientX - resizeStartX;
    const minWidth = resizeColumn === "name" ? MIN_NAME_WIDTH : MIN_COL_WIDTH;
    const newWidth = Math.max(minWidth, resizeStartWidth + delta);
    columnWidths = { ...columnWidths, [resizeColumn]: newWidth };
  }

  function endResize(): void {
    isResizing = false;
    resizeColumn = null;
  }

  return {
    get columnWidths() {
      return columnWidths;
    },
    get isResizing() {
      return isResizing;
    },
    get gridTemplateColumns() {
      return gridTemplateColumns;
    },
    startResize,
    handleResize,
    endResize,
  };
}
