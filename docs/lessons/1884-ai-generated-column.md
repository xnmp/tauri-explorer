# AI-generated columns: `readTextFile`'s limit refuses, it does not truncate (#1884)

`readTextFile(path, maxBytes)` (`read_text_file`) rejects any file larger than
`maxBytes` with "File too large"; it never returns the first `maxBytes`. A
caller that wants "the first 2 KB" and passes 2048 gets nothing for every text
file over 2 KB. AI rename's content hint does exactly that today, so its hint
only reaches files of at most 2,048 bytes.

AI columns therefore skip the read for text files over 32 KiB (no IPC that is
certain to fail) and cut the excerpt to 2,048 characters after reading. A real
head read would need a bounded native command; until one exists, larger text
files are described by name, type, size and date only.

Two smaller traps from the same work:

- The plugin storage file is shared by every window, each running its own
  plugin instance. Writing an in-memory snapshot lets a stale window erase a
  column another window added; `ai-columns/column-store.ts` re-reads the file
  and applies only its own change.
- A dev server that served the branch through many edits (HMR) failed
  `e2e/plugin-file-view-eligibility.spec.ts`, which patches modules by URL;
  the same tree passed after restarting the server. Restart before trusting a
  failure in specs that `page.route` source modules.
