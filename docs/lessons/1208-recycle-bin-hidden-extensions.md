# 1208: Recycle Bin display names are not restore filenames

The first red Rust platforms run followed the in-app Trash merge (#1183),
before the clipboard fixture fix named by the issue. Windows recycled the
fixture successfully, but the listing reported `trash-view-863-<pid>` instead
of `trash-view-863-<pid>.txt`. The native test failed at its original-path
lookup; macOS passed.

`trash::list()` reads `SIGDN_PARENTRELATIVE`, a Shell display name governed by
the user's extension visibility preferences. Its `original_path()` joins that
display name to the original folder. That path is unsuitable for either the
Trash row's original path or collision checks and restore.

Read `System.FileName` (`PKEY_FileName`) from the same Shell item before
projecting the inventory. The item must come from Recycle Bin namespace
enumeration. Reopening its desktop-absolute parsing name loses that namespace:
the Windows qualification of the first fix returned the physical `$R...txt`
payload name instead of the original. Enumerate once and join exact names to
the existing inventory by their opaque parsing identities. Do not infer an
extension from the display name or
the renamed trash payload: repeated extensions and extensionless names make
that ambiguous. If the property cannot be read, report a partial inventory
issue rather than constructing a guessed restore destination. Keep the opaque
Shell parsing identity as the restore artifact (ADR 0019).

The [Windows property contract](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-filename)
defines `System.FileName` to include its extension.

The existing Windows native test is the regression oracle: it deletes a real
file through the production Shell adapter, checks the listed exact name and
origin, refuses an occupied destination, restores the bytes and checks the
item has left the Recycle Bin. It now repeats for `.txt`, `.txt.txt`, no
extension, and a folder containing a file. This stays in the full Windows Rust
suite; no job or test is skipped.

The real native GUI spec now deletes both `.txt` and `.txt.txt` fixtures,
asserts the complete visible names and original locations, captures both rows,
then restores each distinct payload. The Windows manual `trash` scope uploads
the capture plus source provenance in its WDIO artifact for collection into
`evidence/`; a browser mock or an earlier Linux capture cannot prove this fix.
