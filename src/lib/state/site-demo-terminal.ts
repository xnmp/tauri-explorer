/**
 * Site demo: the in-memory shell (`domain/demo-shell.ts`) behind the mock
 * PTY, so the real terminal panel works on the marketing site. Reads come
 * straight from the mock filesystem; every change goes through the mock
 * backend's own commands (with their history receipts), and the touched
 * folders are announced the way another window's changes are, so open panes
 * and caches refresh.
 *
 * Loaded only by the site-demo build (`hooks.client.ts`).
 */
import { createDemoShellSession, type DemoShellSession } from "$lib/domain/demo-shell";
import type { ShellEntry, ShellFs } from "$lib/domain/demo-shell-commands";
import { fixtureRepoFor } from "$lib/api/mock-git-fixture";
import { mockFileContent, mockFiles } from "$lib/api/mock-fixtures";
import { mockWrittenFiles } from "$lib/api/mock-files";
import { mockInvoke } from "$lib/api/mock-invoke";
import { emitMockTerminal, setMockTerminalBackend } from "$lib/api/mock-terminal";
import { basename, parentDir } from "$lib/domain/path";
import { broadcastFileChange } from "./file-events";
import { windowTabsManager } from "./window-tabs.svelte";

const toShellEntry = (e: { name: string; path: string; kind: string; size: number; modified: string }): ShellEntry =>
  ({ name: e.name, path: e.path, dir: e.kind === "directory", size: e.size, modified: e.modified });

/** Tell every pane and directory cache that `dirs` changed outside it. */
function announce(dirs: string[]): void {
  const unique = [...new Set(dirs)];
  broadcastFileChange(unique);
  for (const explorer of windowTabsManager.getAllExplorers()) {
    for (const path of unique) explorer.directoryChanged({ path, origin: "watcher" });
  }
}

/** The mock backend stamps new entries with fixed test times; a shell edit happens now. */
function stampNow(path: string): void {
  const parent = parentDir(path);
  const entries = mockFiles[parent];
  const index = entries?.findIndex((e) => e.path === path) ?? -1;
  if (index >= 0) entries[index] = { ...entries[index], modified: new Date().toISOString() };
}

const failure = (error: unknown) => (error instanceof Error ? error.message
  : typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : String(error));

async function attempt(dirs: string[], run: () => Promise<string | null>): Promise<string | null> {
  try {
    const error = await run();
    if (error === null) announce(dirs);
    return error;
  } catch (error) {
    return failure(error);
  }
}

type SessionOutcome = { result: { items: Array<{ status: string; error?: string; receipt?: { path: string } }> } };

async function relocate(command: "move_entries" | "copy_entries", from: string, to: string): Promise<string | null> {
  const destDir = parentDir(to);
  if (command === "move_entries" && parentDir(from) === destDir) {
    await mockInvoke("rename_entry", { path: from, newName: basename(to) });
    return null;
  }
  const outcome = await mockInvoke<SessionOutcome>(command, {
    request: { requestId: crypto.randomUUID(), sources: [from], destDir },
    events: () => {},
  });
  const item = outcome.result.items[0];
  if (item?.status !== "succeeded" || !item.receipt) return item?.error ?? "failed";
  if (basename(item.receipt.path) !== basename(to)) {
    await mockInvoke("rename_entry", { path: item.receipt.path, newName: basename(to) });
  }
  return null;
}

export const mockShellFs: ShellFs = {
  stat(path) {
    if (path === "/") return { name: "/", path: "/", dir: true, size: 0, modified: new Date().toISOString() };
    const entry = mockFiles[parentDir(path)]?.find((e) => e.path === path);
    return entry ? toShellEntry(entry) : null;
  },
  list: (dir) => mockFiles[dir]?.map(toShellEntry) ?? null,
  read: (path) => mockWrittenFiles[path] ?? mockFileContent[path] ?? null,
  mkdir: (path) => attempt([parentDir(path)], async () => {
    await mockInvoke("create_directory", { parentPath: parentDir(path), name: basename(path) });
    stampNow(path);
    return null;
  }),
  touch: (path) => attempt([parentDir(path)], async () => {
    await mockInvoke("create_empty_file", { parentPath: parentDir(path), name: basename(path) });
    mockFileContent[path] = "";
    stampNow(path);
    return null;
  }),
  write: (path, text) => attempt([parentDir(path)], async () => {
    await mockInvoke("write_text_file", { path, content: text });
    stampNow(path);
    return null;
  }),
  move: (from, to) => attempt([parentDir(from), parentDir(to)], () => relocate("move_entries", from, to)),
  copy: (from, to) => attempt([parentDir(to)], () => relocate("copy_entries", from, to)),
  trash: (path) => attempt([parentDir(path), "trash://"], async () => {
    const outcome = await mockInvoke<{ result: { failed: Array<{ error: string }> } }>("delete_entries", { paths: [path], permanent: false });
    return outcome.result.failed[0]?.error ?? null;
  }),
};

export interface DemoTerminalIdentity {
  user: string;
  host: string;
  home: string;
}

/** Serve every terminal the app spawns from a demo shell session. */
export function installDemoTerminal(identity: () => DemoTerminalIdentity): void {
  const sessions = new Map<number, DemoShellSession>();
  setMockTerminalBackend({
    spawn(id, cwd, cols) {
      const { user, host, home } = identity();
      const start = cwd && mockShellFs.stat(cwd)?.dir ? cwd : home;
      const session = createDemoShellSession({
        env: { fs: mockShellFs, home, user, host, repoFor: fixtureRepoFor },
        cwd: start,
        columns: cols,
        now: () => Date.now(),
        write: (text) => emitMockTerminal("output", id, text),
        cwdChanged: (next) => emitMockTerminal("cwd", id, next),
      });
      sessions.set(id, session);
      session.start();
    },
    write: (id, data) => sessions.get(id)?.input(data),
    resize: (id, cols) => sessions.get(id)?.resize(cols),
    kill: (id) => { sessions.delete(id); },
    status: (id) => sessions.get(id)?.status() ?? { busy: false, cwd: null },
  });
}
