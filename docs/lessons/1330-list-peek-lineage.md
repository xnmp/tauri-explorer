# List peek lineage

List cards must render the outer open folder's guide as well as nested guides,
matching Details. The existing List geometry test must measure the nested guide
against the nested caret, rather than assuming it is the first guide.

No domain interface changes are needed: the card already receives the outer
folder's group. Browser tests cover the rendered guides and screenshot evidence
must scroll the card far enough to show the nested children.
