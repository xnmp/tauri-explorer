# #781: Sample before native window retirement and fresh selection

In Linux native smoke run `36289184005`, WebDriver waited 20 seconds for fresh
window `explorer-59514741-05f9-4b97-b656-90b33cba1ea8`, then reported that it
never became ready. The next command received `invalid session id`. The retained
`fresh-window` artifacts belonged to earlier successful children: the sampler
in `switchToFreshWindow` began only after the requested label was selected.
Those artifacts cannot classify whether this child's renderer died, its page
never became ready, or the driver lost the session.

Start a bounded, process-only timeline before waiting for a new handle and
label. On selection failure, retain the exact requested label, pre-selection
sample, 500 ms samples during the wait, error, and post-failure sample. Clear
the previous child's selected record at the start so a later lookup cannot
attribute a failure to that child. Stop the timer on success or failure and
keep artifact-writing failure-tolerant. Successful selection and first-element
lookup retain their existing renderer/page and process evidence.

The new record is diagnostic, not proof of a renderer crash by itself: without
successful selection there is no reliable child-renderer PID to attribute.
The next real recurrence must include the failing label's process timeline
and driver log before #781 can be classified.

The original #781 report lost its WebDriver session while the warm lifetime
spec waited for an abandoned claim to expire after its source window closed.
That case now samples all `WebKitWebProcess` PID/start-time identities before
the close and throughout both native-handle waits. If a wait or close fails, a
separate warm-claim artifact records the claimed label and handles, the first
observed disappearance of each baseline renderer, timestamped close/handle
milestones, and a final local process
sample, without making another WebDriver call. These samples do not establish
which WebView owned a renderer; compare the failing artifact with the driver
log before attributing cause. No real recurrence has been classified yet.
