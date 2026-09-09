# 692: qualify browser focus delivery separately from file-list behavior

Playwright WebKit is an automation proxy for WKWebView, not evidence of native
WKWebView or WebKitGTK behavior. Keep a native-control probe separate from the
file-list composite contract: the probe records delivered keyboard events and
browser default prevention, while the composite test asserts the observable
focus target for each browser engine.

When an engine has a reproduced automation divergence, scope its expected
failure to that engine and retain Chromium coverage. Do not add an application
Tab handler unless the same product regression is reproduced outside that
automation boundary.
