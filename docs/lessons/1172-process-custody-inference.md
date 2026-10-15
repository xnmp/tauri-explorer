# Process custody must be explicit, never inferred from unreleased admissions

`host.process.run` used to bind a run without `consumerPackageId`/`operationId`
to every admission of the calling provider whose phase was not `released`, and
to refuse it when there were several, or when the only one was inactive.

"Not released" is not "live". Unknown outcomes are settled by releasing
execution (`exec_released=1`) and dismissing them, but their admission stays
`terminal` forever as no-replay evidence. One cancelled-after-dispatch test
generation therefore refused every later Codex login check and image turn: alone
it was inactive, and beside the new generation's own operation it made custody
ambiguous. Two concurrent Codex generations were refused the same way.

Rules:

- Operation work names its operation explicitly; the provider knows it. A run
  without custody is unbound. Never guess ownership from ledger state that has
  terminal-but-retained rows, because retention is not activity.
- Advertise new request fields with an `initialize` capability
  (`processCustody`): hosts refuse unknown fields, so providers must detect it.
- Keep a refusal's cause. `backend.rs` replaced every reservation error with one
  generic sentence, which hid that the real cause was a days-old settled
  operation. Custody refusals now carry a typed code and a user-facing reason.
- Decide custody from one read inside the reservation transaction. Explicit
  custody became the normal path, and a provider's first run can race the
  host reconciling its start reply (Forwarding -> Accepted); comparing a
  pre-transaction snapshot with the in-transaction row refused live runs.
- Reproduce with the user's ledger state in a `Store` test
  (`settled_unknown` in `host_spools.rs`), not with fresh forwarded admissions
  only: every earlier custody test used live operations.
