# .gitignore entries must be escaped and anchored (#1591)

`add_to_gitignore` wrote the raw path: `#x` became a comment, `!x` a negation,
`f[1].txt` a glob (ignoring `f1.txt` instead), trailing spaces were dropped, and
`cfg.json` also ignored `sub/cfg.json`.

Entries are now `/` + the path with `\ [ * ?` backslash-escaped and trailing
spaces escaped (only what gitignore(5) makes special: `]` cannot close a
bracket an escaped `[` never opened; tabs, leading spaces, `$ ( ) { } ^ ~ ' "
% & ; | < > = @ + ,` are ordinary, verified with `git check-ignore`); the leading `/` anchors to the `.gitignore` directory and also
makes a leading `#`/`!` literal. A trailing `/` in the input means directory and
is kept (the archive action writes `/.archive/`). Idempotence accepts the anchored
line or a legacy unanchored one. The entry must be a `literal_repo_path`
(`../x` used to be written as `/../x`); on Unix `\` is a name character and is
escaped, on Windows it is rejected like every non-`/` separator. Tests verify with real
`git check-ignore`. The returned string stays the plain path for the toast.

Newlines in an entry are rejected: they would inject extra patterns.

"Already present" is decided by order, not membership: an exact line that a
later `!` line negates (`plain.txt` then `!plain.txt`) does not ignore the path,
so a winning anchored line is appended (git's last matching rule wins). Any
later negation counts, which can only cause a redundant append, never a false
"Added". Residual: a negation in a deeper `.gitignore` still overrides the root
file; the action only writes the root file.

The file is read as bytes. `read_to_string(..).unwrap_or_default()` turned a
non-UTF-8 or unreadable `.gitignore` into "" and the write then replaced the
user's whole file with our one line; now non-UTF-8 content is appended to and a
read error is returned.

A symlinked `.gitignore` is refused with an error and never written through
(it could name any file, e.g. `~/.bashrc`; git 2.32+ ignores such a file
anyway). The file is opened once with `O_NOFOLLOW` (Windows:
`FILE_FLAG_OPEN_REPARSE_POINT` plus a handle check), read and appended to
through that handle; a missing file is created with `create_new`, which never
follows a link. Appending (rather than rewriting the whole file) also keeps an
edit made between the read and the write.
