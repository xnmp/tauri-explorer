# #596 — an optimistic close needs an in-flight signal

## Symptom

Pressing Submit in Report Issue closed the dialog immediately (deliberate —
the relay round-trip can take seconds and holding a modal open for it is
worse), but nothing else appeared until the "Report submitted" toast. On a slow
relay the user got several seconds of *nothing*, indistinguishable from the
click having been swallowed.

## The general shape

Closing a modal optimistically moves the work off-screen. The moment you do
that, the outcome toast is no longer sufficient feedback — it only covers the
end of the operation, and the gap it leaves is exactly the case the user
notices. An optimistic close needs a paired in-flight indicator.

## Fix

`UserReportDialog.submit` shows a `"Submitting report…"` info toast right after
`onClose()`, and retires it by id in the `finally` block, so it is dismissed on
every exit path — success, relay failure, GitHub fallback, and the
draft-retained attachment failures — before the outcome toast is shown.

Three properties worth keeping, two of which the first attempt got wrong and
review caught:

- **It needs its own toast type.** `toastStore.show` *replaces* the existing
  toast of the same type. An in-flight indicator typed `info` is therefore
  deleted by any ordinary info toast — "Refreshed" on F5, or a copy finishing
  in **another window**, which reaches this one through the store's
  `BroadcastChannel`. The user is then back to no indicator at all, i.e. this
  very bug, mid-operation. Hence the `progress` type, which also gets a
  spinning arc instead of the shared checkmark glyph: an in-flight indicator
  must not look like a success indicator.
- **Retire it before each outcome toast, not only in `finally`.** The
  GitHub-fallback path awaits a browser launch *between* showing the error
  toast and returning, so a `finally`-only dismissal leaves both on screen for
  that whole window. `finally` stays as the backstop for paths that return
  without reaching an outcome.
- **A bounded duration anyway** (the `progress` default). The explicit
  dismissal is the normal path; the duration is the backstop for a request
  that never settles, so a hang can't pin a toast for the whole session.

## Guard

`e2e/bug-report.spec.ts`, three tests:

- "an in-flight report announces itself before the outcome toast" injects
  `__MOCK_LATENCY__.submit_user_report` and asserts the toast is up *while the
  mock has not yet recorded the submission*, then gone once the success toast
  lands.
- "an unrelated info toast does not delete the in-flight indicator" presses F5
  mid-flight.
- "a failed report retires the in-flight toast before the error toast" holds
  the browser handoff open with `__MOCK_LATENCY__.open_external_url`.

**The ordering test needs a point-in-time snapshot, not `toBeHidden()`.**
Playwright's web-first assertions auto-retry for 5 s, which is longer than the
3 s handoff — so `await expect(locator).toBeHidden()` passed against the buggy
ordering by simply waiting for `finally` to run. One `page.evaluate` returning
all three facts at once is what actually pins the interval. Any assertion
about state *during* a window has this trap.
