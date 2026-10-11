import { getDropSourcePaths, handleFileDropMany, type DropOptions } from "$lib/state/drop-operations";
import { dragState } from "$lib/state/drag.svelte";
import { isCopyModifier, isWindows } from "$lib/domain/platform";
import { pathComparison } from "$lib/domain/path";
import { isFileTransfer, isLinkOnlyFileTransfer } from "$lib/domain/file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";

export type DirectoryDropKind = "folder" | "breadcrumb" | "tab" | "listing-background" | "miller-background";
const pathsForPlatform = pathComparison(isWindows);

/** Importable DOM destination seam; components retain only hover/render state. */
export async function dropIntoDirectory(event: DragEvent, path: string, kind: DirectoryDropKind, options: DropOptions): Promise<void> {
  if (!isFileTransfer(event.dataTransfer) || !event.dataTransfer) return;
  if (isLinkOnlyFileTransfer(event.dataTransfer, dragState.domSource(event.dataTransfer)) || pathsForPlatform.key(path) === null) return;
  if (resolveDropTargetFromElement(event.target as Element | null)?.type === "blocked") return;
  const paths = getDropSourcePaths(event.dataTransfer);
  if (!paths.length) return;
  event.preventDefault();
  const valid = paths.filter(source => (kind === "listing-background" || !pathsForPlatform.contains(path, source))
    && (!(kind === "tab" || kind === "listing-background") || !pathsForPlatform.sameParent(source, path)));
  const copy = kind !== "breadcrumb" && kind !== "listing-background" && isCopyModifier(event);
  if (kind !== "breadcrumb") dragState.clear(event.dataTransfer);
  await handleFileDropMany(valid, path, copy, options);
}
