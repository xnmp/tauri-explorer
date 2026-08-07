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

Two properties worth keeping:

- **Dismiss by id, in `finally`.** The success toast is a different toast
  *type*, and `toastStore.show` only replaces same-type toasts, so nothing
  retires the pending one implicitly.
- **A bounded duration anyway** (`SUBMITTING_TOAST_MAX_MS`). The explicit
  dismissal is the normal path; the duration is the backstop for a request
  that never settles, so a hang can't pin a toast for the whole session.

## Guard

`e2e/bug-report.spec.ts` — "an in-flight report announces itself before the
outcome toast" injects `__MOCK_LATENCY__.submit_user_report` and asserts the
info toast is up *while the mock has not yet recorded the submission*, then
gone once the success toast lands. A companion test covers the error path.
