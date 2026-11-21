/**
 * AI Columns plugin (#1884): Details columns that the configured language
 * model fills in from a plain-language description ("document language",
 * "is this an invoice?").
 *
 * Contributions, all through the plugin context:
 *   - Details column-header menu items: "Add AI column…" and one
 *     "Remove AI column: <label>" per column (`registerDetailColumnMenuItem`)
 *   - one Details-column provider per AI column (`registerDetailColumns`),
 *     which loads only rendered rows, 16 per request, two requests in flight
 *   - the describe dialog
 *
 * PRIVACY: a file's metadata, and for small text-like files the first 2,048
 * characters, are sent only while one of its AI columns is shown for a
 * rendered row. Binary and image content is never read.
 *
 * Direct import justification: the shared text service (`api/ai-text.ts`)
 * is the AI filter's backend; `ctx.text` exposes only its settings, not
 * generation, and built-in plugins may call it directly.
 */
import type { Plugin } from "../api";
import { cancelText, describeText, generateText } from "$lib/api/ai-text";
import { readTextFile } from "$lib/api/files";
import { buildContentHint, canSendContentHint } from "$lib/domain/ai-rename";
import type { AiColumnDefinition } from "$lib/domain/ai-column";
import type { FileEntry } from "$lib/domain/file";
import { AI_COLUMN_VALUE_KEY, aiColumnApplies, createColumnLoader, createOnceReporter } from "./column-loader";
import { createAiColumnStore } from "./column-store";
import AiColumnDialog from "./AiColumnDialog.svelte";

const PLUGIN_ID = "ai-columns";
const DIALOG_ID = "ai-columns.describe";
/** `read_text_file` refuses larger files outright, so larger text files go without an excerpt. */
const EXCERPT_READ_LIMIT = 32 * 1024;

async function readExcerpt(entry: FileEntry): Promise<string | undefined> {
  if (!canSendContentHint(entry) || entry.size > EXCERPT_READ_LIMIT) return undefined;
  const result = await readTextFile(entry.path, EXCERPT_READ_LIMIT);
  return result.ok ? buildContentHint(entry, result.data) : undefined;
}

let flushOnDeactivate: (() => Promise<void>) | null = null;

export const aiColumnsPlugin: Plugin = {
  id: PLUGIN_ID,
  name: "AI Columns",
  description:
    "Details columns filled in by your language model: right-click a column header, choose Add AI column… and describe what to show. Sends file names, sizes and dates, and the start of small text files, only for rows on screen.",
  enabledByDefault: true,

  async activate(ctx) {
    if (!ctx.registerDetailColumns || !ctx.registerDetailColumnMenuItem) return;
    const registerColumns = ctx.registerDetailColumns.bind(ctx);
    const registerMenuItem = ctx.registerDetailColumnMenuItem.bind(ctx);
    const store = createAiColumnStore(ctx.storage);
    await store.load();
    flushOnDeactivate = () => store.flush();
    const reportOnce = createOnceReporter((message) => ctx.toast.error(message));
    const providers = new Map<string, () => void>();
    const removeItems = new Map<string, () => void>();

    const mountProvider = (column: AiColumnDefinition) => {
      const load = createColumnLoader(column, {
        generateText,
        cancelText,
        readExcerpt,
        lookup: (key) => store.lookup(column.id, key),
        store: (pairs) => store.store(column.id, pairs),
        report: (message) => reportOnce(column.id, message),
        nextRequestId: () => `ai-column-${crypto.randomUUID()}`,
      });
      providers.set(column.id, registerColumns({
        id: `${PLUGIN_ID}.${column.id}`,
        columns: [{ key: AI_COLUMN_VALUE_KEY, label: column.label, width: 200 }],
        applies: aiColumnApplies,
        // Never bill the model for the Length column or the Length sort.
        suppliesLength: false,
        load,
      }));
    };

    const remove = (id: string) => {
      providers.get(id)?.();
      providers.delete(id);
      removeItems.get(id)?.();
      removeItems.delete(id);
      store.remove(id);
    };

    const mount = (column: AiColumnDefinition) => {
      mountProvider(column);
      removeItems.set(column.id, registerMenuItem({
        id: `${PLUGIN_ID}.remove-${column.id}`,
        label: `Remove AI column: ${column.label}`,
        run: () => remove(column.id),
      }));
    };

    const add = (description: string) => {
      const column = store.add(description);
      if (column) mount(column);
      else ctx.toast.show("No room for another AI column; remove one first", "info");
    };

    registerMenuItem({
      id: `${PLUGIN_ID}.add`,
      label: "Add AI column…",
      run: () => {
        void describeText()
          .then((description) => description.available)
          .catch(() => false)
          .then((available) => {
            if (available) ctx.openDialog(DIALOG_ID, { onSubmit: add });
            else {
              ctx.toast.show("Set up a language model to add AI columns", "info");
              (ctx.text?.openSettings ?? ctx.openSettings)();
            }
          });
      },
    });
    ctx.registerDialog({ id: DIALOG_ID, component: AiColumnDialog });

    for (const column of store.columns) mount(column);

    // Cells that failed (no model, timeout) stay empty for the session;
    // re-registering after a settings change retries them. Cached answers
    // come back from the store without a new request.
    ctx.text?.subscribe(() => {
      for (const column of store.columns) {
        providers.get(column.id)?.();
        mountProvider(column);
      }
    });
  },

  deactivate() {
    void flushOnDeactivate?.();
    flushOnDeactivate = null;
  },
};
