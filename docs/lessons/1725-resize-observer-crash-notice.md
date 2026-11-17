# ResizeObserver loop notices are not crashes (#1725)

Browsers raise "ResizeObserver loop completed with undelivered notifications"
(Chromium's older wording: "loop limit exceeded") as a window `error` event
when a resize callback changes layout. The file grid does that deliberately
(#1061), so every such event was recorded as a crash file and the next window
showed a false "crashed last time" notice.

Fix: `isBenignBrowserError` (`domain/crash-report.ts`) names these notices and
`installGlobalErrorHandlers` (`api/crash.ts`) drops them before logging or
recording. Match the whole message, not a substring, so a genuine error that
merely mentions ResizeObserver still records.

Do not remove layout writes from ResizeObserver callbacks to silence it; some
are deliberate same-frame updates. Regression: `tests/api/crash-handlers.test.ts`.
