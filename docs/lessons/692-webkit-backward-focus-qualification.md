# 692: qualify browser focus delivery separately from file-list routing

A release-qualification trace showed Playwright WebKit leaving a file row focused
after `Shift+Tab`. That looks like an application routing bug and is not one.

## What the qualification established

Four probes, each on an inert `setContent` page with no application code
(`e2e/file-list-backward-focus.spec.ts`, "backward traversal engine
qualification"):

- Automation delivers an ordinary `Tab` keydown with `shiftKey`, and nothing
  prevents its default action, on both engines.
- A control focused by **keyboard** entry traverses backward correctly on both.
- A control focused **programmatically** traverses backward correctly on both.
- A control focused by a **pointer click** traverses backward on Chromium but
  **not** on WebKit — WebKit resolves the sequential-navigation starting point
  from the clicked node rather than from the focused element, so backward
  traversal restarts inside the control the click landed in. Forward traversal
  after the same click is unaffected on both engines.

In the running application the same split holds: `Shift+Tab` after entering the
list with `Tab` reaches the preceding control on both engines, while `Shift+Tab`
after clicking a row diverges exactly as the inert page does. During the failing
WebKit case the row emits **no** `blur`/`focusout` at all and the keydown ends
with `defaultPrevented === false` — the engine performs no traversal, rather than
the application undoing one.

## The rule

The product path — keyboard in, keyboard out — is correct on every engine, so no
Tab handler was added. Do not "fix" application focus routing to compensate for a
divergence that an inert three-control page reproduces. Scope the expected
failure to the engine and the acquisition route that actually diverges, and keep
the inert probe next to the application contract so a future engine fix shows up
as an unexpected pass instead of silently widening the exemption.

Playwright WebKit is an automation proxy for WKWebView. It is not WKWebView and
is never evidence about native WebKitGTK; both remain unqualified here.

## Running WebKit locally on Arch

Playwright's bundled WPE/GTK MiniBrowser links Ubuntu's ICU 74 and flite, which
Arch does not ship (it has ICU 78, a different soname). `pw_run.sh` delegates to
`minibrowser-*/MiniBrowser`, a wrapper that **overwrites** `LD_LIBRARY_PATH`, so
exporting it in the shell has no effect. Extract the Ubuntu runtime once and
symlink the libraries into the bundle's own `sys/lib` (both `minibrowser-wpe` and
`minibrowser-gtk`), which is the directory that wrapper does put on the path.

## Related

`e2e/file-list-focus.spec.ts` and ADR 0015 own the composite's own contract —
cursor reveal, selection retention and forward Tab re-entry. Backward traversal
must not be inferred from those tests, nor they from this one.
