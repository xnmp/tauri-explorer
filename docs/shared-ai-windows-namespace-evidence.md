# Windows namespace implementation and qualification

Candidate source: `src-tauri/src/windows_artifact_namespace.rs`. Target/merge-base is `882263e1cc6298bb43e037265185d746a6d2d126`. Scope is platform IO only; the coordinator owns Store, consumer, profile and public contract integration. No paid calls, administrative volume flush, user profile mutation or Windows runtime execution occurred in the Linux development environment.

## Implemented boundary

`AnchoredDirectory::open_absolute` accepts an absolute local drive namespace and verifies local NTFS through the opened volume. Each filesystem component opens relative to the preceding retained directory handle. Every opened object is checked as a disk object of the required type without a reparse tag. Ancestors deny write/delete sharing. UNC, drive-relative, traversal, alternate streams, special device names, invalid Unicode and oversized names are refused. C:\ requires traversal/attribute rights, not writable volume-root access.

`create_new` and `create_directory` use native exclusive creation, synchronous write-through IO and no inherited handles. Creation of an existing name never truncates it. A newly created directory's read guard must reopen the exact captured file identity after its creation handle closes; substitution fails. Private DACL ownership is an explicit caller precondition, not a property established by these methods.

`publish_noreplace` accepts only a writable owned file from the same opened directory identity. It flushes that actual handle, issues relative `FileRenameInformation` with replacement disabled, then flushes the same file again. The caller retains `AnchoredFile` through its descriptor/grant transaction, preserving all ancestor handles. No path-based rename window, cross-volume copying, temporary-spool fallback or directory-flush no-op exists. On an error after rename, the original durable reservation remains the caller's recovery authority; no new provider execution is authorized.

`flush_evidence` verifies the directory identity and requires the actual writable file handle. It is a file barrier, not a recursive directory-fsync theorem. The coordinator must qualify initialization/new consumer ancestors and use equivalent namespace creation/publication before accepting transfer evidence. Generic Store `sync_directory` must not be redirected to this function.

## Primary API basis

Microsoft documents [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile) as a user-mode API. `OBJECT_ATTRIBUTES.RootDirectory` resolves relative names from an existing handle; exclusive creation and directory-only opening are separate dispositions/options. Its directory option explicitly permits write-through requests.

The [CreateFile caching documentation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew#caching-behavior) states that NTFS write-through requests flush metadata changes arising from the request, including renames. This is the candidate namespace primitive rather than an assumption that directory `FlushFileBuffers` behaves like Unix fsync. Buffered write-through avoids the alignment requirements of unbuffered IO.

[Native rename information](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information) supports a relative destination root and prohibits replacement when its flag is false. [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers) provides an explicit file flush, requiring writable access. Volume-wide flush requires privileges and is not used. The narrower [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) write-through copy/delete wording is avoided by this handle-relative implementation.

The kernel/filesystem/device must honor successful write-through and flush requests. This is the ordinary durability assumption, also explicit in [SQLite's hardware assumptions](https://sqlite.org/atomiccommit.html#hardware_assumptions); tests below do not establish physical power-loss behavior.

## Exact-module verification

The standalone fixture compiles the production module directly, without Tauri or provider execution:

```sh
cargo test --locked --manifest-path src-tauri/test_support/windows_artifact_namespace_fixture/Cargo.toml -- native_tests:: --nocapture
```

Expected native result: **8 passed, 1 ignored child helper, 0 filtered**. The child helper is exercised by the crash outcome test. Outcomes cover actual write-through creation/rename/file flush; invalid names and paths; no replacement; lifetime of ancestor guards after the directory owner drops; junction refusal; cross-namespace publication/acquisition refusal; long Unicode names; and process termination after pending flush, rename, and final flush with exact bytes on reopen.

The qualification marker reports both a dedicated writable-directory flush attempt and the retained read-only anchor's actual kernel result. The dedicated probe closes its read guard before opening the private child with `GENERIC_READ|GENERIC_WRITE`; otherwise a sharing violation would measure our own lock policy instead of filesystem support. An unsupported/error result is recorded accurately and is never converted into success.

Cross-check commands already passed for MSVC types; GNU check is recorded separately:

```sh
CARGO_TARGET_DIR=/tmp/te-windows-artifact-target cargo check --offline --locked --tests --manifest-path src-tauri/test_support/windows_artifact_namespace_fixture/Cargo.toml --target x86_64-pc-windows-msvc
```

Logs: `/tmp/te-windows-artifact-cross-check.log`, `/tmp/te-windows-artifact-gnu-check.log`. Linux cross-checking proves type/API availability, not runtime behavior. The CI owner has added the actual Windows-2022 fixture job; its successful run and archived source/executable hashes are required before selecting the production boundary or merging.

## Remaining coordinated qualification

Native primitive fixtures alone do not qualify durable root initialization, Windows DACL provisioning, descriptor/SQLite ordering, acquired evidence, retained deletion/quota cleanup, provider post-replace settings commits, or the complete consumer/provider handoff. These require coordinator integration and actual Windows outcome fixtures. Process-crash tests leave OS caches running and must not be described as power-loss tests. The existing fail-closed mutation guard remains until this evidence and integration are complete.
