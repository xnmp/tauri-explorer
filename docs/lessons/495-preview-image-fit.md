# Preview image flex sizing (#495)

The normal image preview is a flex item inside the scrollable preview content.
Without `min-height: 0`, a tall image can impose its intrinsic minimum height
on that item, making the surrounding preview scroll instead of allowing the
image's `max-height` and `object-fit: contain` rules to fit it. Browser
coverage should create a tall rendered image and assert both zero content
overflow and image containment, because a CSS-source assertion cannot exercise
the flex sizing negotiation that causes the regression.
