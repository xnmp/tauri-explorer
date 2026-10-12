# Released preparation custody does not settle presentation

Commit `55501430` returned from automatic reconciliation whenever admission
custody was Released. A start can commit `reserve_intent`, crash before
`claim_forwarding`, and be released by startup `release_preparations` as
`never_forwarded`. With no receipt/acquisition evidence the delivery classifier
is Pending, so terminal reconciliation does nothing. Returning solely on Released
leaves its Accepting job busy forever. Cancellation has the same durable gap
between preparation release and the separate terminal presentation write.

Keep delivery classification distinct from custody release and job settlement.
Reconcile verified acquisition/discard before provider activity. Finish
never-forwarded no-output work through `settle_idle_dispatch` under the host
action and IdleCallFence; its dispatch ownership and Store no-output checks
prevent racing a start or discarding success. Skip subsequent recovery only when
presentation is terminal (or absent). Re-read after activity probes: a probe can
release an admission without finishing its job.

Regression coverage must include every writable disposition, terminal job
presentation, cleared consumer/provider busy state, and repeated sweeps without
new revisions or automatic candidates. Model cancellation must leave a real
crash gap before writing Cancelled, and quiescence must test Released admissions
as well as admission-null preparation tombstones. Never-forwarded work settles
as Discarded history, with no provider RPC, paid replay, attention prompt or
completion/error toast.
