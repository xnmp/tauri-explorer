# Lessons — one file per issue

Gotchas, non-obvious behaviors, and key takeaways from closed issues. One file
per issue, named `<issue>-<slug>.md` (e.g. `544-per-issue-lessons.md`), written
on the branch that fixes the issue.

**Why per-issue files:** every branch used to append to the shared
[`../lessons_learnt.md`](../lessons_learnt.md), so every merge to `dev`
conflicted every open PR at end-of-file — each landing forced a rebase, a
re-review, and a full CI re-run on every other branch (#544). Distinct files
cannot conflict. `merge=union` was considered and rejected: GitHub's
mergeability check ignores merge drivers.

Conventions:

- **Write** `docs/lessons/<issue>-<slug>.md` when you fix a bug or learn
  something non-obvious. Same content style as the archive: what bit you, why,
  and the rule that prevents it next time. A few lines is plenty; skip the file
  entirely if the issue taught nothing non-obvious.
- **Search** with `grep -ri <term> docs/lessons/ docs/lessons_learnt.md` — the
  old shared file is FROZEN as an archive (still searchable, never appended).
- No index file to update — the directory listing is the index (an index file
  would just recreate the shared-append conflict).
