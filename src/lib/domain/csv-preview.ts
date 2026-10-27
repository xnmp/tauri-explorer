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
export function parseCsvPreview(text: string, maxRows = 200): CsvPreview | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;

  const endRecord = () => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
    quoteClosed = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character === "\r" && text[index + 1] === "\n" ? "\n" : character;
        if (character === "\r" && text[index + 1] === "\n") index += 1;
      }
      continue;
    }

    if (quoteClosed && character !== "," && character !== "\n" && character !== "\r") return null;
    if (character === '"') {
      if (field.length !== 0) return null;
      quoted = true;
      quoteClosed = false;
    } else if (character === ",") {
      record.push(field);
      field = "";
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      field += character;
    }
  }

  if (quoted) return null;
  if (field.length > 0 || record.length > 0 || (text.length > 0 && !/[\r\n]$/.test(text))) endRecord();
  if (records.length === 0) return null;

  const [header, ...dataRows] = records;
  if (dataRows.some((row) => row.length !== header.length)) return null;
  header[0] = header[0]?.replace(/^\uFEFF/, "") ?? "";
  return {
    header,
    rows: dataRows.slice(0, Math.max(0, maxRows)),
    totalRows: dataRows.length,
  };
}

/** Virtual-row height: a 28px single-line floor, then 16px per wrapped line
 *  of the row's tallest cell plus its 12px vertical padding. */
export function csvRowHeight(row: readonly string[]): number {
  return Math.max(28, 12 + Math.max(...row.map((cell) => cell.split("\n").length)) * 16);
}

/** One column template shared by the sticky header and every virtual row. */
export function csvColumnTemplate(csv: CsvPreview): string {
  return csv.header
    .map((header, column) => {
      const longestCell = Math.max(header.length, ...csv.rows.map((row) => row[column]?.length ?? 0));
      // Pixels keep a track's computed width identical in the bold header
      // and normal-weight data rows; `ch` varies with font weight.
      return `${Math.max(128, longestCell * 8 + 20)}px`;
    })
    .join(" ");
}
