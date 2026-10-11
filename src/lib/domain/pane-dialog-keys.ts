/** Workspace navigation remains available from pane dialogs, including inputs.
 * Match command identities so rebinding cannot admit file mutations. */
export const paneDialogNavigationCommands = [
  "view.switchPane", "pane.focusLeft", "pane.focusRight", "pane.focusUp", "pane.focusDown",
  "tabs.nextTab", "tabs.nextTabAlt", "tabs.prevTab", "tabs.prevTabAlt",
] as const;
export const isPaneDialogNavigationCommand = (id: string): boolean =>
  paneDialogNavigationCommands.some(command => command === id);
