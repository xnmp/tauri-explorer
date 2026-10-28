/**
 * Plugin API surface.
 *
 * Loading model — decided by CSP. `script-src 'self'` (tauri.conf.json) rules
 * out runtime-loaded plugin JS. Plugins are therefore build-time-bundled
 * modules statically imported into the registry, with runtime enable/disable.
 * See the Plugins cluster in docs/code-map/map-feature.md.
 *
 * A plugin declares `activate(ctx)` and (optionally) `deactivate()`. Every
 * contribution made through the context is tracked and disposed automatically
 * when the plugin deactivates, so toggling a plugin off cleanly unregisters
 * everything it added — commands, context-menu items, settings sections, fs
 * providers and event listeners.
 */

import { selectWorkspaceFile } from "$lib/domain/job-reveal";
import { imageEditorRegistry, type ImageEditorTool } from "./image-editor-registry.svelte";
import type { Command } from "$lib/state/commands.svelte";
import { registerCommandContribution } from "$lib/state/commands.svelte";
import { contextMenuItems, type ContextMenuItem } from "$lib/state/context-menu-items.svelte";
import { registerFsProvider, type FsProvider } from "./fs-providers";
import { pluginSettingsSections } from "./settings-registry.svelte";
import { dialogRegistry, type DialogDescriptor } from "./dialog-registry.svelte";
import { inspectorRegistry, type InspectorContribution } from "./inspector-registry.svelte";
import { fileViewRegistry, type FileViewContribution } from "./file-view-registry.svelte";
/** Capability "selectionAnchor": FileViewPane.setSelection accepts
 * `{ keepAnchor: true }` to replace selection without moving the range anchor or cursor. */
