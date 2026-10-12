# AI completion identity follows durable bytes

A paid process reply captured in RAM is not a recoverable completion. A host
restart can destroy it. The ordering invariant is stronger and implementable:
no status/hash/length or successful recovery witness is persisted before its
named bytes and directory entries are synced. All capture paths use
`Store::durable_host_completion`, including reply writes, completed-pending
fallback and direct spool sealing. Conflicting repeated replies are rejected
before changing previously identified bytes.

The shared pipe reader tees bounded stdout into a spool file as it arrives.
The existing bounded Output API remains; completion avoids truncating an exact
streamed file and supplies the final durability barrier. Streaming reduces the
RAM-only window but does not promise that unfsynced chunks survive power loss.

The conservation oracle records actual published identities and keeps that
obligation after cleanup/restart. RAM or simulated resurrectable data cannot
satisfy it. Before any identity exists, a capture crash recovers as Unknown and
settles silently without paid replay, delivery, input custody or spool charges.
The pre-persistence test retains paid invocation truth and asserts interruption;
post-identity crash tests still require exact image delivery.
