# Preview image pan compositing (#635)

Fullscreen image panning updates the preview image's transform on every pointer
move. On WebKitGTK, leaving that element on the ordinary paint path makes a
large image feel laggy even though the pan math is correct. Scope
`will-change: transform` to the actively `.zoomed` image: it promotes only the
image being manipulated and lets the browser release the extra layer when the
preview returns to fit zoom.

Browser coverage should exercise the rendered image: zoom, drag, assert the
transform changes, and check the computed compositor hint. A CSS-source check
does not prove the rendered preview receives the rule.
