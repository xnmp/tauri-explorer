# A full-flow List run needs a Less at its far end (#1329)

The full-flow stage's only Less lived in the folder header. Flowing 80+
children spans several columns, so once the user scrolled sideways to the end
of the run the header (and its Less) was virtualized away and nothing led back
to the scrollable column. `buildListStructure` now emits one `less:<path>`
slot after a full-flow group's last row (`ListTopItem.lessFor`). It holds a
slot but no entry, like a status row, so keyboard navigation, selection and
column virtualization skip it through the existing null-entry paths.

Activating either Less reveals the header's new placement and focuses it
after the layout commits: the trailing Less unmounts with its slot, so focus
cannot stay on the control that was pressed.
