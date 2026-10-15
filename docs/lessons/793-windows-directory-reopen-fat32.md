# #793: reopening a Windows directory must not depend on file IDs

`Directory::names()` gives each enumeration its own cursor by opening a second
file object on the retained directory. `ReOpenFile` rejects directory handles
(#772), and `OpenFileById` fails on FAT with STATUS_NOT_IMPLEMENTED because
FastFAT's file IDs are not reversible. `NtCreateFile` with the retained handle
as `RootDirectory` and an empty `ObjectName` opens the related file itself on
every filesystem: no path, no ID lookup. Keep the post-open volume + file-ID
comparison anyway; it is what makes the reopen fail closed.

A volume root has no "." or ".." entries, so the first `NtQueryDirectoryFile`
on an empty FAT root returns STATUS_NO_SUCH_FILE, not STATUS_NO_MORE_FILES.
Treat it as empty only on the first query.

NTFS runners never hit either path. `rust-platforms.yml` attaches a FAT32 VHD
with `diskpart` and runs the ignored
`fat32_volume_enumerates_without_reversible_file_ids` test against it.
