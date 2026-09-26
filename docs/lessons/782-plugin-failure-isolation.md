# 782 — Plugin failures must stay with their plugin

Each case below was tested while another plugin was active.

## A hung activation held back every later plugin

`initPlugins` awaited each activation in turn. nano-banana and ai-organize
await plugin storage before they register anything, so a storage read that
never answered left every plugin after them unregistered. Activations now
start together, in list order.

Starting them together made registration order follow completion order.
nano-banana and ai-organize finish after the synchronous plugins, in whichever
order their storage reads return, so the AI submenu and the Settings sections
changed order between launches. The plugin context now carries the plugin's
list position, and the context-menu and settings registries sort by it (stable
within one plugin). A re-enabled plugin also returns to its own place in those two
surfaces instead of the end. Command-palette insertion order is not keyed:
the palette ranks commands by frecency and match score. Enablement is read as each activation starts, because an earlier
plugin's activation may have disabled a later one.

## A plugin failure has to reach the context to be reported

`ContextMenu` fires menu actions without awaiting them, and `executeCommand`
only logs a rejected handler. The plugin context wraps both kinds of handler.
A failure is reported as a toast that names the plugin, and written to the app
log through `logFrontendError`. Commands still reject, so `executeCommand`
returns `false`. Menu actions resolve after reporting, because their call site
has no failure channel.

The wrapper only sees what a handler returns. Five built-in plugins started
their work with `void openX()` and returned nothing, so their failures bypassed
it entirely. Handlers now return that promise. theme-from-image no longer
catches and toasts its own failures: the context reports them under the
plugin's name.

## A real backend error is not an `Error`

Tauri rejects a failed command with the serialized `AppError`,
`{ kind, message }` (`src-tauri/src/error.rs`). `err instanceof Error ?
err.message : String(err)` turns it into `[object Object]`, which is what
theme-from-image showed for a real failure. Use `extractError`.

`mock-invoke`'s `__MOCK_FAILURES__` used to throw `new Error(message)`, so a
browser test could pass against a message format the real app never produces.
It now rejects with the same `{ kind, message }` shape.

## Browser tests: error toasts are short-lived

Error toasts dismiss after 3 s. On WebKit CI, opening a second plugin's
dialog took longer than that, so asserting the toast afterwards failed on every
attempt. Assert the toast right after the failure, and capture it with
`animations: "disabled"`: the entrance animation starts at zero opacity.
