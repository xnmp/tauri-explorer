# Recursive search watching must not own the navigation lock (#1028)

v1.11.5 slow-load records proved that three local directories waited 48–66
seconds in `watch-lock`; their actual listings completed in under 1 ms. Quick
Open had started recursive observation of the home directory. Linux notify
synchronously walks the tree and registers watches, including hidden package
caches, before returning. Permission and watch-capacity failures therefore can
arrive after a long traversal. Separate Observation instances do not isolate
latency when they still share the directory lease mutex.

The recursive Observation now owns its native registration, removal, rebuild
and retry work on a dedicated worker. The direct lease mutex submits a search
registration ticket and is released before waiting for it. Direct maintenance,
final lease cleanup, and change-event delivery never execute recursive OS work.
The worker publishes read-only coverage that retains Source's live atomic fault
state; copying a healthy boolean would hide a callback fault until publication.

Final lease release revokes demand synchronously and advances the cache epoch,
while physical removal waits for the worker. Ordered commands and distinct demand
identities fence a late registration from a release/reacquire of the same path.
Surviving overlapping roots still use Observation's existing reconstruction and
epoch rules. Due recovery runs even when new commands keep arriving.

The regression test gates recursive registration, then requires another folder's
actual entry list before releasing the gate. It failed on the original shared
mutex implementation and passes with isolation. Additional gated tests cover
release/reacquire, old cache-publication tokens and callback faults; the existing
real streaming watcher contract covers recursive descendant delivery and overlap.
Native screenshot acceptance uses an explicitly released, bounded worker gate in
hook builds only, on a private display and isolated profile.
