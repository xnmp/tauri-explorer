# 782 — Plugin failures must stay with their plugin

Each case below was tested while another plugin was active, and two defects
turned up.

- **A hung activation held back every later plugin.** `initPlugins` awaited
  each activation in turn. nano-banana and ai-organize await plugin storage
  during activation, so a storage read that never answered left every plugin
  after them unregistered. Activations now start together, in list order.
  Synchronous registration therefore keeps its order, and one plugin's await
  delays no other.
- **An uncaught plugin failure was invisible.** `executeCommand` only logs a
  rejected handler. `ContextMenu` fires menu actions with `void`, so a
  rejection there became an unhandled rejection: a crash-report capture and
  no user message. The plugin context now reports any failure its command or
  menu action lets escape, as a toast that names the plugin.
  - Commands still reject, so `executeCommand` returns `false`.
  - Menu actions resolve after reporting, because their call site has no
    failure channel.
- **Report `error.message`, not the Error.** Interpolating an `Error` gives
  `Error: …`, which theme-from-image showed in its failure toast.

The built-in plugins catch their own backend errors, and a failed storage read
degrades to an empty object. So the context-level report is a safety net for
failures a plugin does not anticipate. The browser test instead exercises
isolation through a real backend failure (`__MOCK_FAILURES__`).
