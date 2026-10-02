# #881: Plugin moves must preserve admission and worker cancellation

`PluginWorkspace.moveFile` now uses the same ordered move session as paste and
drag/drop. Native session history owns the inverse; the renderer must not add
a second Undo action. Keep the plugin's existing skipped-result contract for
a same-directory request and keep organizer failures visible in its dialog.

Converging callers is insufficient if the destination path loses an existing
guarantee. The non-durable session originally called the raw filesystem mover,
while the retired single-item command admitted source and target claims. The
session now uses `admission::admitted_execute` with the shared move worker.
Real filesystem tests hold each endpoint's claim, verify refusal without an
effect, then release the claim and verify the same move succeeds.

An initial cancellation check before asynchronous admission also leaves a
race. A move cancelled while admission or its blocking worker waits must not
perform the later filesystem effect. Carry the session's check into the
worker and run it immediately before mutation, while its admission owner is
still held. Native history retains uninterrupted inverse execution through
the same worker with its default check.

The regression holds the coordinator's real cross-process admission lock,
polls `MoveWork::apply` until it yields, cancels, then releases the lock. It
asserts source bytes remain, the destination is absent, and the admission can
be acquired again. It failed before the worker check and passed afterward;
cancelling before calling `apply` did not reproduce this race.
