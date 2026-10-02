# #730: Own the PDF worker and await library cleanup

Lazy PDF.js canvas rendering replaces platform iframe toolbars with Explorer's own page, fit, zoom and fullscreen controls. Load local bytes through a bounded regular-file Rust read and start an explicit packaged module Worker. Passing that port to PDFWorker avoids opaque-origin blob wrappers or fake-worker fallback; native worker readiness is observed before parsing. Offline font/CMap resources are prepared for dev/build.

Svelte effects must subscribe to the selected path, not imperative preview-store lifecycle reads. An untracked open boundary prevents a self-subscribed state update loop. Key the loaded preview by its captured revision, not a changing live selection key, to avoid a transient duplicate read on refresh.

Cancellation immediately rejects pending publication/render work. Keep the worker port alive until the public PDF.js destruction promise acknowledges its Terminate handshake and clears document FontFaces/filter resources, then terminate it. Killing the worker first leaves that cleanup pending and leaks a FontFace on every document. Repeated real-renderer open/close tests assert fonts return to zero, not merely a terminate receipt. Observe the combined cancellation/failure promise even before any page operation, and recheck cancellation after worker readiness before starting parsing.

Navigation errors must hide the opaque rendered page so it cannot paint over the alert. Native Linux rendering is verified; browser WebKit results do not establish native macOS or Windows support.
