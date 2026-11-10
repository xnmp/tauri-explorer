# One bad theme file must not hide all user themes (#1595)

`list_user_themes_sync` returned the first per-file error, so a non-UTF-8
`.css`, a dangling symlink or a directory named `x.css` emptied the theme list.
The listing (now `list_user_themes_in(dir)`) shares `read_bounded_css` with the
layouts listing: only regular files, at most `MAX_THEME_CSS_BYTES` (512 KiB,
same as layouts), UTF-8. The file is checked from metadata first, then opened
non-blocking and re-checked on the handle, so a FIFO named `x.css` cannot hang
startup. Anything else is skipped with a `log::warn!` naming the file, as is
any file whose NAME is not UTF-8: lossy conversion could give two files the
same `�.css` name and `data-user-theme`.

A non-blocking open of a leased regular file (Samba, NFS server) fails with
EWOULDBLOCK while the lease breaks. That case retries with a blocking open and
re-checks the type. The test holds a real `F_SETLEASE` write lease from a
python3 child that releases on SIGIO.

`write_theme_file` refuses data over the same limit with an error naming the
file and the limit, so a write cannot succeed for a theme the listing would
then skip.

Results are sorted by filename (byte order). `theme.svelte.ts` injects one
`<style>` per theme in listing order and its discovery keeps the last
definition of a reused theme id, so directory hash order would make precedence
nondeterministic. A missing themes directory is an empty list; a themes path
that cannot be read as a directory still errors, as before.
