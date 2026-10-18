# #1311 — Remove List peek bounding boxes

ListColumnsView painted each open top-level folder twice: a tinted hairline panel and a fading accent border. Those pseudo-elements made nested file browsing look boxed in.

Remove the two decorative pseudo-elements and their unused fade input. The layout group, nested guide lines, selected/hovered rows, scrolling, resize grip and overflow count retain their existing behavior. The regression failed before the change because both box pseudo-elements generated content; after it, the test verifies they are absent while the group and its controls remain visible.
