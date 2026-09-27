# #745: Native fixtures must outlive the application session

Windows run 35830489853 attempt 2 passed the window maximize/restore and navigation
assertions, then failed `after all` with EBUSY removing its directory fixture.
Five retries did not resolve it. The application was still alive and displaying
the directory; the exact retaining handle was not established by that log.

Allocate the window-chrome fixture inside the existing native run cleanup root.
Each worker's `afterSession` awaits application/driver termination; the launcher's
`onComplete` then removes the root and its fixtures. Do not recursively remove an
active application's fixture from a Mocha `after` hook or conceal removal errors.
The feature assertions remain unchanged. Cleanup failures still reach run
completion through the existing failure markers.

Lifecycle contracts check that fixture bytes exist during process teardown and
that run completion actually removes them. The Windows native CI result remains
the platform acceptance gate; a Linux unit test does not reproduce Windows locks.
