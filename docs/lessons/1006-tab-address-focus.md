# #1006 — Launch address-bar focus replayed on tab activation

Fresh windows carry `focusAddressBar=1` in their launch URL. Reading this request
in `NavigationBar.onMount` replayed it whenever tab creation or activation
mounted another navigation bar. The URL outlives each pane component.

`startWindowSession` now delivers the launch request once, after the page reports
settings and initial listing readiness. Settings can remount the pane during
loading, so early delivery would lose a component-local pending request.
Session disposal revokes an undelivered request. The shared deferred-focus owner
also retires it on a newer keyboard/pointer interaction or blur and checks the
initial explorer identity, so slow startup cannot focus a subsequently opened
tab. `NavigationBar` still waits for the initial directory before entering
edit mode and handles explicit Ctrl+L and warm-window activation requests.
Renderer recovery continues to suppress launch requests via `launchRequest`.

Regression coverage starts with a fresh-window URL and verifies tab creation,
mouse activation, keyboard activation, file-list keyboard navigation, and
explicit address-bar focus in Details/List/Tiles. The pre-fix tests reproduced
the replay in every view; startup and delayed-initial-path selection still pass.
