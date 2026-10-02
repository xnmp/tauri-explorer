# #822: installed application choice

Single regular files on Linux use GIO's installed applications for the actual content type, with visibility/support checks, stable desktop IDs and deduplication. Launch revalidates the regular file and eligible desktop ID, constructs the installed DesktopAppInfo and passes GFile arguments. Do not concatenate a shell command or change default associations. Other platforms and folder/multiple selection expose a disabled action with a reason.

The state layer captures a selected path and session identity before catalogue IPC. Stale results cannot reopen a cancelled or replaced chooser. A launch retains modal/input ownership until its promise settles, so duplicate activation and Escape cannot dispatch another application. Lazy dialogs must be included in hasModalOpen before their component bundle mounts. Modal ownership guards must be checked before detaching registered owners; guarding only an onClose callback leaves the visible pending modal unowned.

Context-menu focus must follow the tick that publishes visible DOM; focusing a visibility:hidden button fails in both engines. The chooser uses an opaque theme surface so underlying file text cannot obscure labels in WebKit.

Verification: store/domain/modal contracts, keyboard outcomes in all views and both browser engines, and a native installed GTK alternate application on a private Xvfb/D-Bus/XDG profile. The native receipt, actual process environment, window identity and displayed text verify the exact Unicode/shell-significant path and contents. Default xdg-mime association stays unchanged. A deleted-file error and an admitted desktop entry with a nonexistent working directory cover real failures.

A nonexistent executable can be rejected during catalogue construction, which proves unavailability rather than attempted launch failure. An invalid interpreter may fail only after gio-launch-desktop was accepted, so GIO can report launch success. Use a valid executable with an invalid desktop Path for a synchronous spawn failure test. AppInfo launch is OS dispatch, not a universal acknowledgment that every external application's later initialization succeeded.
