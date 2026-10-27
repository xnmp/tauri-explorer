# Video volume control: a pop-up that never moves the controls row

The speaker button replaced the "Sound" text button and always-visible slider
(#1425). The first version revealed the slider inline by growing its width on
hover. That moved the speaker under the pointer between `pointerdown` and
`pointerup`: headed WebKit (CI's Xvfb run) delivered the release to the
slider, so the click landed on the common ancestor and never muted. Headless
runs passed. A control revealed on hover must not change the layout of the
thing being hovered.

The slider is now an upright pop-up above the speaker (`position: fixed`, so
the scrollable player cannot clip it). Fixed offsets scale differently under
root zoom, the fullscreen pane's inverse zoom and each engine, so
`domain/anchored-popup.ts` solves the offset from the pop-up's measured
response to a known offset instead of modelling each case. It is a horizontal
range rotated -90deg: rotation draws and hit-tests the same everywhere, while
vertical writing modes on range inputs need recent engines. Its transparent
bottom padding bridges the hover gap. The speaker sits beside Play in the
transport row, so the pop-up opens over the picture, not over Fullscreen.
Browser and native specs reveal it (hover `.volume`, or `revealVolume()`)
before using it, and exclude it from pane-containment checks.

`volumechange` is queued and, under load, can trail several inputs. Rendering
only from that event left the slider at 0 after a quick mute/unmute, and
stepping from the stale rendered state repeated the first toggle. Derive every
change from the live `<video>` element and sync the rendered state right after
writing it; `volumechange` remains the path for external changes.
