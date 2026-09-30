# 853 — Measure marquee bounds after zoomed layout fits the viewport

The all-view Chromium sweep passed 1,211 cases and failed the marquee geometry contract once with a 192.71875px right-edge difference. That run remains a failed sweep; isolated reruns do not replace it.

At 130% root CSS zoom, Chromium can briefly report the content width from the previous layout: x=313, width=1199.1875. The test then chooses endX=1472.1875 outside its 1280px viewport. Layout settles to content width 966.484375, and the application correctly clamps the band to 1279.46875. The difference is exactly 192.71875px. All five filenames remain selected.

The observed transient-bound control reproduces the same difference on the candidate and accepted baseline. Wait for the current content to fit the viewport before measuring entry and drag bounds, then assert both drag endpoints are inside the visible pane and viewport. Keep the 12px alignment tolerance and verify exact selected filenames. An 80ms wait after dragging cannot repair a cursor target computed from stale geometry; increasing tolerance or removing application clamping would hide the invalid test precondition.

Scoped verification covered Chromium and WebKit, plus the measured transient bounds supplied once to the corrected test's geometry read. This is browser test readiness maintenance, not physical-desktop or full-suite qualification.
