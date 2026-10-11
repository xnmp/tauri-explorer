import { getDropSourcePaths, handleFileDropMany, type DropOptions } from "$lib/state/drop-operations";
import { dragState } from "$lib/state/drag.svelte";
import { isCopyModifier } from "$lib/domain/platform";
import { isInsideDir, parentDir, samePath } from "$lib/domain/path";
import { isFileTransfer } from "$lib/domain/file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";

export type DirectoryDropKind = "folder" | "breadcrumb" | "tab" | "listing-background" | "miller-background";

/** Importable DOM destination seam; components retain only hover/render state. */
export async function dropIntoDirectory(event: DragEvent, path: string, kind: DirectoryDropKind, options: DropOptions): Promise<void> {
  if (!isFileTransfer(event.dataTransfer) || !event.dataTransfer) return;
  if (resolveDropTargetFromElement(event.target as Element | null)?.type === "blocked") return;
  const paths = getDropSourcePaths(event.dataTransfer);
  if (!paths.length) return;
  event.preventDefault();
  const valid = paths.filter(source => (kind === "listing-background" || !isInsideDir(path, source))
    && (!(kind === "tab" || kind === "listing-background") || !samePath(parentDir(source), path)));
  const copy = kind !== "breadcrumb" && kind !== "listing-background" && isCopyModifier(event);
  if (kind !== "breadcrumb") dragState.clear(event.dataTransfer);
  await handleFileDropMany(valid, path, copy, options);
}
