# TraceExplorer #29: pane dialog lifetime and input ownership

Pane dialogs need matching scoped reservations and mounted Modal surfaces.
Changing only the backdrop leaves application keyboard input globally blocked.
Managed caller links follow lifetime even when the caller is parked or suspended;
availability controls input routing, not caller lookup.

Keep contributed components keyed in WindowDialogs and move only a host-owned
container. Park it beneath a permanently hidden/inert parent. Do not manually
change container attributes also owned by Svelte: a same-flush pane remount can
derive visible→visible and leave manual hidden/inert changes stranded.

Pane-focus commands must leave an old dialog editor when activating an uncovered
pane. Closing a captured A opening must not restore an earlier B control. Restore
only to the still-active owner and only while focus belongs to the closing dialog.

Retire captures/dialogs synchronously even when the last tab keeps explorers for
native-close rollback. Physical overlay-slot registration follows the mounted
explorer identity and survives transient scope retirement; a fresh scope can bind
that retained slot after close failure. Old captures remain invalid. Opening must
also unwind sessions/reservations if pane activation fails before component mount.

Unit regressions cover these production seams. Browser portal/focus/geometry
acceptance lives in e2e/pane-dialogs.spec.ts and must be run by the lead session.

Svelte effect cleanup reads historical rune values. Keep authoritative modal
registrations outside rune state and publish a fresh reactive revision on each
change. Filtering a rune array in cleanup can resurrect a plugin's reservation
after close (blocking Ctrl+T), or discard the Plugins surface registered before
Settings cleanup in the same flush (leaving Plugins hidden). Client-runtime
Vitest regressions compile the production ownership module and exercise actual
effect cleanup; the normal SSR transform cannot reproduce these failures.

DOM removal can return focus to body before Modal cleanup. Track focusin/focusout
while a pane dialog is mounted to distinguish removed dialog focus from a move
to B or an explicit blur. Restore after ownership/inert release only if the
owner stays active and no new focus target has taken over. Uncovered panes keep
ordinary Escape/Clear Selection behavior; selecting a file in B succeeds before
Escape clears it, while A's dialog and draft remain untouched.

Managed children follow their caller's focused surface or own pane/window
reservation, independently of the destination scope. Register retirement
callbacks on both the presentation reservation and its mounted surface, so
caller closure before mount or before Svelte cleanup settles children promptly.
Never fall back to an unrelated pane's most recently mounted surface.

Native drag initiation is a lease, not completion. Document dragend retains the
captured source until native delivery/cancellation; a failed start restores DOM
authority. Snapshot and defer a DOM drop racing the start acknowledgment, and
carry the host session in MIME to reject late DOM duplicates after native
retirement. Preserve each source/target's dev copy policy when changing transport.
Real lifecycle unit coverage uses the production source, sidebar capture listener,
native start boundary and registered webview listener together. Capture source
metadata in native receiver events before frontend IPC can reorder Enter and the
source result. Queue source retirement from a worker back to the main event loop
behind Wry receiver events; direct main-to-main dispatch runs immediately and
can overtake them. On GTK, drop-performed precedes data transfer: keep data-get
handlers until dnd-finished. Failed starts must also disconnect those handlers.
Receiver snapshots expire on Drop, Leave, replacement Enter and window teardown,
so later external drags with identical paths never inherit old identity.

Returned plugin target disposers must remove themselves from tracked teardown
ownership, as well as unregistering the target. Idempotent underlying cleanup can
otherwise conceal indefinitely retained DOM/handler closures.

Accessibility attributes do not define drop eligibility: decorative folder icons
and plugin target children may be `aria-hidden` and still receive pointer hits.
Block parked content through hidden/inert state and explicit host surface classes;
resolve registered ancestors before blocking the remaining dialog surface.

Keep a source's copy policy separate from modifier intent. Native receiver events
snapshot platform modifiers before IPC; DOM fallback reads the actual drop event.
The Rust source serializer must retain the policy across windows. Snapshot at
the platform callback, before Wry queues Tauri delivery; Windows DoDragDrop can
buffer receiver events until after Ctrl is released. Vendored Wry's observer
provides Ctrl from the COM callback, GDK Ctrl, or AppKit Option, and the host
admits only FIFO deliveries matching the original native event. Linux listing
sources remain move-only, and Miller backgrounds permit same-directory copies.
A delayed DOM replay retains its original event modifiers without overwriting a
successor gesture's live modifier state.

Windows drag resolves drive-path links through dunce while preserving ordinary
UNC paths. Prepare that native transport once, freeze its multiset in the source
lease, and skip a second resolution during OS drag initiation. Enter/Drop must
compare the captured transport without resolving the original link again: it can
be deleted or retargeted mid-drag. After verification, publish original paths
with source metadata so frontend path-set admission retains directory pinning.

Deferred DOM fallback captures destination ancestry/path, the pane explorer's
navigation lease (including away-and-back), and the exact registration object.
Discard and report any stale destination instead of redispatching into reused
DOM or a replacement handler. Cleanup owns only the original hover revision.

All pane-owned content participates in shared inert registration, including
Miller columns hoisted into an island. Inert hit testing can expose a surrounding
wrapper, so native resolution must also reject covered hit-pane ownership and
covered implicit destinations. Fullscreen entry and automatic exit use pane-only
ownership: a dialog covering the preview's pane exits the viewer before paint.
Window modals block preview keyboard input while preserving fullscreen underneath;
`isPaneBlocked` includes window modals and must not drive fullscreen exit.

Dialog instance creation owns plugin close authority. Reusing an existing pane
dialog only observes its result for another plugin; its handle and disposal must
not retire the owner's presentation or bypass a mounted close guard. Host and
contribution retirement remain forced lifecycle operations.

Capture the caller surface as well as pane identity before asynchronous work.
`workspace.capturePane()` retains that snapshot; managed opening can pass it as
`options.caller` independently of the destination (including window children).
Caller lookup at resolution time follows newly focused B instead of original A.
A captured caller that retired during the await settles immediately; it must not
adopt a replacement surface in the same pane. An explicit empty caller snapshot
also cannot acquire a subsequently opened dialog. Reservation and mounted-surface
retirement both end the captured presentation's lifetime.

Keep the pane portal slot registered for identity/focus recovery, but give it no
layout box while empty (`display: contents`). An empty absolute inset overlay
still obstructs axe's background sampling even with `pointer-events: none`.
Apply its positioned box only while a dialog container is mounted in the slot.

Browser native-start qualification uses a partial Tauri boundary. Positive
`common.invoke` detection latches native routing, so removing that stub cannot
restore browser navigation safely. Verify the resulting destination and source
files through the mock listing directly, alongside the real DOM drop's toast
and source-row outcome. The mock native-start command rejects without sending
completion because the browser cannot initiate an OS drag; a fake success would
incorrectly revoke DOM fallback authority.
