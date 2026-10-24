/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 *
 * `common.ts` imports this module dynamically, and only outside Tauri, so the
 * fixtures never enter the native cold-start graph. Each command family lives
 * in its own module (#1372); this core merges their tables and applies the
 * native application boundary (copy/move sessions and history receipts).
 */
import { installMockCommands, invokeMockCommand, type CommandHandler } from "./mock-dispatch";
import { aiCommands } from "./mock-ai";
import { clipboardCommands } from "./mock-clipboard";
import { fileCommands, runMockCopySession, withMockFileHistory } from "./mock-files";
import { fileRecoveryCommands } from "./mock-file-recovery";
import { gitCommands } from "./mock-git";
import { gitHistoryCommands } from "./mock-git-history";
import { previewCommands } from "./mock-preview";
import { searchCommands } from "./mock-search";
import { systemCommands } from "./mock-system";

export { MOCK_LONG_COMMIT_FILE_PATH } from "./mock-git-state";
export { MOCK_CONFIG_SEED_KEY } from "./mock-system";

/** Every command family, by module. Command names are unique across families
 * (tests/api/mock-invoke-parity.test.ts checks this and Rust parity). */
export const mockCommandFamilies: Readonly<Record<string, Readonly<Record<string, CommandHandler>>>> = {
  ai: aiCommands,
  clipboard: clipboardCommands,
  files: fileCommands,
  fileRecovery: fileRecoveryCommands,
  git: gitCommands,
  gitHistory: gitHistoryCommands,
  preview: previewCommands,
  search: searchCommands,
  system: systemCommands,
};

const mockCommands: Record<string, CommandHandler> = Object.assign({}, ...Object.values(mockCommandFamilies));
installMockCommands(mockCommands);

/** Commands `mockInvoke` handles itself rather than through a family table. */
export const MOCK_SESSION_COMMANDS = ["copy_entries", "move_entries"] as const;

/**
 * Mock invoke function for browser-based testing.
 */
/** Match the native application boundary; inverse execution calls the raw
 * fixture command so it cannot recursively record forward history. */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "copy_entries" || cmd === "move_entries") return runMockCopySession<T>(cmd, args);
  const result = await invokeMockCommand<unknown>(cmd, args);
  return withMockFileHistory<T>(cmd, args, result);
}
