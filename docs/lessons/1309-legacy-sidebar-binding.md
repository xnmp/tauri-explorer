# #1309 — Old Files Sidebar binding conflicts with Terminal

The current defaults were already Alt+M B for Toggle Sidebar and Alt+M T for Open Terminal. An older saved override still bound the distinct `view.focusFilesSidebar` command to Alt+M T. Command registration order then sent the chord to the sidebar.

On first launch after this fix, keybindings migrate only that exact obsolete Files Sidebar default out of saved overrides. Other customized bindings and explicit unbindings survive. A persisted migration marker makes this a one-time transition, so a later deliberate assignment of that chord remains valid. Browser regressions seed the old override and verify that Alt+M B toggles the sidebar while Alt+M T opens a live xterm without changing sidebar visibility.
