# Minimum video dock acceptance proof

Actual unedited Chromium captures at 150% app zoom. Transport and external-open IPC are mocked; the browser decodes the real fixture. Actual native transport and lifecycle qualification remains recorded in `evidence/970-native-video/`.

- `minimum-bottom-150-one-row-decoded-blue.png`: 1280×720 viewport, bottom dock height 120, decoded 320×180 video paused after seeking to 4 / 6 seconds. All controls share one row and hit the intended elements.
- `minimum-bottom-150-real-decoder-error.png`: the same layout after an actual invalid-container decoder error; ordinary scrolling exposes the complete message and external-open action. Full bounds fit within all clipping ancestors. Clicking dispatches one external-open request and retires the source once.
- `minimum-right-150.png`, `minimum-top-150.png`, `minimum-bottom-150.png`: 800×600 viewport, minimum configured width/height. Decoded seek outcomes; controls in constrained players remain reachable through normal scrolling.
- `minimum-error-150.png`: useful unavailable-source message and fallback in a minimum bottom dock at 150%.

The independent review receipt records decoding pixels, measured geometry, control hit targets and source identities. Both private reviewer browsers closed after capture.
