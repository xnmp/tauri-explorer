/**
 * Dynamic workspace commands (#228): one "Workspaces: Open <name>" palette
 * entry per saved workspace, VSCode-style. Re-synced whenever the
 * workspace list changes (save / rename / delete / tab rename).
 */

import type { Command } from "../commands.svelte";
import { registerCommand, unregisterCommand } from "../commands.svelte";
import { workspacesStore } from "../workspaces.svelte";
import { windowTabsManager } from "../window-tabs.svelte";

const COMMAND_PREFIX = "workspace.openNamed:";

let registeredIds = new Set<string>();

/** (Re)register one open-command per saved workspace. */
function syncWorkspaceOpenCommands(): void {
  for (const id of registeredIds) unregisterCommand(id);
  registeredIds = new Set();

  for (const workspace of workspacesStore.list) {
    const commandId = `${COMMAND_PREFIX}${workspace.id}`;
    const command: Command = {
      id: commandId,
      label: `Workspaces: Open ${workspace.name}`,
      category: "general",
      handler: () => {
        const current = workspacesStore.get(workspace.id);
        if (current) windowTabsManager.restoreFromState(current.state);
      },
    };
    registerCommand(command);
    registeredIds.add(commandId);
  }
}

/** Register the dynamic workspace commands and keep them in sync. */
export function initWorkspaceOpenCommands(): void {
  syncWorkspaceOpenCommands();
  workspacesStore.subscribe(syncWorkspaceOpenCommands);
}
