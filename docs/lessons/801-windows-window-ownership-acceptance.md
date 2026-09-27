# #801 — Windows window-ownership acceptance must execute each outcome

The native transfer-rejection suite already runs without a platform gate. Do
not count the spec file or `describe` block alone: confirm the Windows reporter
lists the unready target, close-after-receipt and duplicate-label test titles as
passing. Runs `36290233317` and `36291741083` executed all three on WebView2;
the five-consecutive-run release gate still requires fresh branch evidence.

Window-transfer waits should correlate one operation token inside the renderer
instead of repeatedly crossing the synchronous WebDriver boundary. Failures
must preserve the strict ownership and watcher outcomes and retain diagnostics;
do not extend ownership deadlines or retry a rejected transfer.
