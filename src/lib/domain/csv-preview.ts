/** A CSV table ready for display in the preview pane. */
export interface CsvPreview {
  header: string[];
  rows: string[][];
  totalRows: number;
}

/**
 * Parses CSV text into display rows. `null` means the caller should retain its
 * existing plain-text preview.
 */
export function parseCsvPreview(_text: string, _maxRows = 200): CsvPreview | null {
  return null;
}
