# #704 — Navigation completion does not imply final visual visibility

The native directory-error fixture acknowledged the completed navigation, then
sampled `isDisplayed()` once. FileList renders errors with a 300 ms entrance
animation whose initial opacity is zero. WebKit's visibility predicate correctly
includes opacity, so a fast lookup can find the error node with `display: flex`
but still report it invisible. In CI, those events occurred within 10 ms of the
navigation acknowledgement; the real backend had returned permission denial.

Use an eventual visibility assertion for the user-visible outcome, then verify
the exact error title, message, retained location and permission-recovery listing.
Do not treat a navigation acknowledgement as an animation-completion contract,
remove the production animation to satisfy a fixture, or increase timeout budgets.
Capture screenshots only after the asserted surface is visible.
