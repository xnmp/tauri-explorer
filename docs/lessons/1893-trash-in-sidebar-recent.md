# #1893 — Recycle Bin listed under sidebar Recent

**Symptom.** After opening the Recycle Bin (Windows report, all platforms
affected), a `trash://` row appeared in the sidebar "Recent" section, duplicating
the dedicated Recycle Bin row.

**Cause.** #1218 deliberately records `trash://` in the frecency store so Quick
Open can jump to the Recycle Bin. The sidebar Recent list reads the same store
(`frecencyStore.recentEntries`) and its inline filter in `FilesSidebarView.svelte`
only excluded home, roots, bookmarks, Quick Access folders and ejected drives.

**Fix.** The Recent eligibility rule moved to `domain/recent-locations.ts`
(`isRecentLocationListed`), which rejects `isTrashPath` paths. Filtering happens
at read time, so already-persisted `trash://` entries disappear too, while Quick
Open keeps its trash frecency.

**Lesson.** One store feeding several surfaces (Quick Open ranking vs. the
sidebar Recent list) needs per-surface eligibility rules; recording a virtual
location for one surface leaks it into the others unless each filters it.
Test: `tests/domain/recent-locations.test.ts`.
