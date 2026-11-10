/**
 * Mock OS clipboard commands: the published file list, cut leases and report attachments.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import { MOCK_LOCAL_KEYS } from "./mock-control";
import { file, mockFiles } from "./mock-fixtures";
import type { CommandHandler } from "./mock-dispatch";


/** In-memory OS clipboard file list, round-tripped by the clipboard_* mocks. */
let mockClipboardFiles: string[] = [];
let mockClipboardEntries: unknown[] | null = null;
let mockClipboardOperation: "copy" | "cut" | null = null;
let mockClipboardRevision = 0;
/** Revision whose Cut a paste has claimed (mirrors the native CutLease). */
let mockClipboardLease: number | null = null;

export const clipboardCommands: Record<string, CommandHandler> = {

  // ----- Clipboard file operations (os-clipboard.ts) -----
  // In-memory clipboard so write → has → read round-trips in browser/E2E mode,
  // mirroring the real OS clipboard contract (write paths, then read them back).

  clipboard_publish: (args: Record<string, unknown>) => {
    // Browser tests admit Cut by default, as every native backend does when
    // it proves ownership (#877). Set this flag to exercise Cut refusal.
    if (args.operation === "cut" && localStorage.getItem(MOCK_LOCAL_KEYS.cutOwnershipUnavailable) === "1") {
      throw new Error("Cut requires native clipboard ownership; Copy is available here");
    }
    const entries = args.entries as Array<{ path: string }>;
    mockClipboardFiles = entries.map((entry) => entry.path);
    mockClipboardEntries = entries;
    mockClipboardOperation = args.operation as "copy" | "cut";
    mockClipboardRevision++;
    return { revision: mockClipboardRevision, entries, paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null };
  },
  clipboard_snapshot: () => ({
    revision: mockClipboardRevision, entries: mockClipboardEntries,
    paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null,
  }),
  clipboard_compare_and_clear: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || !mockClipboardEntries) return false;
    mockClipboardRevision++;
    mockClipboardEntries = null;
    mockClipboardOperation = null;
    return true;
  },
  clipboard_claim_cut: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || mockClipboardOperation !== "cut"
      || !mockClipboardEntries || mockClipboardLease === mockClipboardRevision) return false;
    mockClipboardLease = mockClipboardRevision;
    return true;
  },
  clipboard_release_cut: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || mockClipboardLease !== args.revision) return false;
    mockClipboardLease = null;
    return true;
  },
  clipboard_rekey: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || !mockClipboardEntries) return null;
    const entries = mockClipboardEntries as Array<{ path: string }>;
    const index = entries.findIndex((entry) => entry.path === args.oldPath);
    if (index < 0) return null;
    mockClipboardEntries = entries.map((entry, at) => at === index ? args.entry : entry);
    mockClipboardFiles = (mockClipboardEntries as Array<{ path: string }>).map((entry) => entry.path);
    mockClipboardRevision++;
    return { revision: mockClipboardRevision, entries: mockClipboardEntries,
      paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null };
  },
  clipboard_read_text: () => localStorage.getItem(MOCK_LOCAL_KEYS.clipboardText) ?? "",

  clipboard_has_image: () =>
    localStorage.getItem(MOCK_LOCAL_KEYS.reportClipboardImage) === "1",

  clipboard_has_report_attachment: () => localStorage.getItem(MOCK_LOCAL_KEYS.reportClipboardVideo) === "1" || localStorage.getItem(MOCK_LOCAL_KEYS.reportClipboardImage) === "1",

  clipboard_read_report_attachment: () => localStorage.getItem(MOCK_LOCAL_KEYS.reportClipboardVideo) === "1"
    ? { name: "Copied video.mp4", mediaType: "video/mp4", data: "AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQy" }
    : { name: "Clipboard screenshot.png", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },

  clipboard_read_report_image: () => ({
    name: "Clipboard screenshot.png",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  }),

  // Mirrors the real backend: writes a PNG into `directory` and returns its
  // full path. Adds the entry to the mock fs so the pasted image shows up in
  // the directory listing. A deterministic filename keeps E2E assertions stable.
  clipboard_paste_image: (args: Record<string, unknown>) => {
    const directory = args.directory as string;
    const filename = "clipboard-image.png";
    const path = `${directory}/${filename}`;
    const entries = mockFiles[directory] || (mockFiles[directory] = []);
    if (!entries.some((e) => e.path === path)) {
      entries.push(file(filename, path, 4096));
    }
    return path;
  },
};
