# #729: PDF pointer capture must preserve link intent

The viewing surface owns the captured drag and link activation together. Consume the last pointer-up movement, suppress activation after movement/cancellation, and preserve a clean starting link until the retargeted click arrives. Normal `lostpointercapture` follows pointer-up; clearing the completed link there breaks ordinary zoomed links. Only an active gesture is cancelled by capture loss.

Page/destination selection belongs to the importable preview store. Advance the intent revision before resolving a destination, including a request for the already-visible page. Race indirect page-index requests against worker failure and cancellation as well as the first destination request.

Native acceptance reaches both initially hidden corners, reverses drag, observes real document focus loss, navigates all three page colors and dispatches an ordinary external link to a disposable installed GTK handler. The handler records/displays the exact URL without fetching it.
