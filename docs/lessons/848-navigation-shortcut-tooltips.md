# Navigation shortcut tooltips must use effective bindings

Navigation command defaults are not a reliable source for user-facing shortcut
hints because persisted user overrides can replace or remove them. UI that
advertises a command shortcut should read `getCommandShortcut(commandId)`, the
same effective keybinding state used by window command dispatch.

For navigation controls, verify the rendered `title` attribute and then press
the advertised custom binding against visible folder history. This catches both
a stale label and any divergence between the label and command handling.
