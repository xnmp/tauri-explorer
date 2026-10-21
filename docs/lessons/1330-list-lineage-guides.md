# List peeks draw the top-level lineage guide too (#1330)

When #1311 removed List card boxes, only nested groups (`depth > 0`) kept a
guide line; the open top-level folder's own children lost their lineage cue
that Details draws for every level. ListCard and `fullFlowGuideSpans` now
include depth-0 groups. Guide x offsets come from `listGuideLeft` and the
accent fade from `peekGuideFade`, shared with Details' `PeekGuides`, so the
views cannot drift.
