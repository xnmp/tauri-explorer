/** Runtime bindings for precompiled external components; one Svelte instance. */
import * as svelte from "svelte";
import * as client from "svelte/internal/client";
import Modal from "$lib/components/Modal.svelte";
import ImageEditor from "$lib/components/ImageCropEditor.svelte";
import FileTiles from "$lib/components/FileTiles.svelte";
import { getThumbnailData } from "$lib/api/thumbnails";
import { invoke } from "$lib/api/common";

export const SVELTE_ABI="5.56.3";
export function exposePluginSDK():void {
  const target=globalThis as typeof globalThis & {__TAURI_EXPLORER_PLUGIN_SDK__?:unknown};
  if (target.__TAURI_EXPLORER_PLUGIN_SDK__) return;
  Object.defineProperty(target,"__TAURI_EXPLORER_PLUGIN_SDK__",{value:Object.freeze({
    // sdkVersion stays 1: SDK 1 packages require exactly that value. Newer
    // capabilities are announced through apiVersion and the capability list.
    sdkVersion:1,apiVersion:2,capabilities:Object.freeze(["fileViews","previewInfo","previewTargets","blobWorkers","fileTiles","tileSize"]),svelteVersion:SVELTE_ABI,
    modules:Object.freeze({"svelte":svelte,"svelte/internal/client":client,"ui/modal":{default:Modal},"ui/image-editor":{default:ImageEditor},
      // Built-in Tiles view tiles (props in FileTiles.svelte); capability "fileTiles".
      // Capability "tileSize": FileViewPane.tileSize and file-tiles' `size` prop.
      "ui/file-tiles":{default:FileTiles}}),
    thumbnailData:getThumbnailData,
    pickSaveFile:(options:{directory:string;filename:string;title:string})=>invoke<string|null>("pick_file",{options:{mode:"save",...options}}),
  }),writable:false,configurable:false});
}
