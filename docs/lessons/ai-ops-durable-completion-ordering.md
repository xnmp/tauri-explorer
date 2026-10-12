# AI success commits through the sealed completion sidecar

A separate completion-identity transaction after fsyncing capture creates a
loss window: a crash leaves durable original bytes but no recoverable identity,
so reserved-spool cleanup deletes successful output. A transaction before
capture durability creates the opposite invalid-identity window.

The shared `Store::durable_host_completion` now fsyncs both streams and their
directory entries, writes status/hash/length into a temporary sidecar, fsyncs
that sidecar, then atomically renames it to `completed.json` and syncs the
directory. This sealed-sidecar publication is the completion commit point.
SQLite completion/status rows and older pending markers are derived metadata;
recovery rebuilds the database identity from the seal. Destructor abandonment
and the sweeper preserve sealed capture until delivery acknowledgement or
explicit settlement. A pre-seal crash still settles as Unknown without replay.

The shared pipe reader tees bounded stdout into the temporary spool. Stdout
overflow fails execution; stderr uses an independent bounded prefix/suffix
buffer and an explicit truncation marker, so diagnostics cannot turn an exit-zero
original into an error. Streaming does not guarantee unfsynced chunks survive
power loss.

The model records the successful seal independently of production metadata,
keeps that conservation obligation through restart, and requires exact delivery
at quiescence. Actual first-seal write/sync/rename boundaries are also exercised
with Store filesystem faults. Directory-sync errors on consumer delivery defer
acquisition; retry resyncs the journal and copy before acknowledgement and must
converge after faults clear. Preserve saved shrinking seeds.

Compatible replacement must join preparation custody and its live presentation
by package and digest, using `same_owner`, rather than requiring the same process
incarnation: recovery can recapture input under a newer incarnation while the
Accepting job still names the prior one. A different digest cannot retain that
input custody through this join.

## Acquired receipt and admission release are separate commits

Removal can run after durable acquisition and the provider acquired receipt,
but before admission release. A missing acquired disposition does not mean
undelivered output. Use `Store::terminal_delivery_at` for terminal classification;
verified acquisition evidence wins over release bookkeeping. Persist the acquired
tombstone and complete existing presentation in the removal transaction, without
loss notices. Consumer edits/deletion after acquisition do not undo historical
delivery. The model must schedule acquired receipt -> crash -> removal before
release, and track durable acquisition independently of acknowledgement.

Broker identity assertions must read production `Broker::generation()` through
the active registry. Fixture identity maps cannot detect a lifecycle regression;
prove sensitivity by mutating production retirement/replacement and reverting it.
