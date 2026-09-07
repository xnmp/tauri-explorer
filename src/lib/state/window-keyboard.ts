import { getTerminalCommand } from "$lib/domain/terminal-keys";
import { resolveWindowKey } from "$lib/domain/window-keys";
import type { keybindingsStore as bindingsType } from "./keybindings.svelte";

export interface WindowKeyboardDependencies {
  bindings: Pick<typeof bindingsType, "trackModifierKey" | "resetTrackedModifiers" | "matchesAnyBinding" | "matchesChordPrefixForCommand" | "isChordActiveForCommand" | "isChordActive" | "cancelChord" | "findMatchingCommand">;
  getCommand(id: string): { when?: () => boolean } | undefined;
  executeCommand(id: string): Promise<unknown>;
  dialogs: { readonly hasModalOpen: boolean; closeAll(): void; openJobsPanel(): void; openSettings(): void };
  terminal: { readonly enabled: boolean; toggle(): void };
  toggleDualPane(): void;
  getActiveExplorer(): { readonly showFilter: boolean; openFilter(): void; closeFilter(): void } | undefined;
}

/** Own window keyboard subscriptions and transient modifier/chord state. */
export function startWindowKeyboard(target: EventTarget, dependencies: WindowKeyboardDependencies): () => void {
  const { bindings, dialogs, terminal } = dependencies;
  let disposed = false;
  const isAvailable = (id: string) => {
    const command = dependencies.getCommand(id);
    return command !== undefined && (!command.when || command.when());
  };
  const inputContext = (event: Event) => {
    const element = event.target as HTMLElement | null;
    return {
      input: element?.tagName === "INPUT" || element?.tagName === "TEXTAREA" || !!element?.isContentEditable,
      terminal: !!element?.closest?.(".terminal-panel"),
      separator: !!element?.closest?.('[role="separator"]'),
    };
  };
  const cancelChord = () => { if (!disposed) bindings.cancelChord(); };

  function handleKeydown(raw: Event): void {
    if (disposed) return;
    const event = raw as KeyboardEvent;
    // WebKitGTK reports Super separately from metaKey; track before routing.
    bindings.trackModifierKey(event, true);
    const { input, terminal: terminalFocus, separator } = inputContext(event);
    // A focused splitter owns its handled resize keys. Unhandled commands keep
    // normal routing; accepted local input terminates an unfinished chord.
    if (separator && event.defaultPrevented) { bindings.cancelChord(); return; }
    const terminalCommand = terminalFocus ? getTerminalCommand(event, bindings, isAvailable) : undefined;
    const explorer = dependencies.getActiveExplorer();
    const action = resolveWindowKey(event, {
      input, terminal: terminalFocus, terminalCommand,
      modal: dialogs.hasModalOpen, filterOpen: explorer?.showFilter ?? false,
      terminalEnabled: terminal.enabled,
    });
    if (action === "pass") {
      if (input || dialogs.hasModalOpen) bindings.cancelChord();
      return;
    }
    if (action === "terminal") {
      // A mismatching terminal suffix must not leave an Explorer chord alive.
      if (bindings.isChordActive) bindings.cancelChord();
      return;
    }
    if (action === "command") {
      const command = bindings.findMatchingCommand(event, (id) =>
        (!terminalFocus || id === terminalCommand) && isAvailable(id));
      if (!command) return;
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
      case "toggle-terminal": terminal.toggle(); break;
      case "close-dialogs": dialogs.closeAll(); break;
      case "open-filter": if (explorer && !explorer.showFilter) explorer.openFilter(); break;
      case "close-filter": explorer?.closeFilter(); break;
      case "open-jobs": dialogs.openJobsPanel(); break;
      case "open-settings": dialogs.openSettings(); break;
      case "toggle-dual-pane": dependencies.toggleDualPane(); break;
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
    if ((context.input && !context.terminal) || dialogs.hasModalOpen) cancelChord();
  };
  target.addEventListener("keydown", handleKeydown);
  target.addEventListener("keyup", handleKeyup);
  target.addEventListener("blur", releaseInput);
  target.addEventListener("focusin", handleFocus);
  target.addEventListener("pointerdown", cancelChord);
  return () => {
    if (disposed) return;
    disposed = true;
    target.removeEventListener("keydown", handleKeydown);
    target.removeEventListener("keyup", handleKeyup);
    target.removeEventListener("blur", releaseInput);
    target.removeEventListener("focusin", handleFocus);
    target.removeEventListener("pointerdown", cancelChord);
    releaseInput();
  };
}
