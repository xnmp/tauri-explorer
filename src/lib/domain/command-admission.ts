/** A command's affected panes are declared alongside its handler. Focus and
 * launcher surfaces do not change its destination or admission policy. */
export interface CommandDestination {
  scope: "pane" | "window";
  paneIds?: () => readonly string[];
}
export interface CommandModalAdmission {
  readonly hasModalOpen: boolean;
  isPaneBlocked(paneId: string): boolean;
}

export function admitsCommandDestination(command: CommandDestination, activePaneId: string, dialogs: CommandModalAdmission): boolean {
  return !dialogs.hasModalOpen && (command.scope === "window"
    || (command.paneIds?.() ?? [activePaneId]).every(paneId => !dialogs.isPaneBlocked(paneId)));
}
