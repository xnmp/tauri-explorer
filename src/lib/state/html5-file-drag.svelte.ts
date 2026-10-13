import { html5DragUriList, html5DragHtml } from "$lib/domain/file-drop";
import { dragState, type DragData } from "./drag.svelte";
import { dragClock } from "./drag-clock";
import { isTauri } from "$lib/api/common";
import { isMac, isWindows } from "$lib/domain/platform";
import { startExternalDrag } from "$lib/composables/use-external-drag.svelte";

/** Listings/Miller can export files and hand off to native on Linux. Recent
 * retains private Explorer link authority without an OS filesystem payload. */
export function createHtml5FileDrag(onEnd: () => void = () => {}, copyPolicy: "modifier" | "move" | "link" = "modifier") {
  let source: DragData | null = null;

  function start(event: DragEvent, data: DragData, decorate?: () => void): void {
    if (!event.dataTransfer) return;
    // DataTransfer is synchronous: do not launch an uncorrelated HTML5 source
    // while the renderer is still acquiring the native monotonic clock.
    if (!dragClock.ready) { event.preventDefault(); return; }
    const paths = data.paths ? [...data.paths] : [data.path];
    event.dataTransfer.setData("application/x-explorer-path", data.path);
    event.dataTransfer.setData("application/x-explorer-name", data.name);
    event.dataTransfer.setData("application/x-explorer-kind", data.kind);
    if (paths.length > 1) event.dataTransfer.setData("application/x-explorer-paths", JSON.stringify(paths));
    event.dataTransfer.effectAllowed = copyPolicy === "link" ? "link" : "all";
    event.dataTransfer.setData("application/x-explorer-effect", copyPolicy === "link" ? "link" : "all");
    dragState.start({ ...data, paths: paths.length > 1 ? paths : undefined,
      nativeCopyPolicy: copyPolicy, html5: true });
    source = dragState.current;
    event.dataTransfer.setData("text/uri-list", html5DragUriList(source!));
    event.dataTransfer.setData("text/html", html5DragHtml(source!));
    dragState.bindDomSource(event.dataTransfer, source!);
    event.dataTransfer.setData("application/x-explorer-session", source!.sessionId!);
    event.dataTransfer.setData("application/x-explorer-sequence", String(source!.gestureSequence));
    decorate?.();
    if (copyPolicy !== "link" && !isMac && !isWindows && isTauri()) void startExternalDrag(paths);
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
