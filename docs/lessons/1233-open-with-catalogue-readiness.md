# #1233 — Wait for the Open With catalogue before testing its focus cycle

The Open With chooser exposes Cancel immediately while installed applications
load asynchronously. Cancel receiving focus proves that the dialog is ready to
cancel; it does not prove that application buttons exist yet. The keyboard E2E
pressed Shift+Tab at that point, wrapped from Cancel back to Cancel, then failed
after the catalogue arrived because it expected Alternate Editor to be focused.

The release all-view run and isolated file run hit this in different views. A
control using the existing `__mockControl.latency.list_open_with_applications`
setting at 1200 ms reproduced the original failure before the fix. Its snapshot
at Shift+Tab had only Cancel, `aria-busy=true`, and “Finding installed
applications…”. The original parallel-run phase was not captured, so that exact
occurrence's timing remains inferred.

The existing keyboard contracts now exercise the delayed catalogue in every
view and theme. They wait for the actual Alternate Editor button before testing
the focus cycle, then retain the keyboard launch and exact path/application-ID
outcome assertions. No sleeps, swallowed errors, focus overrides or timeout
extensions are needed. The delayed case fails with the readiness wait removed.
