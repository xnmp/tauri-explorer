# #781: Fresh-window selection failed before its renderer sampler started

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
