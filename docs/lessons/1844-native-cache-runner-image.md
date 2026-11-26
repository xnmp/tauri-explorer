# Native target caches retain runner tool paths

The Windows smoke build failed before GUI qualification when a hosted runner
image update restored a Rust target cache produced by the previous image.
Rust and Cargo inputs were unchanged, but libavif's generated CMake project
invoked an absolute MSVC `lib.exe` path that no longer existed.

Include `ImageOS` and `ImageVersion` in the native cache identity alongside
`rustc -Vv` (ADR 0022). Restore, save and diagnostic keys must stay identical,
with no broader target-cache fallback. The regression executes the workflow's
identity script and checks stable reuse plus compiler/image invalidation.

The last merged PR changed only a Linux wallpaper test; reverting it could not
repair this Windows native-toolchain cache mismatch.
