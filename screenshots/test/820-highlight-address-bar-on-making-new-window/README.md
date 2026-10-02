# #820 native acceptance screenshots

All 21 images are unedited captures of the real Linux/WebKitGTK Tauri app,
100% app zoom, on private Xvfb/Openbox with isolated D-Bus/XDG. Neither the host
desktop nor its clipboard was used. `provenance.json` records the exact application
source, binary, test bytes and image hashes. The refreshed capture binary includes
the strengthened pre-switch focus and held-window visibility assertions.

Each `*-complete-path-selected.png` shows the address ready for replacement.
Each paired `*-typed-directory-navigated.png` shows the real replacement directory
and its `replacement-proof.txt` file after immediate key input and Enter.
Fresh, warm, actual Ctrl+N, Command Palette, vertical detach, desktop tear-off and
Ctrl+Shift+T closed-window restoration are covered. Native assertions observe
active-window identity before switching the WebDriver context, full selection
bounds, exact typed path and unchanged source-window selection.

`fresh-first-response-*` captures follow a deliberately held real native listing
response: no premature address input mounts before its release.
`warm-held-navigation-*` follow real warm-window navigation before reveal/focus.
`fresh-late-validation-late-reply-preserved-typing.png` shows the newly published
`late-validation-proof.txt` marker while the address still contains the typed
replacement path and end caret. The gate holds the decoded real reply before UI
publication; it does not synthesize backend data or delay by an arbitrary timeout.

The tear-off/restoration windows are 900 × 600 and long fixture paths clip visually.
Exact full selection and caret offsets are proved by native assertions, rather
than by inferring them from screenshots. Ten native cases pass in 19 seconds.
The native trace records all ten launched paths, active native windows, selection
ranges and replacement directories. The fresh CLI hooks/custom-protocol build
and native TypeScript pass. A fresh production build and hook-leak guard also
pass against the current dev dependencies, as recorded in the review;
the startup timing difference between the hooks
binary and a release binary remains an explicit limit.
