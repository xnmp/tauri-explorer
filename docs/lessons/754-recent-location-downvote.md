# #754: dismiss Recent rows without discarding their ranking history

The sidebar removed the complete frecency entry, while Quick Open already had a
soft downvote. Reuse that reduction and persist Recent dismissal on the surviving
entry. The sidebar projects only eligible entries; ranking can still use the
reduced history. A qualifying file action clears dismissal and adds a fresh access,
so browsing does not resurrect old history and removal is not a permanent blacklist.
Single-access histories naturally disappear; repeated removal reaches zero safely.

Keep the canonical directory key at both score-map construction and lookup. Raw
Windows path strings otherwise miss their case/separator-normalized ranking key.

Verify the store with a fixed observation time and reload from persistence. Drive
actual sidebar removal, revisit, reload and file preview in all three views. A
screenshot proves row visibility; production score assertions establish the
downvote. Browser reload reuses the launch URL, so explicitly revisit the intended
directory before asserting a qualifying file action.
