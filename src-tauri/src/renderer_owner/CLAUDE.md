# Renderer recovery rules

macOS and Linux recover a terminated web process through one shared path
(`renderer_owner::on_renderer_terminated`) by reloading the window's last
committed document without `warm` and with `rendererRecovery=1`, under a
per-window budget; parked warm windows are retired instead, and a WebKitGTK
`terminated-by-api` teardown is never reloaded (`renderer_owner/reload.rs`,
#942, #1138). Test harnesses must not reload a crashed WebView themselves; that
would race the product's reload. Never read `WKWebView.URL` after termination
(Wry unwraps a reset URL), and read every one-shot launch query parameter
through `launchRequest` in `domain/window-launch-plan.ts` so a recovered
document restores its session instead of replaying the launch. macOS and Linux
(all webviews, with WebKitGTK's reason) log every loss as
`Renderer(web-content-terminated)`; the startup qualifier never measures a
sample containing it, records and replaces a recovered loss (one main document
booted after it, by boot epoch rather than log order, reaches native-ready
once), and fails an unrecovered loss or more than 3 recovered ones (ADR 0021).
