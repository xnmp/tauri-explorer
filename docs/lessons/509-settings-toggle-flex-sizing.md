# Settings toggle flex sizing (#509)

Settings rows pair free-form, wrapping descriptions with a fixed-size custom
toggle. In a flex row, `width` alone does not preserve the control: the toggle
can shrink when its sibling has a long description, collapsing the track while
its thumb remains visible. Give the control a non-shrinking flex basis and let
the text container shrink (`min-width: 0`) so it wraps instead.

Browser coverage for this kind of visual defect should measure the rendered
control width at the settings seam. A source-level CSS assertion would miss
flex layout negotiation, which is where this regression occurred.
