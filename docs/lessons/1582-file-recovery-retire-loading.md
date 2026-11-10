# #1582 — reclaiming retained space could leave recovery loading forever

**Symptom.** (Latent; the dialog disabled actions while loading.) A per-item
recovery action started during "Reclaim space" left `loading` stuck true.

**Cause.** `retireEligible` set the shared `loading` flag but fenced its
completion with the resolve request counter. A resolve started meanwhile bumped
that counter, so the reclaim's `finally` skipped clearing `loading`.

**Rule.** A busy flag must be settled by the operation that set it. Reclaim is
now one kind of the store's exclusive `RecoveryOperation` (`reclaiming`, with
its own token) beside `resolving`; each refuses to start while the other runs,
and the public `loading` is derived (listing/subscribing OR reclaiming), so a
refresh finishing mid-reclaim cannot clear it either.
Tests: `tests/file-recovery-state.test.ts` ("reclaim and per-item actions are exclusive").
