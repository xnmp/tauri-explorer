# ADR 0026: Git avatar lookup and cache lifecycle

Status: Accepted.

Governs: `src-tauri/src/git_avatar.rs`,
`src/lib/state/git-avatar-cache.ts`.

## Problem

Commit rows may obtain an author image from a remote provider. This introduces
network work, restart-persistent derived files and concurrent requests into a
virtualized view whose primary job is to render Git history. Without an explicit
contract, avatar latency, corrupt cache state or abandoned row work could make
the graph unreliable, disclose ordinary author email addresses unexpectedly, or
let derived data grow without a bound.

## Decision

### Identity and consent boundary

GitHub noreply addresses are provider identifiers and may resolve to GitHub
avatars while avatars are enabled. Ordinary email addresses are sent to
Gravatar only after the separate, persisted Gravatar option is enabled. Cache
file names are the SHA-256 digest of the resolved provider URL; raw author email
addresses are never used as file names.

Avatars are decoration, not commit or identity authority. Every lookup failure
returns no image and the row renders its deterministic local fallback. Graph
loading, scrolling and Git operations never wait for a successful avatar.

### Scheduling and ownership

The frontend deduplicates lookup requests and admits at most four active IPC
calls. A mounted avatar owns one subscription: unmounting cancels queued work
when it has no other subscriber, while an already-started request may finish
within the native timeout. Frontend pending and resolved maps retain at most 256
identities.

The native command independently admits at most four blocking tasks. Cache
inspection, remote fetch and publication are serialized inside the process so
concurrent windows cannot publish or prune the same entry against each other.
The HTTP request has an eight-second global timeout and reads at most 256 KiB.
Cross-process races are allowed to lose cache reuse, but must not affect Git data
or UI availability.

### Validation, publication and restart persistence

A positive entry is accepted only when it is PNG, JPEG or WebP, has non-zero
dimensions no larger than 512 by 512, and is no larger than 256 KiB. It is
written to a sibling temporary file and renamed into place on the same
filesystem. This cache deliberately makes no `fsync` durability promise: it is
cheaply reproducible operational state, not user data.

A failed or invalid remote response publishes a zero-byte negative marker.
Positive entries persist until bounded eviction; negative markers expire after
24 hours so a temporary provider failure can heal after restart. Pruning runs
before lookup and after publication, keeps at most 512 files and 32 MiB, and
removes the oldest modification times first.

### Interrupted, corrupt and unavailable state

Sibling publication files use a `tmp-` extension. A failed writer removes its
temporary file best-effort, and every later prune removes all such interrupted
files before applying entry and byte limits. A corrupt, unsupported, oversized
or unreadable positive entry is ignored and removed best-effort, after which a
normal provider request may replace it.

Directory creation, metadata, read, write, rename, prune and provider failures
all degrade to no image. Cleanup is best-effort: failure to delete derived state
may cost cache space or another request, but never changes commit data, blocks
the graph, or suppresses the deterministic fallback.

## Consequences

Resolved images and provider misses survive application restarts without making
the cache authoritative. Work and storage have explicit bounds at both the row
scheduler and native layers. Because publication is rename-based but not
durably synced, a power loss may discard the most recent cache result; the next
lookup repairs or refetches it instead of exposing an error to the graph.
