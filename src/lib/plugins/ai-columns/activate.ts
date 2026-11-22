/**
 * AI Columns activation (#1886), loaded lazily by `index.ts` so none of it
 * reaches the startup bundle.
 *
 * Contributions, all through the plugin context:
 *   - Details column-header menu items (`registerDetailColumnMenuItem`):
 *     "Add AI column…", "Refresh AI columns in this folder" and one
 *     "Remove AI column: <label>" per column
 *   - one Details-column provider per AI column (`registerDetailColumns`,
 *     `suppliesLength: false`), disposed on removal or refresh
 *   - palette commands (`registerCommand`): add, refresh, and one remove per
 *     column whose disposer runs when the column goes
 *   - the describe dialog
 *
 * Values come from one `ctx.agent` folder job per folder and column (see
 * `column-loader.ts`) and are cached per file (path + size + mtime) in plugin
 * storage.
 *
 * PRIVACY: the agent's provider sees the column's description, the names in
 * the folder and whatever files the agent chooses to read there (read-only,
 * confined to the folder; docs/shared-ai-services-contracts.md § Folder
 * agent). A job starts only while an AI column is shown for a rendered row.
 *
 * Direct import justification: `api/files.ts` `fetchDirectory` lists the
 * folder so one job can answer for every file, not only the rendered rows.
 */
import type { PluginContext } from "../api";
import { fetchDirectory } from "$lib/api/files";
import type { AiColumnDefinition } from "$lib/domain/ai-column";
import { parentDir, sameDirectory } from "$lib/domain/path";
import { AI_COLUMN_VALUE_KEY, aiColumnApplies, createColumnLoader, createOnceReporter, type AiColumnLoader } from "./column-loader";
import { createAiColumnStore } from "./column-store";
import AiColumnDialog from "./AiColumnDialog.svelte";

export const PLUGIN_ID = "ai-columns";
const DIALOG_ID = "ai-columns.describe";
const COMMAND_PREFIX = `plugin.${PLUGIN_ID}`;

/** Visible names of a folder: dot-files are asked about only when a row shows one. */
async function listFolder(folder: string) {
  const result = await fetchDirectory(folder);
  return result.ok ? result.data.entries.filter((entry) => !entry.name.startsWith(".")) : null;
}

interface Mounted {
  column: AiColumnDefinition;
  loader: AiColumnLoader;
  /** The provider's registration; replaced on refresh so rendered rows reload. */
  provider: () => void;
  /** Menu item and palette command for removal. */
  removers: (() => void)[];
}

/** Activates the plugin; resolves to its teardown (run on deactivate). */
export async function activateAiColumns(ctx: PluginContext): Promise<() => Promise<void>> {
  const agent = ctx.agent!;
  const registerColumns = ctx.registerDetailColumns!.bind(ctx);
  const registerMenuItem = ctx.registerDetailColumnMenuItem!.bind(ctx);
  // Bound below, once `mount` exists: another window took this column's id.
  let onRename = (_from: AiColumnDefinition, _to: AiColumnDefinition) => {};
  const store = createAiColumnStore(ctx.storage, { onRename: (from, to) => onRename(from, to) });
  await store.load();
  const reportOnce = createOnceReporter((message) => ctx.toast.error(message));
  const mounted = new Map<string, Mounted>();

  const registerProvider = (column: AiColumnDefinition, loader: AiColumnLoader) => registerColumns({
    id: `${PLUGIN_ID}.${column.id}`,
    columns: [{ key: AI_COLUMN_VALUE_KEY, label: column.label, width: 200 }],
    applies: aiColumnApplies,
    // Never run the agent for the Length column or the Length sort.
    suppliesLength: false,
    load: (entries, signal) => loader.load(entries, signal),
  });

  const remountProvider = (item: Mounted) => {
    item.provider();
    item.provider = registerProvider(item.column, item.loader);
  };

  const unmount = (id: string): boolean => {
    const item = mounted.get(id);
    if (!item) return false;
    mounted.delete(id);
    item.loader.dispose();
    item.provider();
    for (const dispose of item.removers) dispose();
    reportOnce.reset(id);
    return true;
  };

  const remove = (id: string) => { if (unmount(id)) store.remove(id); };

  const mount = (column: AiColumnDefinition) => {
    const loader = createColumnLoader(column, {
      runAgent: (request, signal) => agent.run(request, signal),
      listFolder,
      lookup: (key) => store.lookup(column.id, key),
      store: (pairs) => store.store(column.id, pairs),
      report: (message) => reportOnce(column.id, message),
    });
    const item: Mounted = { column, loader, provider: registerProvider(column, loader), removers: [] };
    const label = `Remove AI column: ${column.label}`;
    item.removers.push(
      registerMenuItem({ id: `${PLUGIN_ID}.remove-${column.id}`, label, run: () => remove(column.id) }),
      ctx.registerCommand({
        scope: "window",
        id: `${COMMAND_PREFIX}.remove-${column.id}`,
        label: `AI Columns: ${label}`,
        category: "plugins",
        handler: () => remove(column.id),
      }),
    );
    mounted.set(column.id, item);
  };

  const add = (description: string) => {
    const column = store.add(description);
    if (column) mount(column);
    else ctx.toast.show("No room for another AI column; remove one first", "info");
  };

  const openAdd = async () => {
    const available = await agent.describe().then((description) => description.available).catch(() => false);
    if (available) ctx.openDialog(DIALOG_ID, { onSubmit: add });
    else {
      ctx.toast.show("AI columns need a Claude Code or Codex connection", "info");
      (ctx.text?.openSettings ?? ctx.openSettings)();
    }
  };

  /** Rerun every column's job for the active folder, ignoring cached values. */
  const refresh = () => {
    const folder = ctx.workspace.getCurrentDirectory?.() ?? null;
    if (!folder) { ctx.toast.show("Open a folder to refresh its AI columns", "info"); return; }
    for (const item of mounted.values()) {
      store.dropPaths(item.column.id, (path) => sameDirectory(parentDir(path), folder));
      item.loader.forget(folder);
      reportOnce.reset(item.column.id);
      remountProvider(item);
    }
  };

  registerMenuItem({ id: `${PLUGIN_ID}.add`, label: "Add AI column…", run: () => void openAdd() });
  registerMenuItem({
    id: `${PLUGIN_ID}.refresh`,
    label: "Refresh AI columns in this folder",
    run: refresh,
    enabled: () => mounted.size > 0,
  });
  ctx.registerCommand({ scope: "window", id: `${COMMAND_PREFIX}.add`, label: "AI Columns: Add AI Column…", category: "plugins", handler: openAdd });
  ctx.registerCommand({
    scope: "pane",
    id: `${COMMAND_PREFIX}.refresh`,
    label: "AI Columns: Refresh AI Columns in This Folder",
    category: "plugins",
    when: () => mounted.size > 0,
    handler: refresh,
  });
  ctx.registerDialog({ id: DIALOG_ID, component: AiColumnDialog });

  onRename = (from, to) => { if (unmount(from.id)) mount(to); };

  for (const column of store.columns) mount(column);

  // A changed connection may answer where the old one failed: forget the
  // session's settled folders (cached answers stay) and reload rendered rows.
  ctx.text?.subscribe(() => {
    reportOnce.reset();
    for (const item of mounted.values()) {
      item.loader.forget();
      remountProvider(item);
    }
  });

  return async () => {
    for (const item of mounted.values()) item.loader.dispose();
    mounted.clear();
    await store.flush();
  };
}
