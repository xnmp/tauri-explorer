# Acknowledge GTK file data without another pointer motion

The Linux native smoke run failed waiting for the receiver Drop in the Tiles
permanent-peek case at GTK scale 2; the native source had been accepted. The
preceding version-only PR did not change drag behavior, and the baseline suite
also passed locally, so reverting that PR would not resolve the timing defect.

The receiver had an acknowledgement gap: `drag-motion` cannot acknowledge file
transport until asynchronous URI data arrives, while `drag-data-received`
previously only published Enter and stored paths. If data arrives after the
last motion, a stationary release has no native Copy acknowledgement. Negotiate
in the accepted filesystem Enter callback too, retaining the same Copy-only
policy and all context/timestamp admission checks. Non-file URNs still use DOM
transport; rejected callbacks must not acknowledge.

`tests/helpers/platform-drag-intent.ts` compiles the production GTK callback
bodies with inert adapters. Its delayed-selection regression sends the final
motion before URI receipt and asserts the native status call without another
motion; it fails on the old callback. The real native file-drag suite separately
checks exact-session receiver Drops, filesystem contents, permanent-peek
visibility, copy intent and cancellation. Do not replace those outcome checks
with a longer timeout or a retry.
