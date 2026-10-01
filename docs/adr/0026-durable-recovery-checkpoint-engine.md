# ADR 0026: One checkpoint engine for durable recovery kinds

Status: Proposed. Linux only, like ADR 0020 and ADR 0023.

Governs: `src-tauri/src/files/recovery/checkpoint.rs`,
`src-tauri/src/files/recovery/retention.rs`,
`src-tauri/src/files/recovery/retirement.rs`,
`src-tauri/src/files/recovery/durable_model.rs`,
`src-tauri/src/files/recovery/move_model.rs`,
`src-tauri/src/files/recovery/service.rs`.

Amends [ADR 0020](0020-durable-file-recovery.md) (record formats) and
[ADR 0023](0023-recovery-artifact-retention.md) (retirement state machine).

## Problem

Durable move (#744) was built as a parallel copy of durable copy replacement.
Each kind had its own:

- phase enum;
- transition function;
- retention policy;
- retirement implementation;
- branch in every caller that matched on the kind (#874).

The two kinds also modelled retirement differently. Replacement used
`DiscardIntent` / `Discarded` phases. Move used a side-car decision with one
step per root. Trash and permanent delete are the next durable candidates, and
each would have copied the whole set again.

## Decision

### A write-ahead checkpoint with a pure core

Recovery keeps ADR 0020's write-ahead discipline:

- A journaled intent precedes every filesystem effect, and a journaled
  completion follows it.
- Effects are idempotent.
- A resumed operation works out its next step by observing both endpoints,
  not by trusting the phase label. This is redo by reconciliation, as in
  ARIES-style recovery and controller reconcile loops.

What changes is the structure around that discipline. One pure transition
function serves every kind: a reducer from `(spec, checkpoint, event)` to the
next checkpoint. The native executors are the imperative shell around it.

**`Checkpoint<'a, K: DurableKind>`** pairs an immutable spec with the one
persisted `State`. Its methods are the whole pure engine:

- `validate`;
- `next`, the transition function, which validates its result before the
  result can be journaled;
- `disposal`;
- `completed`;
- `retention`;
- `expected_payload`.

**`State`** has the same fields for every kind:

- `phase`;
- `preflight`, the capability probes;
- `effect_revision`;
- the observed `roots`, one per side (source and target);
- the `staged` payload;
- `retained_bytes`;
- `retirement`;
- `deferred`;
- `error`.

**`Phase`** is a single enum shared by all kinds. Each effect owns an intent
phase and a completion phase. The effects are `Root`, `Manifest`, `Stage`,
`Displace`, `Publish`, `Park`, `Restore` and `Reapply`. `Begin(effect)` and
`Complete(effect)` are the only events that change the phase. `Rooted` and
`Staged` complete their effect and carry the evidence they observed.

**One legal-transition graph** decides which effect may begin from which phase.
A kind's `Shape` only removes edges that kind never takes. The shape says
whether the kind stages a copy, overwrites a destination, parks its source, or
can be reapplied. Rootedness comes from the kind's planned roots. Copy
replacement is `{stages, overwrites, reapplies}`. A move derives its shape from
its strategy and whether it overwrites.

**Content effects** (`Publish`, `Park`, `Restore` and `Reapply`) advance
`effect_revision` when they complete. They check that the revision has headroom
before their intent is journaled.

**Field resets:**

- Any phase change clears `retained_bytes` and `deferred`.
- A completion clears `error`.

**Retirement locks the record.** Once a discard decision is journaled, only
retirement events, measurement and error reports are legal. Neither forward
nor inverse execution may run.

### Adding a kind means implementing a trait

Each spec type implements `DurableKind`. A kind supplies:

- its shape;
- its planned roots and preflight probes;
- the user objects an artifact may never alias;
- its spec validation;
- its restored disposal;
- the public endpoints that retirement must observe;
- the witness for automatic disposal;
- the path it is listed under.

Callers dispatch through `OperationSpec::kind()`. A new kind needs one spec
type, one `DurableKind` implementation, one `OperationSpec` variant and its
native executor. The transition, retention and retirement code does not change.

`service.rs` is generic over the trait. Each kind's executor-specific
reconciliation lives in its own handler: `move_recovery.rs` or
`replacement_recovery.rs`.

### Retirement is always the side-car

Every kind now retires the way moves did, so ADR 0023's move rules apply to
replacement too. `DiscardIntent` and `Discarded` are removed.

During retirement the phase stays at its settled position, and `retirement`
carries:

- one decision, automatic or explicit;
- a `Pending -> Removing -> Removed` step for each planned root, in
  source-then-target order;
- the exact descendant plan of each pending root;
- `completed`.

A replacement's single root is its target-side root.

One `Retirement` implementation serves every kind. It covers:

- plan capture;
- read-only preflight;
- verification before the decision;
- journal headroom;
- verification after the decision;
- withdrawal of a decision that removed nothing;
- per-root removal;
- deferral of an automatic discard that cannot start;
- measurement;
- Forget.

### Behaviour changes for copy replacement

Each of these is the existing move contract, now applied to replacement:

- **Exact removal.** Removal deletes the exact planned payload, the manifest
  and the root. It no longer sweeps the root, and an unplanned child preserves
  everything.
- **Withdrawal.** A refusal after the decision but before any removal now
  withdraws the decision and keeps Undo. ADR 0023 listed this as follow-up.
- **Refusal before journaling.** A removal the user cannot perform, such as
  one denied by permissions, is refused before anything is journaled.
- **No restoration under a decision.** While a decision is journaled,
  restoration is not legal. It becomes legal again only after the decision is
  withdrawn.
- **Forget.** Forget now applies to a stopped replacement discard, as it does
  to a move.
- **Measurement.** Retained bytes count the payload children, not
  `manifest.intent`.
- **Deferral.** An automatic replacement discard whose root cannot be observed
  is deferred until the user retries it. This replaces re-claiming it on every
  pass.

The user sees a different view only in situations that are new: a stopped
discard (with Forget) and a deferred automatic discard.

### Record version 3, no migration

Every kind's intent is record version 3, and every checkpoint uses the unified
`State`. Versions 1 (copy) and 2 (move) are rejected, not migrated, because
neither feature has shipped in a release (ADR 0020, #880).

A leftover record fails decoding and fences Linux admission, exactly as a
version-1 move intent does; ADR 0020's manual-recovery note applies.
`ReservationRecord`, which default builds write, is unchanged.

## Consequences

- Transition, retention and retirement each have one implementation. They are
  tested once, and the tests are parameterized over both kinds where the
  behaviour is shared.
- Kind-specific native effects stay behind the kind's executor and its
  recovery handler. These are the replacement transfer, restore and reapply
  adapter, and the move relocation adapter.
- Durable development profiles must discard or manually remove records written
  before ADR 0026.

## Follow-up

- **Bound replacement's retained payload at admission.** Copy replacement does
  not yet check, before promotion, that the original it will displace fits the
  bounds of a cleanup plan. A tree too large to plan makes its record
  undiscardable until it shrinks. The old root sweep had the same depth and
  entry bounds, so this is not a regression.
