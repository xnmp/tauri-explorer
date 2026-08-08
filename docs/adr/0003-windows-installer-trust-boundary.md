# ADR 0003: Windows installer trust boundary

Governs: `windows_install.ps1`

## Context

The Windows installer is downloaded and executed by a user, then creates a
temporary source checkout, builds a native package, and invokes `msiexec`.
These network, filesystem, and installer actions need explicit failure and
cleanup rules.

## Decision

- The documented command downloads from the repository's HTTPS raw URL. Users
  trust the selected branch and its repository permissions before executing it;
  the installer does not silently switch repositories or download executables
  other than build dependencies selected by the user from the printed `winget`
  commands.
- Missing prerequisites stop the script before cloning, building, or starting
  an installer. The script reports the exact user-run `winget` command instead
  of elevating or installing prerequisites itself.
- A local checkout is used as-is. A downloaded script clones only
  `xnmp/tauri-explorer` over HTTPS, optionally at the requested ref.
- The generated MSI is passed to `msiexec` as one quoted argument. `RunAs`
  makes Windows' UAC consent prompt explicit, the script waits for completion,
  and it surfaces failed installer exit codes. Windows Installer's `3010`
  success-with-reboot-required result is reported as a successful install with
  an explicit restart notice.
- Temporary clones are removed in `finally`, including after clone, build, or
  MSI failures. Existing checkouts are never removed.

## Consequences

The installer is convenient without hiding elevation or trust choices. Changes
to its download source, prerequisite installation, MSI launch, or cleanup must
preserve these boundaries and update this ADR.
