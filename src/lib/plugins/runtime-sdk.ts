/** Runtime bindings for precompiled external components; one Svelte instance. */
import * as svelte from "svelte";
import * as client from "svelte/internal/client";
import Modal from "$lib/components/Modal.svelte";
import ImageEditor from "$lib/components/ImageCropEditor.svelte";
import { getThumbnailData } from "$lib/api/thumbnails";
import { invoke } from "$lib/api/common";

export const SVELTE_ABI="5.56.3";
export function exposePluginSDK():void {
  const target=globalThis as typeof globalThis & {__TAURI_EXPLORER_PLUGIN_SDK__?:unknown};
  if (target.__TAURI_EXPLORER_PLUGIN_SDK__) return;
  Object.defineProperty(target,"__TAURI_EXPLORER_PLUGIN_SDK__",{value:Object.freeze({
    sdkVersion:1,svelteVersion:SVELTE_ABI,
    modules:Object.freeze({"svelte":svelte,"svelte/internal/client":client,"ui/modal":{default:Modal},"ui/image-editor":{default:ImageEditor}}),
    thumbnailData:getThumbnailData,
    pickSaveFile:(options:{directory:string;filename:string;title:string})=>invoke<string|null>("pick_file",{options:{mode:"save",...options}}),
  }),writable:false,configurable:false});
}
