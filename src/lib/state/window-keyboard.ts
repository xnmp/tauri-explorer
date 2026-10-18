import { admitsCommandDestination } from "$lib/domain/command-admission";
import { isModifierKey } from "$lib/domain/keyboard";
import { getTerminalCommand } from "$lib/domain/terminal-keys";
import { allowsPaneDialogCommandInput } from "$lib/domain/pane-dialog-keys";
import { resolveWindowKey, isNativeControlActivation } from "$lib/domain/window-keys";
import type { Command } from "./commands.svelte";
import type { ModalScope } from "./modal-ownership.svelte";
import type { keybindingsStore as bindingsType } from "./keybindings.svelte";

export interface WindowKeyboardDependencies {
  bindings: Pick<typeof bindingsType, "trackModifierKey" | "trackedMetaHeld" | "resetTrackedModifiers" | "matchesAnyBinding" | "matchesAnyChordPrefix" | "matchesChordPrefixForCommand" | "isChordActiveForCommand" | "isChordActive" | "cancelChord" | "findMatchingCommand">;
  getCommand(id: string): Pick<Command, "scope" | "paneIds" | "when" | "allowInDialogInput"> | undefined;
  executeCommand(id: string): Promise<unknown>;
  dialogs: {
    readonly hasModalOpen: boolean;
    isPaneBlocked(paneId: string): boolean;
    inputScope?(event: Event, activePaneId: string): ModalScope | undefined;
    subscribeOwnership?(listener: () => void): () => void;
    requestCloseTop(event?: KeyboardEvent, scope?: ModalScope): void;
    openJobsPanel(): void; openSettings(): void;
  };
  toggleDualPane(): void;
  getActiveExplorer(): { readonly showFilter: boolean; openFilter(): void; closeFilter(): void } | undefined;
  getActivePaneId?(): string;
}

