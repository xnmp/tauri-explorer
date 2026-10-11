import type { PluginFileDropHandler, PluginFileDropTargetOptions } from "$lib/plugins/api";

export interface FileDropRegistration {
  readonly element: HTMLElement;
  readonly handler: PluginFileDropHandler;
  readonly enabled: () => boolean;
  readonly live: () => boolean;
}

export type RegisteredDropTarget =
  | { type: "plugin"; registration: FileDropRegistration }
  | { type: "blocked" };

export function createFileDropTargets() {
  const targets = new Map<HTMLElement, FileDropRegistration[]>();

  function register(element: HTMLElement, handler: PluginFileDropHandler, options?: PluginFileDropTargetOptions): () => void {
    let live = true;
    const registration: FileDropRegistration = { element, handler, enabled: options?.enabled ?? (() => true), live: () => live };
    targets.set(element, [...(targets.get(element) ?? []), registration]);
    return () => {
      if (!live) return;
      live = false;
      const previous = targets.get(element) ?? [];
      const remaining = previous.filter(item => item !== registration);
      if (remaining.length) targets.set(element, remaining);
      else targets.delete(element);
      if (previous.at(-1) === registration) element.classList.remove("drop-target");
    };
  }

  function resolve(element: Element | null): RegisteredDropTarget | null {
    if (!element) return null;
    // Parked/suspended surfaces must never advertise a target. This also
    // protects covered pane content without coupling to dialog ownership.
    if (element.closest?.("[inert], [hidden], .suspended")) return { type: "blocked" };
    for (let node: Element | null = element; node; node = node.parentElement) {
      const registration = targets.get(node as HTMLElement)?.at(-1);
      if (!registration) continue;
      if (!registration.element.isConnected || !registration.enabled()) return { type: "blocked" };
      return { type: "plugin", registration };
    }
    // Dialog surfaces, including pane dialogs (capability "paneDialogs"), are
    // never implicit transfer destinations; only their registered targets are.
    if (element.closest?.(".modal-overlay, .plugin-file-view, .pane-dialog-container")) return { type: "blocked" };
    return null;
  }

  return { register, resolve };
}

export const fileDropTargets = createFileDropTargets();
