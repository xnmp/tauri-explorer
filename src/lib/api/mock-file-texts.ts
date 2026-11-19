/**
 * The mock filesystem's file text beyond the fixtures: text written through
 * the mock (`mockWrittenFiles`, which wins over `mockFileContent`), and the
 * move of a file's text into and out of the Trash with its entry, so a file
 * created again at a trashed path starts empty and a restore brings the text
 * back.
 */
import { mockFileContent } from "./mock-fixtures";

/** Contents of files created via the mocked write_text_file. */
export const mockWrittenFiles: Record<string, string> = {};

/** File text held in the two text stores, by path. */
export interface MockTexts { content: Record<string, string>; written: Record<string, string> }

/** Remove the text of `path` (a file, or a folder's descendants) from the text stores and return it. */
export function takeMockTexts(path: string): MockTexts {
  const taken: MockTexts = { content: {}, written: {} };
  for (const [store, into] of [[mockFileContent, taken.content], [mockWrittenFiles, taken.written]] as const) {
    for (const key of Object.keys(store)) {
      if (key !== path && !key.startsWith(`${path}/`)) continue;
      into[key] = store[key];
      delete store[key];
    }
  }
  return taken;
}

/** Put text taken by `takeMockTexts` back, at `relocate(path)`. */
export function putMockTexts(texts: MockTexts | undefined, relocate: (path: string) => string = (path) => path): void {
  if (!texts) return;
  for (const [key, text] of Object.entries(texts.content)) mockFileContent[relocate(key)] = text;
  for (const [key, text] of Object.entries(texts.written)) mockWrittenFiles[relocate(key)] = text;
}
