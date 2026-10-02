# #820 address-bar selection evidence

The existing implementation on `dev` at `78f11845` passed the checked launch
paths. This change adds verification and screenshots; it does not change
production window or navigation behavior.

## Native checks

Linux/Arch, WebKitGTK, private Xvfb display with Openbox, isolated D-Bus and
XDG profile. Driver, application and WebKit processes were checked for the
same private display/session/profile. The host desktop and clipboard were
not used. Build: `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle
--features e2e-hooks`.

`new-window-address-selection.spec.ts`: four passing cases, fresh requested
directory, warm requested directory, actual Ctrl+N, and actual Command Palette
New Window. Each checks native active-window identity through X11 **before**
switching WebDriver's context, complete input selection, replacement through
key input, Enter navigation to a real directory containing a proof file,
Escape cancellation, and the original window's path and selected file.

Eight inspected screenshots under
`screenshots/test/820-highlight-address-bar-on-making-new-window/` show the
selected path and resulting directory for each case. Screenshots alone do not
prove native focus or selection offsets; the native assertions provide that
evidence. Four representative images are also under `evidence/`.

## Startup timing

The browser test delays the initial directory response with the mock IPC
boundary and advances a controlled clock. It checks that no address input
mounts before that response, the requested path is selected afterward,
subsequent typing survives additional timer advancement, and Enter displays
the replacement directory's contents. This complements native focus evidence;
it does not establish native backend timing. Existing window-launch/warm-window
unit coverage checks delayed warm navigation before its focus request.

## Remaining acceptance evidence

Do not mark every #820 criterion complete from these four cases. Tab drag
detachment/desktop tear-off and the restore-closed-surface new-window fallback
also use the launcher and have not been checked for address selection here.
Native delayed fresh startup and a deliberately late initial response after
typing have not been forced in this run. No folder context-menu action for
opening a new window exists in this version; the requested-directory cases
exercise the shared launcher, rather than claiming a nonexistent menu was used.
