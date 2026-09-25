# Cold recovery admission must retry the authority entry before probing emptiness

Two independent runtimes can initialize the same recovery root concurrently.
One runtime may observe `admission.lock` as absent, then lose the race while the
other runtime creates the gate, catalog, owner directory, and database.

The losing runtime previously called `Directory::names(1)` before reopening the
gate. That API deliberately rejects a directory containing more entries than its
limit, so a successfully initialized root produced `Directory exceeds its entry
limit` instead of joining the existing admission domain.

After an initial `NotFound`, retry the exact retained-handle gate lookup first.
Only when that second lookup also returns `NotFound` may initialization probe
whether the root is empty and create the gate. If the bounded probe observes a
nonempty root or exceeds its limit, reopen the gate once more because publication
may have raced that probe too. A still-missing gate fails closed, and other
lookup errors propagate. This ordering admits a competing initializer while
preserving unexplained populated roots and missing or substituted gates.

The regression test pauses the losing initializer immediately after its first
gate miss, completes initialization and acquires a claim through a second
coordinator, then resumes the loser. It verifies both coordinators retain their
independent claims by showing that a third coordinator cannot acquire either
resource.
