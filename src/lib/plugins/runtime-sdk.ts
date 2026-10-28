/** Runtime bindings for precompiled external components; one Svelte instance. */
import * as svelte from "svelte";
import * as client from "svelte/internal/client";
import Modal from "$lib/components/Modal.svelte";
import ImageEditor from "$lib/components/ImageCropEditor.svelte";
import FileTiles from "$lib/components/FileTiles.svelte";
import FileTile from "$lib/components/FileTile.svelte";
import { tileGridMetrics } from "$lib/domain/tile-layout";
import { getThumbnailData } from "$lib/api/thumbnails";
import { invoke } from "$lib/api/common";

export const SVELTE_ABI="5.56.3";
export function exposePluginSDK():void {
  const target=globalThis as typeof globalThis & {__TAURI_EXPLORER_PLUGIN_SDK__?:unknown};
  if (target.__TAURI_EXPLORER_PLUGIN_SDK__) return;
  Object.defineProperty(target,"__TAURI_EXPLORER_PLUGIN_SDK__",{value:Object.freeze({
    // sdkVersion stays 1: SDK 1 packages require exactly that value. Newer
    // capabilities are announced through apiVersion and the capability list.
    // Capability "paneDialogs": lifetime-bound workspace.capturePane handles,
    // pane-scoped openDialog/presentation.openDialog and shared ui/modal behavior.
    // "fileDropTargets": workspace element registration, host hover feedback,
    // ordered paths from verified Explorer drags and Tauri-native OS drops.
    // Only elements inside the calling plugin's mounted contributions/dialogs
    // may register; host chrome and other plugins' DOM throw before registration.
    // "selectionAnchor": FileViewPane.setSelection(paths, focus, { keepAnchor: true }).
    // "fileViewEligibilityPending": reactive available(directory): boolean | "pending".
    // "entryLineage": registerEntryLineage (lineage peek: Details/List/Tiles group
    // a file's edits under it) and workspace.toggleEntryLineage/isEntryLineageShown.
    sdkVersion:1,apiVersion:3,capabilities:Object.freeze(["fileViews","previewInfo","previewTargets","blobWorkers","fileTiles","fileTile","tileSize","jobRetry","jobReveal","jobCost","fileViewReveal","textGeneration","pluginServices","serviceArtifacts","settingsActions","modalNavigation","combinedSelection","paneDialogs","fileDropTargets","selectionAnchor","fileViewEligibilityPending","entryLineage"]),svelteVersion:SVELTE_ABI,
    modules:Object.freeze({"svelte":svelte,"svelte/internal/client":client,"ui/modal":{default:Modal},"ui/image-editor":{default:ImageEditor},
      // Built-in Tiles view tiles (FileTilesProps in api.ts); capability "fileTiles".
      // Capability "tileSize": FileViewPane.tileSize and file-tiles' `size` prop.
      // Capability "jobRetry": PluginJobs.accept registrations may carry `retry`.
      "ui/file-tiles":{default:FileTiles},
      // One gridcell plus pure preset metrics; the plugin owns its grid/rows.
      "ui/file-tile":{default:FileTile,tileGridMetrics}}),
    thumbnailData:getThumbnailData,
    pickSaveFile:(options:{directory:string;filename:string;title:string})=>invoke<string|null>("pick_file",{options:{mode:"save",...options}}),
  }),writable:false,configurable:false});
}
