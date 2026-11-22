/**
 * AI Columns plugin (#1886): Details columns a folder agent fills in from a
 * plain-language description ("invoice date", "is this an invoice?"), one
 * read-only `ctx.agent` job per folder. This shell is all that is in the
 * startup bundle; the implementation (`activate.ts`, the loader, store and
 * dialog) loads with activation.
 */
import type { Plugin } from "../api";

let teardown: (() => Promise<void>) | null = null;
let generation = 0;

export const aiColumnsPlugin: Plugin = {
  id: "ai-columns",
  name: "AI Columns",
  description:
    "Details columns filled in by a folder agent: right-click a column header, choose Add AI column… and describe what to show. A Claude Code or Codex connection reads only the files it needs, read-only, in the folder you are viewing.",
  enabledByDefault: true,

  async activate(ctx) {
    if (!ctx.agent || !ctx.registerDetailColumns || !ctx.registerDetailColumnMenuItem) return;
    const current = ++generation;
    const { activateAiColumns } = await import("./activate");
    const done = await activateAiColumns(ctx);
    // Deactivated while loading: the context's contributions are already gone.
    if (current !== generation) void done();
    else teardown = done;
  },

  deactivate() {
    generation++;
    void teardown?.();
    teardown = null;
  },
};
