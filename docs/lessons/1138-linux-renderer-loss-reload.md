# #1138 — A crashed Linux renderer left a blank window until restart

WebKitGTK does not reload a page whose web process died, any more than
WKWebView does (#942). Linux logged the loss and retired the generation, but
never reloaded: the `e2e-renderer-recovery` harness reloaded its retained
WebView itself, and a product reload would have raced it. So a GC abort
(#1026), an OOM kill or a memory-limit kill left the window blank.

Both ports now go through `renderer_owner::on_renderer_terminated`: log the
loss, retire the generation, then `WindowRecovery::on_terminated` in
`renderer_owner/reload.rs` decides under the shared budget (3 reloads per
60 s per window) and restores the committed document with
`rendererRecovery=1`. On Linux the committed URL comes from Wry's `Committed`
load event, which Tauri reports as `PageLoadEvent::Started`.

Traps:

1. **`terminated-by-api` is not a loss.** WebKitGTK reports it for
   `webkit_web_view_terminate_web_process`; whoever tore the process down
   owns what comes next. It is retired but logged as
   `decision=none cause=terminated-by-api` at info level, and it spends no
   reload budget. Everything else (crash, memory limit, unknown future
   reasons) is recovered.
2. **Two Linux listeners retire the generation.** The all-webview plugin is
   connected at webview creation and runs first; `termination.rs`'s lazy
   listener (the session-acknowledgement coverage guarantee) then advances
   again. The extra advance only skips an unused generation number, so the
   listener stays as the coverage proof rather than being folded in.
3. **The harness must not reload.** It now waits for the product's
   `Renderer(recovery) … decision=reload` line and the marked document. Its
   file-recovery check ("old channel dropped before the replacement
   registered") still holds because the drop happens on retirement, while the
   replacement registers only after the new document boots.
4. **The restored path can lag.** A recovered document restores the window's
   persisted tabs, and navigation alone persists them only on the 30 s safety
   save; a crash cannot run `beforeunload`. The harness therefore asserts the
   restored committed document and a working pane, not an exact path.

The effects (navigate, retire a parked window, log) sit behind
`RecoveryEffects`, so the decision-and-apply path is unit-tested with recorded
effects; only the Tauri adapter (spawned navigation) is covered solely by the
native harness.
