# 784 — zsh history followed the injected ZDOTDIR

On macOS, `/etc/zshrc` can set `HISTFILE` from `ZDOTDIR` before the injected
`.zshrc` shim runs. Since the shim directory is versioned by content, history
written there becomes detached from the user's normal shell history and can be
orphaned by a later app update.

Track a custom `HISTFILE` set in the user's `.zshenv` or `.zprofile`, then
restore that path (or `$USER_ZDOTDIR/.zsh_history` by default) before sourcing
the user's `.zshrc`. The user's own `.zshrc` setting remains authoritative.
This follows [VS Code's zsh injection](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-rc.zsh).
A real zsh spawn test imports a temporary shim history path and verifies that
history is written to the default user path or each custom startup-file path.
It failed before the fix.
The physical macOS terminal still needs a release-build check before macOS
alpha admission.
