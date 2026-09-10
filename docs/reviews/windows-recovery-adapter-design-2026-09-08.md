# Windows recovery adapter — implementation brief

Status: shared lock, file-identity and directory/privacy boundaries implemented; full adapter
and Windows runtime qualification remain incomplete. Part of #680
and ADR 0020. Independent GPT-5.6 Sol audit of the current coordinator and
Microsoft documentation. This does not close Windows release acceptance.

## Required boundary

The Unix coordinator relies on handle-relative no-follow access, private storage,
exact object identities, independent cross-process locks, and namespace durability
after file flushes. A Windows implementation must supply those contracts explicitly.
Returning success from an empty directory-sync implementation would erase a
required barrier. Do not enable production recovery through a silent bypass.

Use an owned native directory/file abstraction. Recovery callers need bounded
single-component opens, exclusive creation, no-replace rename, typed removal,
independent enumeration, metadata/identity, private-owner validation and durability
capabilities. `std::fs::Metadata` alone is not the Windows identity/security seam.
Root must own changes to these shared interfaces before delegating adapters.

## Handle-relative operations

Use user-mode `NtCreateFile` with `OBJECT_ATTRIBUTES.RootDirectory` for relative
opens, exact create dispositions and `FILE_OPEN_REPARSE_POINT`. Directory opens
must reject reparse points; initial absolute traversal must protect every path
component, not just its leaf. Synchronous handles need the corresponding access
and synchronization flags. See Microsoft's
[NtCreateFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatefile)
and [OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes).

Rename from an opened source handle to the opened target directory with
`ReplaceIfExists=false`; retain source identity through the operation. Deletion
must use the exact opened entry and preserve directory/non-directory semantics,
including nonempty-directory refusal and pending-delete behavior. Enumeration
needs a fresh file object, bounded variable records and a separate cursor. Relevant
interfaces are [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info),
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
and [FILE_ID_BOTH_DIR_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info).

## Identity, privacy and locks

`object_id.rs` now preserves native platform tags, full Unix device/inode pairs,
and Windows volume serial plus all 128 file-ID bits. Durable decoding rejects
foreign operating systems, untagged IDs and malformed shapes. Volume comparison
is separate from object equality. `file_identity/windows.rs` queries `FileIdInfo`
on the supplied file handle and propagates native/unsupported errors; it never
reopens a path or truncates the file ID. Unix metadata capture uses the same pure
identity boundary. Native resource size accounting includes the platform-specific
serialized identity size.

The identity is valid for comparing live objects on one computer; it is neither a
content version nor proof against filesystem ID reuse after deletion. The Windows
source and tests cross-compile, but NTFS/ReFS/SMB runtime and secure-directory
integration remain outstanding. See
[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
and [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex).

Private recovery storage now uses an explicitly protected DACL, current-user
owner SID and handle-based validation. The shared `private_storage` policy is
used by catalog, operation-lock and Unix coordinator callers; its Windows adapter
checks kind, reparse status, link count, delete-pending state and strict ACLs on
the supplied handle. It never infers privacy from parent spelling or accepts a
null DACL. Current user and SYSTEM receive access; privileged administrative
interference remains outside the same guarantee as Unix root. These checks are
observations, not persistent authority over future link or ACL changes. Ordinary
inherited sidecars have a separate security contract and cannot substitute for
explicitly protected catalog or owner evidence. See
[file security](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
and [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).

Gate/owner acquisition must independently open the lock file and use a consistent
exclusive byte range; `DuplicateHandle` is not a new lock contender. Verify the
exact nonce and identity before acquisition and retirement. The exclusive range
must lie beyond the bounded nonce-read region (for example one byte at offset
4096): Windows locks deny other handles' reads as well as writes, so locking
byte zero would break the current validation-before-acquisition flow. Locking
beyond EOF is supported. The shared `file_lock` wrapper now implements this range and retains Unix
whole-file locking; coordinator and operation-owner callers use independently
opened guards. Pending Windows operations retain a dedicated manual-reset event
and their `OVERLAPPED` storage through completion; file-handle signalling is
ambiguous in the presence of unrelated asynchronous requests. See
[GetOverlappedResult](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-getoverlappedresult)
and [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex).
Owner names/nonces and retirement names now use
[`getrandom::fill`](https://docs.rs/getrandom/latest/getrandom/fn.fill.html),
propagating failure before creating entries. This delegates native RNG selection
to the existing dependency instead of adding a hand-written Windows RNG adapter.

## User-path resource capture remains platform work

Private storage deliberately rejects reparse traversal. User-path capture needs a
separate policy: follow intermediate directory junctions/symlinks, retain their
physical identities, and open the final entry without following it when the
operation owns that link. A following-parent NotFound needs a no-follow probe to
distinguish a missing name from a dangling or unresolved reparse point.

Capture per-parent case policy and full handle identity. Windows supports
[per-directory case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity),
so a blanket lowercase key would conflate distinct entries. Ordinal comparison
uses the operating system's uppercase table; Microsoft's
[filesystem behavior specification](https://download.microsoft.com/download/4/3/8/43889780-8d45-4b2e-9d3a-c696a890309f/file%20system%20behavior%20overview.pdf)
describes filesystem comparison using the on-disk upcase table. Existing batch
spelling validation is therefore not proof of physical namespace equivalence.
Remote providers need their own qualification.

[GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
can normalize an existing handle name, but cannot describe missing suffixes or
provide a unique hardlink name; normalized SMB paths may also require access to
each component. Prospective names need short-name policy qualification because a
new long name can acquire an alias; see
[AreShortNamesEnabled](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-areshortnamesenabled).
The Unix physical-ancestor index now handles bind aliases, including missing
intermediate directories, but its exact component bytes are not a Windows name
comparison implementation. Preserve independent sibling operations in the final
adapter; serializing every destination under one directory is not the intended
performance contract. Native capture, case/short-name handling and provider tests
remain required, as do case-insensitive macOS volume semantics.

## Durability and acceptance

The native API provides a concrete qualification candidate:
[`NtFlushBuffersFileEx`](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex)
with normal flags (`0`) documents flushing cached data and metadata and
synchronizing underlying storage for NTFS, ReFS, FAT and exFAT. Its data-sync-only
mode explicitly excludes directory handles; normal mode does not. The generated
Windows binding exposes the user-mode `ntdll` entry point. It requires write or
append access, which the current traversal-only directory handles do not request.

This supports investigation of a retained-directory flush, but does not by itself
prove persistence of every preceding create/rename/remove through other handles.
Qualify the actual access rights, filesystem return status and namespace outcome
under faults before treating it as the recovery barrier. Do not infer SMB support
from that local-filesystem table. The current Windows `Directory::sync` returns
`Unsupported`, so callers cannot report a successful barrier prematurely.
Represent qualified namespace durability as an explicit volume/platform capability
or as part of each successful create/rename/remove operation. Write-through native
handles are another candidate requiring native crash qualification. See Microsoft's
[file caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching)
and [CreateFile2 parameters](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-createfile2_extended_parameters).

Before enabling production recovery, qualify component-wise reparse substitution,
case/verbatim aliases, hardlinked evidence, full-width IDs, independent concurrent
enumeration, no-replace races, two-process lock contention and crash release, and
process termination at every intent/effect/completion boundary. NTFS, ReFS, SMB
and FAT require their own capability/evidence decisions. A process-kill test does
not establish sudden-power-loss durability. Unsupported volumes must never be
silently advertised as recoverable; the full product/platform acceptance gate
remains open until the required behavior is implemented and verified.
