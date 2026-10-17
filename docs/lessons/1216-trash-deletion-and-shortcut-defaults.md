# Trash actions and shortcut defaults (#1216)

The in-app Trash uses virtual entry paths. Ordinary deletion cannot remove them;
selected Trash items must resolve opaque inventory IDs to native artifacts.
Delete and Shift+Delete always open permanent confirmation, even with ordinary
delete confirmation disabled. Native purge verifies the listed object identity,
uses the prepared permanent-delete engine, and removes only matching metadata.
Purge remains independent of the original restore destination.

A changed shortcut default must preserve explicit user overrides. Register every
command with the binding registry, including commands without a default, so a
custom shortcut still dispatches after its default is retired. Focused terminal
input admits only the exact eligible surface-toggle IDs and core navigation.

Recycle Bin search matches its display name through positive frecency. Keep its
built-in virtual root out of filesystem existence probes; otherwise pruning
silently removes its history every time Quick Open opens.
