# Report submission outlives the dialog

Report Issue closes immediately on Submit. Reopening it reset a component-local busy flag while the relay request was still pending, enabling a duplicate submission. The older report's success also unconditionally cleared the shared persisted draft, erasing any newer text written after reopening.

Submission ownership and in-memory attachment selection now belong to the existing draft state store. A single captured request identity owns pending status until settlement. The store tracks actual text and attachment revisions, so an accepted request clears only the unchanged draft it submitted. Reapplying unchanged fields during an opening effect does not create an edit; changing text and then changing it back does.

A stale completion cannot finish a replacement request. Definite or uncertain failure leaves the current shared draft in place. Reopening restores that current text and image selection, including edits or removals made after a failure, rather than resurrecting a separate older retry snapshot. Images remain only for the window lifetime and never enter localStorage. The reopened dialog can be closed without cancelling the pending request.

Selected-file and clipboard image reads also belong to the shared draft. Submission stays disabled until all reads settle, including across dialog reopenings. Clearing a draft invalidates its outstanding read identities; an obsolete completion cannot attach an image to a replacement draft or end a newer read. Read failures release ownership and show an actionable error instead of silently omitting the selected image.

Independent headless-browser reproduction against the accepted public 1.11.1 source demonstrated both duplicate completed submissions and newer persisted text becoming empty after reload. Regression tests assert a single completed report and the newer draft surviving completion and reload. A corrected desktop binary is required; redeploying the relay cannot change installed dialog behavior.
