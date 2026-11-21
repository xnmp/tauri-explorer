# `readTextFile`'s limit refuses, it does not truncate (#1884)

`readTextFile(path, maxBytes)` (`read_text_file`) rejects any file larger than
`maxBytes` with "File too large"; it never returns the first `maxBytes`. A
caller that wants "the first 2 KB" and passes 2048 gets nothing for every text
file over 2 KB. AI rename's content hint does exactly that today, so its hint
only reaches files of at most 2,048 bytes.

A caller that wants an excerpt must skip the read for files it knows are too
large (no IPC that is certain to fail) and cut the text itself after reading a
file that fits. A real head read would need a bounded native command.

This is one reason AI columns (#1886) do not paste file content into a prompt
at all: the folder-agent mode of the AI service (`ai_agent_run`) starts a CLI
in the folder with read-only file tools, and the model reads what it needs.

A dev server that served a branch through many edits (HMR) failed
`e2e/plugin-file-view-eligibility.spec.ts`, which patches modules by URL; the
same tree passed after restarting the server. Restart before trusting a failure
in specs that `page.route` source modules.