/** Own window keyboard subscriptions and transient modifier/chord state. */
export function startWindowKeyboard(target: EventTarget, dependencies: WindowKeyboardDependencies): () => void {
  const { bindings, dialogs } = dependencies;
  let disposed = false;
  const isAvailable = (id: string) => {
    const command = dependencies.getCommand(id);
    return command !== undefined
      && admitsCommandDestination(command, dependencies.getActivePaneId?.() ?? "", dialogs)
      && (!command.when || command.when());
  };
  const inputContext = (event: Event) => {
    const element = event.target as HTMLElement | null;
    return {
      nativeButton: element?.tagName === "BUTTON",
      fileEntry: element?.matches?.('.file-list .entry-item, .file-list .virtual-viewport[role="grid"], .file-list .virtual-viewport[role="treegrid"], .file-list .virtual-viewport[role="tree"], .file-list .virtual-viewport[role="listbox"]') ?? false,
      input: element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || !!element?.isContentEditable,
      terminal: !!element?.closest?.(".terminal-panel"),
      customButton: !!element?.closest?.('[role="button"]'),
      // Composite widgets (e.g. a plugin's ui/file-tiles grid) move focus with
      // arrow keys themselves; the pane's own grid is matched by fileEntry.
      grid: !!(element?.closest?.('[role="grid"]') || element?.closest?.('[role="treegrid"]')),
      separator: !!element?.closest?.('[role="separator"]'),
      media: !!element?.closest?.('.video-preview'),
    };
  };
  const cancelChord = () => { if (!disposed) bindings.cancelChord(); };
  const inputScope = (event: Event): ModalScope | undefined => dialogs.inputScope
    ? dialogs.inputScope(event, dependencies.getActivePaneId?.() ?? "")
    : dialogs.hasModalOpen ? null : undefined;
  const stopOwnership = dialogs.subscribeOwnership?.(cancelChord);

  function handleKeydown(raw: Event): void {
    if (disposed) return;
    const event = raw as KeyboardEvent;
    // WebKitGTK reports Super separately from metaKey; track before routing.
    bindings.trackModifierKey(event, true);
    const { input, nativeButton, fileEntry, terminal: terminalFocus, separator, customButton, grid, media } = inputContext(event);
    const scope = inputScope(event);
    // Custom controls own keys they explicitly accept. Unhandled commands
    // keep normal routing; accepted local input retires an unfinished chord.
    if ((separator || customButton || grid || fileEntry || media || scope !== undefined) && event.defaultPrevented) { bindings.cancelChord(); return; }
    if (isNativeControlActivation(event, { nativeButton, fileEntry, trackedMetaHeld: bindings.trackedMetaHeld })) {
      bindings.cancelChord(); return;
    }
    if (scope) {
      if (event.key === "Escape") {
        bindings.cancelChord(); event.preventDefault(); dialogs.requestCloseTop(event, scope); return;
      }
      const eligible = (id: string) => isAvailable(id) && allowsPaneDialogCommandInput(dependencies.getCommand(id), input);
      if (bindings.matchesAnyBinding(event, eligible) || bindings.isChordActive) {
        const command = bindings.findMatchingCommand(event, eligible);
        if (command) {
          event.preventDefault();
          if (command !== "chord:waiting") void dependencies.executeCommand(command)
            .catch(error => console.error("Keyboard command failed:", error));
          return;
        }
      }
      if (!isModifierKey(event.key)) bindings.cancelChord();
      return; // Dialog controls (including Tab and submit chords) own the rest.
    }
    const terminalCommand = terminalFocus ? getTerminalCommand(event, bindings, isAvailable) : undefined;
    const explorer = dependencies.getActiveExplorer();
    const chord = terminalFocus
      ? terminalCommand !== undefined && (bindings.isChordActiveForCommand(event, terminalCommand) || bindings.matchesChordPrefixForCommand(event, terminalCommand))
      : bindings.isChordActive || bindings.matchesAnyChordPrefix(event, isAvailable);
    const action = resolveWindowKey(event, {
      input, nativeButton, fileEntry, trackedMetaHeld: bindings.trackedMetaHeld,
      terminal: terminalFocus && scope === undefined, terminalCommand,
      chord, modal: scope === null, filterOpen: explorer?.showFilter ?? false,
    });
    if (action === "native-activation") {
      bindings.cancelChord();
      return;
    }
    if (action === "pass") {
      if (input || scope !== undefined) bindings.cancelChord();
      return;
    }
    if (action === "terminal") {
      // A mismatching terminal suffix must not leave an Explorer chord alive.
      if (bindings.isChordActive && !isModifierKey(event.key) && !event.repeat) bindings.cancelChord();
      return;
    }
    if (action === "command") {
      const pending = bindings.isChordActive;
      const command = bindings.findMatchingCommand(event, (id) =>
        (!terminalFocus || id === terminalCommand) && isAvailable(id));
      if (!command) {
        if (pending && !isModifierKey(event.key)) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (command !== "chord:waiting") {
        void dependencies.executeCommand(command).catch((error) => console.error("Keyboard command failed:", error));
      }
      return;
    }
    // A surface action ends any unrelated prefix just as a command match does.
    bindings.cancelChord();
    event.preventDefault();
    switch (action) {
      case "close-dialogs": dialogs.requestCloseTop(event); break;
      case "open-filter": if (isAvailable("general.filterCurrentDir") && explorer && !explorer.showFilter) explorer.openFilter(); break;
      case "close-filter": if (isAvailable("general.filterCurrentDir")) explorer?.closeFilter(); break;
      case "open-jobs": if (isAvailable("general.openJobsPanel")) dialogs.openJobsPanel(); break;
      case "open-settings": if (isAvailable("general.openSettings")) dialogs.openSettings(); break;
      case "toggle-dual-pane": if (isAvailable("view.toggleDualPane")) dependencies.toggleDualPane(); break;
    }
  }

  const handleKeyup = (event: Event) => {
    if (!disposed) bindings.trackModifierKey(event as KeyboardEvent, false);
  };
  const releaseInput = () => {
    bindings.resetTrackedModifiers();
    bindings.cancelChord();
  };
  const handleFocus = (event: Event) => {
    const context = inputContext(event);
    if ((context.input && !context.terminal) || inputScope(event) !== undefined) cancelChord();
  };
  target.addEventListener("keydown", handleKeydown);
  target.addEventListener("keyup", handleKeyup);
  target.addEventListener("blur", releaseInput);
  target.addEventListener("focusin", handleFocus);
  target.addEventListener("pointerdown", cancelChord);
  return () => {
    if (disposed) return;
    disposed = true;
    stopOwnership?.();
    target.removeEventListener("keydown", handleKeydown);
    target.removeEventListener("keyup", handleKeyup);
    target.removeEventListener("blur", releaseInput);
    target.removeEventListener("focusin", handleFocus);
    target.removeEventListener("pointerdown", cancelChord);
    releaseInput();
  };
}
