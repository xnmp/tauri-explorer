import { dragState, type DragData } from "./drag.svelte";
import { isTauri } from "$lib/api/common";
import { isMac, isWindows } from "$lib/domain/platform";
import { startExternalDrag } from "$lib/composables/use-external-drag.svelte";

/** One HTML5 source protocol for listings, Miller columns and Recent. Linux
 * app gestures hand off to native; browser gestures retain DOM authority. */
export function createHtml5FileDrag(onEnd: () => void = () => {}, copyPolicy: "modifier" | "move" = "modifier") {
  let source: DragData | null = null;

  function start(event: DragEvent, data: DragData, decorate?: () => void): void {
    if (!event.dataTransfer) return;
    const paths = data.paths ? [...data.paths] : [data.path];
    event.dataTransfer.setData("application/x-explorer-path", data.path);
    event.dataTransfer.setData("application/x-explorer-name", data.name);
    event.dataTransfer.setData("application/x-explorer-kind", data.kind);
    if (paths.length > 1) event.dataTransfer.setData("application/x-explorer-paths", JSON.stringify(paths));
    event.dataTransfer.setData("text/uri-list", paths.map(path => "file://" + encodeURI(path)).join("\r\n"));
    event.dataTransfer.effectAllowed = "all";
    dragState.start({ ...data, paths: paths.length > 1 ? paths : undefined,
      nativeCopyPolicy: copyPolicy, html5: true });
    source = dragState.current;
    dragState.bindDomSource(event.dataTransfer, source!);
    event.dataTransfer.setData("application/x-explorer-session", source!.sessionId!);
    event.dataTransfer.setData("application/x-explorer-observed-at", String(source!.html5StartedAt));
    decorate?.();
    if (!isMac && !isWindows && isTauri()) void startExternalDrag(paths);
  }

  function end(): void {
    // Native result owns retirement after handoff. DOM dragend may precede
    // delivery of native Enter/Drop on a separate IPC channel.
    dragState.endHtml5(source);
    dragState.finish(source);
    source = null;
    onEnd();
  }

  return { start, end };
}
