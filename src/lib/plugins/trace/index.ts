import type { Plugin } from "../api";
import { isImageFile, isSvgFile } from "$lib/domain/file-types";
import { isVirtualPath } from "$lib/domain/virtual-path";
import TraceInspector from "./TraceInspector.svelte";
import { traceInvalidation } from "./invalidation.svelte";

export const tracePlugin: Plugin = {
  id: "trace",
  name: "Trace",
  description: "Read-only provenance for image edits recorded by Tauri Explorer.",
  enabledByDefault: true,
  activate(ctx) {
    ctx.registerInspector({
      id: "trace.lineage",
      title: "Trace",
      component: TraceInspector,
      when: (entries) => entries.length === 1 && !isVirtualPath(entries[0].path)
        && (isImageFile(entries[0]) || isSvgFile(entries[0])),
    });
    ctx.events.listen<string>("trace:changed", () => traceInvalidation.bump());
  },
};