export type { FileViewPane, FileViewContribution, FileViewEligibility } from "./file-view-registry.svelte";
import { entryLineageRegistry, type EntryLineageContribution } from "./entry-lineage-registry.svelte";
export type { EntryLineageContribution, EntryLineage, LineageParent } from "./entry-lineage-registry.svelte";
import { previewInfoRegistry, type PreviewInfoContribution } from "./preview-registry.svelte";
import { toastStore, type ToastType } from "$lib/state/toast.svelte";
import { readConfigFile } from "$lib/api/config";
import { writeConfigQueued } from "$lib/state/persisted";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { FileEntry } from "$lib/domain/file";
import { basename, parentDir, sameDirectory } from "$lib/domain/path";
import { imageEditorRequestError } from "$lib/domain/plugin-image-editor";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { scopePluginJobs, type PluginJobKind } from "$lib/state/plugin-jobs";
import { observeActiveDirectory } from "$lib/composables/observe-active-directory.svelte";
import { extractError, type ApiResult } from "$lib/api/common";
import { logFrontendError } from "$lib/api/crash";
import { subscribeToLocalFileChanges } from "$lib/state/file-events";
import { fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import PluginContributionRoot from "$lib/components/PluginContributionRoot.svelte";
import { pluginDomOwnership } from "$lib/state/plugin-dom-ownership";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";

dialogRegistry.connectPanes(() => windowTabsManager.paneDialogs);

export type { PaneTileSize, TileSizePreset, TileGridMetrics } from "$lib/domain/tile-layout";
import type { TileSizePreset, TileGridMetrics } from "$lib/domain/tile-layout";
import type { Component } from "svelte";

/** `ui/file-tile` (capability "fileTile"). Renders one `role="gridcell"`;
 * the plugin supplies grid/row roles and owns keyboard navigation/selection.
 * Host clipboard, hidden/empty-folder styling and pane-owned inline rename
 * are reactive. No host drag/drop wiring: `ui/file-tiles` exposes none either.
 */
export interface FileTileProps {
  entry: FileEntry;
  selected: boolean;
  /** Roving tab stop (0 when true, otherwise -1); does not move DOM focus. */
  focused?: boolean;
  /** Optional one-based column index, supplied by the plugin's layout. */
  column?: number;
  /** DOM focus notification; plugins may update their roving tab stop. */
  onfocus?: (event: FocusEvent) => void;
  /** Keyboard events are forwarded unchanged; the plugin owns navigation. */
  onkeydown?: (event: KeyboardEvent) => void;
  /** Optional remembered video-thumbnail failure; keeps the plain file icon. */
  videoUnavailable?: boolean;
  /** Allows a virtualized plugin grid to retain failed-video fallback by path. */
  onvideounavailable?: (entry: FileEntry) => void;
  /** Explicit preset, else enclosing pane's folder size, else global setting.
   * Unknown values fall through like an omitted preset. */
  size?: TileSizePreset;
  /** Receives the original mouse event, including selection modifiers. */
  onselect: (entry: FileEntry, event: MouseEvent) => void;
  /** Double-click. Keyboard activation belongs to the plugin's grid. */
  onopen: (entry: FileEntry) => void;
  /** Receives the original event after preventDefault(). */
  onmenu: (entry: FileEntry, event: MouseEvent) => void;
}

/** `ui/file-tiles` (capability "fileTiles"). Owns a non-virtualized grid,
 * roving focus, arrows/Home/End and Enter activation. */
export interface FileTilesProps {
  entries: readonly FileEntry[];
  /** Replace a plain Set to update selection, or use a reactive Set. */
  selected: ReadonlySet<string>;
  onselect: FileTileProps["onselect"];
  onopen: FileTileProps["onopen"];
  onmenu: FileTileProps["onmenu"];
  /** Accessible grid name; defaults to "Files". */
  label?: string;
  /** Same explicit/pane/global resolution as `FileTileProps.size`. */
  size?: TileSizePreset;
}

/** Shape of `sdk.modules["ui/file-tile"]`; detect `"fileTile"` capability. */
export interface FileTileModule {
  readonly default: Component<FileTileProps>;
  /** Omitted/unknown preset: medium. CSS px, before host zoom. */
  readonly tileGridMetrics: (size?: TileSizePreset) => TileGridMetrics;
}

// ----- Settings descriptors -----

export type SettingRowType = "text" | "password" | "toggle" | "select";

export interface SettingRowDescriptor {
  id: string;
  label: string;
  description?: string;
  type: SettingRowType;
  /** Options for `type: "select"`. */
  options?: { value: string; label: string }[];
  /** Default value shown until (and unless) the user changes it. */
  default?: string | boolean;
}

export interface SettingsSectionDescriptor {
  id: string;
  title: string;
  rows: SettingRowDescriptor[];
  actions?: {id:string;label:string;description?:string;run:()=>void|Promise<void>}[];
}

// ----- Storage -----

/** Plugin-scoped JSON storage, persisted as `plugin.<id>.json`. */
export interface PluginStorage {
  get(): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  /** Acknowledged saves reject when native persistence fails. */
  setChecked?(value: Record<string, unknown>): Promise<void>;
  subscribe?(listener: (value: Record<string,unknown>)=>void): ()=>void;
}

/** The money one AI operation cost. */
export interface JobCost {
  /** Non-negative decimal in major units, at most 6 fractional digits, e.g. "0.045". Never a float. */
  amount: string;
  /** ISO 4217 code; "USD" today. */
  currency: string;
  /** True when computed from reported usage × a dated published rate card; false when the provider reported the charge itself. */
  estimated: boolean;
  /** Bounded (≤ 64 chars) identifier of the origin, e.g. "bfl.credits" or "ratecard:openai-images:2026-10-11". */
  source: string;
}
/** Where a finished job's output can be shown. */
export type JobReveal =
  | { kind: "file"; path: string }
  | { kind: "view"; viewId: string; directory: string; targetId: string };

/** Window-owned background jobs survive plugin activation changes. */
export interface PluginJobs {
  accept(
    registration: {
      kind: PluginJobKind; label: string; detail: string; presentation?: "image";
      /**
       * Hosts with the "jobRetry" capability show a Retry action on this job's
       * entry in Background Operations (e.g. the Image generation panel) when
       * the job fails. Calling it should start a fresh job (the plugin calls
       * `accept` again); the host then removes the failed entry. Rejections
       * or a returned `{ ok: false }` are shown as the entry's error and keep
       * it.
       */
      retry?: () => Promise<ApiResult<number>>;
    },
    start: () => Promise<ApiResult<number>>,
  ): Promise<ApiResult<number>>;
}

export interface PluginToast {
  show(message: string, variant?: ToastType): void;
  error(message: string): void;
}

export interface PluginEvents {
  /** Listen for a backend/window event; auto-disposed on deactivate. A
   *  handler that throws or rejects is reported under the plugin's name. */
  listen<T = unknown>(name: string, handler: (payload: T) => void | Promise<void>): void;
}

/** Outcome of a workspace file operation (structural subset of the shared
 *  ordered move session's result). `error === "skipped"` means a no-op,
 *  conflict skip, or user cancel — the session already toasted and recorded
 *  undo for everything else. */
export interface PluginMoveResult {
  ok: boolean;
  error?: string;
}

/** Host-issued, window-local pane handle (capability "paneDialogs"). Plugins
 *  obtain it from `workspace.capturePane`; they never construct or serialize it. */
export interface PluginDialogPane {
  readonly paneId: string;
}

/** Where a plugin dialog is shown. Omitted means a window modal. A "pane"
 *  dialog covers only the captured pane; other panes stay usable. */
export type PluginDialogOptions = (
  | { readonly scope: "window" }
  | { readonly scope: "pane"; readonly pane: PluginDialogPane }
) & {
  /** Capture before awaiting work to retain the requesting modal's lifetime,
   *  independently of the destination. Pane handles also retain their caller. */
  readonly caller?: PluginDialogPane;
};

/** "pane": a verified drag from an explorer pane. "external": paths Tauri
 *  delivered from another application. */
export type PluginFileDropSource = "pane" | "external";

export type PluginFileDropHandler = (paths: readonly string[], source: PluginFileDropSource) => void | Promise<void>;

export interface PluginFileDropTargetOptions {
  /** When it returns false, drops on the target are consumed without delivery. */
  readonly enabled?: () => boolean;
}

/**
 * Read/act on the active file-explorer pane. This is the seam plugins use to
 * reach the workspace — they never import the window/tab or explorer stores
 * directly, so this surface stays the single, honest list of what a plugin can
 * do to the file view.
 */
export interface PluginWorkspace {
  getCurrentDirectory?(): string | null;
  onDirectoryChanged?(handler: (path:string|null)=>void): void;
  /** Capture active pane and selection ownership for an asynchronous action. */
  captureSelection(): () => boolean;
  /** Entries selected in the active pane. Empty when nothing is selected or
   *  there is no active explorer pane. */
  getSelection(): FileEntry[];
  /** Selected entries in this window's active explorer tab: focused pane first,
   * then other panes in visual order, preserving each pane's selection order
   * and deduplicating by path. */
  getCombinedSelection?(): FileEntry[];
  /** Entries currently listed in the active pane (after sort/filter). Used to
   *  gather in-context candidates such as sibling folders. */
  getVisibleEntries(): FileEntry[];
  /** Observe completed workspace mutations, including cross-window broadcasts.
   * Auto-disposed when the plugin deactivates. External filesystem changes
   * continue to arrive through the directory watcher/selection updates. */
  onFilesChanged(handler: (directories: readonly string[]) => void | Promise<void>): void;
  /** Navigate the active pane to a path — e.g. open a plugin's virtual folder. */
  navigate(path: string): Promise<void>;
  /** Reveal and select a present file in the active explorer pane. */
  selectFile(path: string): Promise<void>;
  /** Refresh every open pane so listings reflect filesystem changes the plugin
   *  caused (a written output file, a moved entry). Silent — no loading flash. */
  refreshPanes(): Promise<void>;
  /** Move a file into a destination directory through the shared transfer flow
   *  (conflict prompt, undo, toast, cross-window broadcast, pane refresh). */
  moveFile(sourcePath: string, targetDir: string): Promise<PluginMoveResult>;
  /** SDK 2: the plugin file view chosen for the active pane, or null. */
  getFileView?(): string | null;
  /** SDK 2: show one of this plugin's file views in the active pane, or
   *  return it to its built-in view mode when the view is already chosen. */
  toggleFileView?(viewId: string): void;
  /** Capability "entryLineage": toggle "Show <title>" for one of this
   *  plugin's lineage contributions on the active pane. */
  toggleEntryLineage?(contributionId: string): void;
  /** Capability "entryLineage": whether the active pane shows that lineage. */
  isEntryLineageShown?(contributionId: string): boolean;
  /** Capability "paneDialogs": capture a pane of this window's active explorer
   *  tab (the active pane when paneId is omitted) for a pane-scoped dialog.
   *  The handle stays valid for the pane's lifetime, across selection and
   *  focus changes; null when there is no such pane. It also captures the
   *  calling modal for managed children opened after asynchronous work. */
  capturePane?(paneId?: string): PluginDialogPane | null;
  /** Capability "fileDropTargets": deliver file paths dropped on `element`
   *  from explorer panes or other applications. The host shows the
   *  `drop-target` highlight. Returns an idempotent disposer; registrations
   *  are also disposed with the plugin. `element` must be inside this plugin's
   *  mounted contribution or dialog content; host chrome and other plugins'
   *  elements throw before registration. */
  registerFileDropTarget?(element: HTMLElement, handler: PluginFileDropHandler, options?: PluginFileDropTargetOptions): () => void;
}

/**
 * The capability surface handed to a plugin's `activate`. Plugins never call
 * `invoke` or reach into app stores directly — the common side effects route
 * through this object so they can be tracked, torn down, and audited in one
 * place: contribution registration, toasts, events, plugin storage, the
 * workspace (selection / navigation / pane refresh / moves), and opening
 * Settings.
 *
 * The one documented exception is a plugin purpose-built to extend a specific
 * core subsystem (e.g. the theme engine): it may import that subsystem's store
 * directly rather than grow this shared context with a single-consumer method.
 * Such cases carry a justification comment at the import site.
 */
export interface PluginContext {
  /** Managed navigation retains a caller's mounted modal and draft. */
  presentation?: {
    openDialog(id:string,props?:Record<string,unknown>,options?:PluginDialogOptions):Promise<import("./dialog-registry.svelte").DialogResult>;
    /** Opens the host image editor directly in one of this plugin's editor tools; settles when it closes. */
    openImageEditor?(request:{path:string;tool:string}):Promise<void>;
  };
  /** Optional host text service settings notifications; execution is backend-owned. */
  text?: {
    subscribe(listener: (revision: number) => void): () => void;
    openSettings(): void;
  };
  backend?: {invoke<T>(method:string,params?:Record<string,unknown>):Promise<T>};
  saveSettings(patch:Record<string,unknown>):Promise<void>;
  /** Return the handler's work as a promise: a rejection is reported to the
   *  user under the plugin's name and written to the app log. Work started
   *  with `void` and never returned is invisible to that reporting. */
  registerCommand(cmd: Command): void;
  registerContextMenuItem(item: ContextMenuItem): void;
  registerSettingsSection(section: SettingsSectionDescriptor): void;
  registerFsProvider(scheme: string, provider: FsProvider): void;
  /** Contribute a modal dialog component, addressable by its stable id. */
  registerDialog(descriptor: DialogDescriptor): void;
  /** Contribute a selection-aware inspector panel; removed on deactivation. */
  registerInspector(descriptor: InspectorContribution): void;
  /** Add a tool to the host image editor. Receives source, onClose and onBusyChange props. */
  registerImageEditorTool(tool: ImageEditorTool): void;
  /** SDK 2: contribute a main file view. Its component receives a pane-scoped
   *  `pane` handle. Disposal returns panes to their built-in view and clears
   *  the plugin's Preview targets. Capability "fileViewEligibilityPending":
   *  available may return "pending". */
  registerFileView?(view: FileViewContribution): void;
  /** Capability "entryLineage": supply "file X was made from P, Q" for a
   *  folder. The built-in Details, List and Tiles views group each file's
   *  lineage children under it with Folder Peek ("Show <title>", per pane,
   *  on by default where `available`). Removed on deactivation. */
  registerEntryLineage?(contribution: EntryLineageContribution): void;
  /** SDK 2: contribute a Preview-info section for files or this plugin's targets. */
  registerPreviewInfo?(section: PreviewInfoContribution): void;
  /** Open a registered dialog, passing props to its component. `open` and an
   *  `onClose` (which closes the dialog) are injected by the renderer.
   *  `options` (capability "paneDialogs") scopes it to a captured pane. */
  openDialog(id: string, props?: Record<string, unknown>, options?: PluginDialogOptions): void;
  /** Close an open dialog by id. */
  closeDialog(id: string): void;
  jobs: PluginJobs;
  toast: PluginToast;
  events: PluginEvents;
  storage: PluginStorage;
  /** Read/act on the active file-explorer pane. */
  workspace: PluginWorkspace;
  /** Open the app Settings dialog (e.g. from a "configure API key" prompt). */
  openSettings(): void;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  /** When false, the plugin ships disabled and must be turned on in Settings. */
  enabledByDefault?: boolean;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void;
}

/** Plugin-scoped storage backed by `plugin.<id>.json` via the config commands. */
export function createPluginStorage(pluginId: string): PluginStorage {
  const filename = `plugin.${pluginId}.json`;
  const listeners = new Set<(value:Record<string,unknown>)=>void>();
  let revision = 0;
  function notify(value: Record<string,unknown>) { for(const listener of listeners) { try { listener(structuredClone(value)); } catch(error) { console.error("[plugins] storage subscriber failed",error); } } }
  return {
    async get(): Promise<Record<string, unknown>> {
      const result = await readConfigFile(filename);
      if (result.ok && result.data) {
        try {
          const parsed = JSON.parse(result.data);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          // Corrupt file — treat as empty.
        }
      }
      return {};
    },
    async set(value: Record<string, unknown>): Promise<void> {
      const current = ++revision;
      const snapshot = JSON.stringify(value, null, 2);
      await writeConfigQueued(filename, snapshot);
      if (current === revision) notify(JSON.parse(snapshot));
    },
    async setChecked(value: Record<string, unknown>): Promise<void> {
      const current = ++revision;
      const snapshot = JSON.stringify(value, null, 2);
      await writeConfigQueued(filename, snapshot, filename, true);
      if (current === revision) notify(JSON.parse(snapshot));
    },
    subscribe(listener) { listeners.add(listener); return ()=>listeners.delete(listener); },
  };
}

/**
 * Build a plugin context plus a `dispose` that runs every tracked teardown.
 * Disposers run in reverse registration order.
 *
 * A plugin's command, menu action, event handler or activation that fails is
 * reported to the user under `pluginName` and written to the app log (#782,
 * #890); `reportFailure` is that report for the registry's activation path.
 * Commands still reject, so `executeCommand` reports the failure to its
 * caller; menu actions and event handlers resolve, because their callers fire
 * them without awaiting and a reported failure is not an unhandled rejection.
 * File-system provider failures are only logged: they still reject to the
 * listing caller, which already shows the error to the user.
 *
 * `order` is the plugin's position in the plugin list. Menu items and settings
 * sections are placed by it, so their order does not depend on which
 * activation happened to register first.
 */
export function createPluginContext(
  pluginId: string,
  pluginName = pluginId,
  order = Number.MAX_SAFE_INTEGER,
): {
  ctx: PluginContext;
  dispose: () => void;
  reportFailure: (error: unknown, contribution: string) => void;
} {
  const disposers = new Set<() => void>();
  let disposed = false;
  const dialogOwner = Symbol(pluginId);
  const ownedComponent = (component: Component<any>): Component<any> => {
    const contribution: Component<any> = (anchor, props) => PluginContributionRoot(anchor, { component, contribution, props });
    pluginDomOwnership.contribute(contribution, dialogOwner);
    return contribution;
  };
  const managedDialogs=new Set<()=>void>();
  // Editor tools this plugin registered; only these may be opened directly.
  const editorTools=new Set<string>();
  disposers.add(()=>{for(const close of managedDialogs)close();managedDialogs.clear();});
  disposers.add(() => dialogRegistry.closeOwner(dialogOwner));
  const track = (fn: () => void) => {
    let live = true;
    const dispose = () => {
      if (!live) return;
      live = false;
      disposers.delete(dispose);
      fn();
    };
    if (disposed) dispose();
    else disposers.add(dispose);
    return dispose;
  };
  const storage = createPluginStorage(pluginId);
  // Accepted jobs outlive the plugin, but their Retry runs its code: drop it.
  const pluginJobs = scopePluginJobs(pluginId);
  disposers.add(() => pluginJobs.retire());
  // Preview targets are pane state owned by this plugin; drop them with it.
  disposers.add(() => {
    for (const explorer of windowTabsManager.getAllExplorers()) explorer.clearPreviewTargetsOwnedBy(pluginId);
  });
  // Tauri rejects with a serialized AppError ({ kind, message }), not an Error.
  const log = (error: unknown, contribution: string): string => {
    const message = extractError(error);
    const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
    console.error(`[plugins] "${pluginId}" ${contribution} failed:`, error);
    void logFrontendError(`[plugins] "${pluginId}" ${contribution} failed: ${message}${stack}`)
      .catch(() => {});
    return message;
  };
  const report = (error: unknown, contribution: string) => {
    toastStore.error(`${pluginName}: ${log(error, contribution)}`);
  };

  const ctx: PluginContext = {
    presentation:{
      async openDialog(id,props,options) {
        try {
          if(disposed)throw new Error("Plugin caller was disposed");
          const session=dialogRegistry.openManaged(id,props,options,dialogOwner);
          if(session.ownsDialog)managedDialogs.add(session.close);
          try{return await session.result;}finally{managedDialogs.delete(session.close);}
        } catch (error) { report(error, `presentation ${id}`); throw error; }
      },
      async openImageEditor(request) {
        if(disposed)throw new Error("Plugin caller was disposed");
        const refused=imageEditorRequestError(request,editorTools);
        if(refused)throw new Error(refused);
        const {path,tool}=request;
        // Capture before the window editor takes ownership/focus. Pane callers
        // retain their lifetime while suspended by this managed child.
        const pane=windowTabsManager.paneDialogs.capture();
        const caller=modalOwnership.captureCaller(pane ? windowTabsManager.paneDialogs.resolve(pane) : null);
        const session=dialogStore.openImageEditorTool(path,basename(path),tool);
        managedDialogs.add(session.close);
        const detachCaller=caller?.onClosed(session.close) ?? (()=>{});
        try{await session.closed;}finally{detachCaller();managedDialogs.delete(session.close);}
      },
    },
    text: {
      subscribe(listener) {
        let unlisten: UnlistenFn | undefined;
        let closed = false;
        const dispose = () => { closed = true; unlisten?.(); unlisten = undefined; };
        track(dispose);
        void listen<{ revision: number }>("ai:text-configuration-changed", event => {
          if (!closed && !disposed && Number.isSafeInteger(event.payload.revision) && event.payload.revision >= 0) {
            try { listener(event.payload.revision); }
            catch (error) { report(error, "text configuration listener"); }
          }
        }).then(un => { if (closed || disposed) un(); else unlisten = un; }).catch(() => {});
        return dispose;
      },
      openSettings: () => { if (!disposed) dialogStore.openSettings(); },
    },
    registerCommand(cmd: Command): void {
      const handler = async () => {
        try {
          await cmd.handler();
        } catch (error) {
          report(error, `command ${cmd.id}`);
          throw error;
        }
      };
      track(registerCommandContribution({ ...cmd, handler }));
    },
    registerContextMenuItem(item: ContextMenuItem): void {
      const handler = async (entries: FileEntry[]) => {
        try {
          await item.handler(entries);
        } catch (error) {
          report(error, `menu action ${item.id}`);
        }
      };
      track(contextMenuItems.register({ ...item, handler }, order));
    },
    registerSettingsSection(section: SettingsSectionDescriptor): void {
      const actions=section.actions?.map(action=>({...action,async run(){if(disposed)return;try{await action.run();}catch(error){if(!disposed)report(error,`settings action ${action.id}`);}}}));
      track(pluginSettingsSections.register(pluginId, {...section,actions}, storage, order));
    },
    registerFsProvider(scheme: string, provider: FsProvider): void {
      const list = async (path: string) => {
        try {
          return await provider.list(path);
        } catch (error) {
          log(error, `fs provider ${scheme}`);
          throw error;
        }
      };
      track(registerFsProvider(scheme, { list }, false));
    },
    registerDialog(descriptor: DialogDescriptor): void {
      track(dialogRegistry.register({ ...descriptor, component: ownedComponent(descriptor.component) }));
    },
    registerImageEditorTool(tool: ImageEditorTool): void {
      track(imageEditorRegistry.register({ ...tool, component: ownedComponent(tool.component) }, order));
      editorTools.add(tool.id);
    },
    registerInspector(descriptor: InspectorContribution): void {
      track(inspectorRegistry.register({ ...descriptor, component: ownedComponent(descriptor.component) }, order));
    },
    registerFileView(view: FileViewContribution): void {
      // `<pluginId>.<name>` with a dot-free name: plugin ids may contain dots,
      // so a prefix check alone would let "acme" claim "acme.trace"'s views.
      const name = view.id.startsWith(`${pluginId}.`) ? view.id.slice(pluginId.length + 1) : null;
      if (view.id !== pluginId && (!name || name.includes("."))) throw new Error(`File view ${view.id} must be named ${pluginId}.<name>`);
      track(fileViewRegistry.register(pluginId, { ...view, component: ownedComponent(view.component) }, order));
    },
    registerEntryLineage(contribution: EntryLineageContribution): void {
      const id = String(contribution?.id);
      const name = id.startsWith(`${pluginId}.`) ? id.slice(pluginId.length + 1) : null;
      if (id !== pluginId && (!name || name.includes("."))) throw new Error(`Entry lineage ${id} must be named ${pluginId}.<name>`);
      track(entryLineageRegistry.register(pluginId, contribution, order));
    },
    registerPreviewInfo(section: PreviewInfoContribution): void {
      track(previewInfoRegistry.register(pluginId, { ...section, component: ownedComponent(section.component) }, order));
    },
    openDialog(id: string, props?: Record<string, unknown>, options?: PluginDialogOptions): void {
      try {
        if (disposed) throw new Error("Plugin caller was disposed");
        dialogRegistry.open(id, props ?? {}, options, dialogOwner);
      } catch (error) { report(error, `dialog ${id}`); throw error; }
    },
    closeDialog(id: string): void {
      dialogRegistry.closeOwned(id, dialogOwner);
    },
    jobs: pluginJobs.jobs,
    toast: {
      show: (message, variant) => toastStore.show(message, variant),
      error: (message) => toastStore.error(message),
    },
    events: {
      listen<T>(name: string, handler: (payload: T) => void | Promise<void>): void {
        let un: UnlistenFn | null = null;
        let listenerDisposed = false;
        const deliver = async (payload: T) => {
          try {
            await handler(payload);
          } catch (error) {
            report(error, `event handler ${name}`);
          }
        };
        listen<T>(name, (event) => {
          if (!listenerDisposed && !disposed) void deliver(event.payload);
        })
          .then((fn) => {
            if (listenerDisposed || disposed) fn();
            else un = fn;
          })
          .catch(() => {
            // Outside Tauri (browser/mock) the event system is unavailable.
          });
        track(() => {
          listenerDisposed = true;
          un?.();
        });
      },
    },
    storage,
    async saveSettings(patch) {
      const sections=pluginSettingsSections.sections.filter((section)=>section.pluginId===pluginId);
      const section=sections[0];
      if (section) await section.save(patch);
      else await (storage.setChecked?.({...await storage.get(),...patch}) ?? storage.set({...await storage.get(),...patch}));
      await Promise.all(sections.slice(1).map((section)=>section.applySaved(patch)));
    },
    workspace: {
      capturePane: (paneId) => disposed ? null : windowTabsManager.paneDialogs.capture(paneId),
      registerFileDropTarget(element, handler, options) {
        if (disposed) throw new Error("Plugin caller was disposed");
        if (!pluginDomOwnership.owns(element, dialogOwner)) {
          throw new Error(`File drop target must be owned by ${pluginId}`);
        }
        const unregister = fileDropTargets.register(element, async (paths, source) => {
          if (disposed) return;
          try { await handler(paths, source); }
          catch (error) { report(error, "file drop handler"); }
        }, { enabled: () => {
          if (disposed || !pluginDomOwnership.owns(element, dialogOwner)) return false;
          try { return options?.enabled?.() ?? true; }
          catch (error) { report(error, "file drop target predicate"); return false; }
        } });
        return track(unregister);
      },
      getCurrentDirectory:()=>windowTabsManager.getActiveExplorer()?.currentPath ?? null,
      onDirectoryChanged:handler=>track(observeActiveDirectory(handler)),
      captureSelection:()=>{
        const explorer=windowTabsManager.getActiveExplorer();
        const lease=explorer?.captureMutation();
        return ()=>windowTabsManager.getActiveExplorer()===explorer && !!lease?.current() && lease.selectionCurrent();
      },
      onFilesChanged: (handler) => {
        track(subscribeToLocalFileChanges((directories) => {
          if (disposed) return;
          const changed = [...directories];
          void Promise.resolve().then(() => {
            if (!disposed) return handler(changed);
          }).catch((error) => report(error, "workspace file change handler"));
        }));
      },
      getSelection: () => windowTabsManager.getActiveExplorer()?.getSelectedEntries() ?? [],
      getCombinedSelection: () => windowTabsManager.getCombinedSelection(),
      // Each path once: a lineage merge output is listed under every parent.
      getVisibleEntries: () => {
        const entries = windowTabsManager.getActiveExplorer()?.displayEntries ?? [];
        const seen = new Set<string>();
        return entries.filter(entry => !seen.has(entry.path) && !!seen.add(entry.path));
      },
      navigate: async (path) => {
        await windowTabsManager.getActiveExplorer()?.navigateTo(path);
      },
      selectFile: async (path) => {
        const explorer = windowTabsManager.getActiveExplorer();
        if (!explorer) return;
        const result = await selectWorkspaceFile(path, {
          currentDirectory: () => explorer.currentPath,
          current: () => windowTabsManager.getActiveExplorer() === explorer,
          navigate: directory => explorer.navigateTo(directory, { autoEnterSingleSubdir: false }),
          refresh: () => explorer.refresh({ silent: true }),
          select: path => explorer.revealEntry(path),
          capture: () => { const lease = explorer.captureMutation(); return () => lease.current() && lease.selectionCurrent(); },
        });
        if (result === "missing") toastStore.show("This recorded file is no longer present", "info");
      },
      // Refresh every explorer instance (across tabs), silently — a plugin's
      // background job may have written a file into any pane's directory.
      refreshPanes: async () => {
        await Promise.all(
          windowTabsManager.getAllExplorers().map((exp) => exp.refresh({ silent: true })),
        );
      },
      // Shares the ordered move session with cut/paste and drag-drop (#881):
      // the same conflict prompt, undo recording, ordering, and refresh.
      moveFile: async (sourcePath, targetDir) => {
        // The session reports a same-directory relocation as a committed,
        // "succeeded" item (it legitimately touches nothing, per
        // move_session.rs), so it toasts "Moved 1 item" and this would
        // otherwise report `{ok: true}`. That breaks the documented
        // `PluginMoveResult` no-op contract (`error: "skipped"`), which a
        // caller like the AI-organize dialog depends on to tell "nothing to
        // do" apart from "moved". Short-circuit before the session runs.
        if (sameDirectory(parentDir(sourcePath), targetDir)) {
          return { ok: false, error: "skipped" };
        }
        const { moveFiles } = await import("$lib/state/move-operations");
        const { error, complete } = await moveFiles([sourcePath], targetDir, {
          onRefresh: () => {
            for (const exp of windowTabsManager.getAllExplorers()) void exp.refresh({ silent: true });
          },
        });
        if (error) return { ok: false, error };
        return complete ? { ok: true } : { ok: false, error: "skipped" };
      },
      getFileView: () => windowTabsManager.getActiveExplorer()?.fileView ?? null,
      toggleEntryLineage: (contributionId) => {
        if (entryLineageRegistry.get(contributionId)?.pluginId !== pluginId) throw new Error(`Entry lineage ${contributionId} is not registered by ${pluginId}`);
        windowTabsManager.toggleEntryLineage(windowTabsManager.activePaneId, contributionId);
      },
      isEntryLineageShown: (contributionId) => windowTabsManager.getActiveExplorer()?.isEntryLineageShown(contributionId) ?? false,
      toggleFileView: (viewId) => {
        if (fileViewRegistry.get(viewId)?.pluginId !== pluginId) throw new Error(`File view ${viewId} is not registered by ${pluginId}`);
        const explorer = windowTabsManager.getActiveExplorer();
        if (!explorer) return;
        const shown = fileViewRegistry.resolve(explorer.fileView, explorer.currentPath)?.id === viewId;
        // A retained-but-unavailable preference toggles off too, so the
        // command never appears to do nothing.
        windowTabsManager.setPaneFileView(windowTabsManager.activePaneId, shown || explorer.fileView === viewId ? null : viewId);
      },
    },
    openSettings: () => dialogStore.openPlugins(),
  };

  return {
    ctx,
    reportFailure: report,
    dispose: () => {
      disposed = true;
      for (const fn of [...disposers].reverse()) {
        disposers.delete(fn);
        try {
          fn?.();
        } catch (err) {
          console.error(`[plugins] disposer for "${pluginId}" threw:`, err);
        }
      }
    },
  };
}
