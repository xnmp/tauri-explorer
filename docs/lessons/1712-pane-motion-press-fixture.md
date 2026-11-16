#1712: wait for the existing List viewport before a held-gesture test

The CI browser bundle resolves runtime imports immediately. The held-pane
fixture split before List's first ResizeObserver delivery, when its viewport
model still had zero dimensions, four rows per column and only two mounted
overscan columns. No file existed at the requested press point, so setup failed
before any input was dispatched. Dev-server import latency had hidden this.

Await the initial paint/observer delivery before splitting the existing pane.
Keep physical press coordinates and all held-size, selection and settlement
assertions unchanged. The exact CI bundle reproduced both List failures;
this readiness-only change passed all twelve plain/Ctrl cases across Details,
List, Tiles, Chromium and WebKit. No application runtime change was needed.
