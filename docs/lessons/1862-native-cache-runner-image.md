# Native target caches must include the runner image

The Windows smoke job failed before GUI qualification while merging libavif's
static archives. The last green run used Windows image `20261103.298.1`; the
failure used `20261116.315.1` but restored the same Rust target cache. CMake
detected MSVC 14.52 for compilation while libavif's cached `BUNDLE_TOOL` still
pointed to the removed 14.51 `lib.exe`. MSBuild reported that the system could
not find the path.

The intervening Compact layout PR did not touch this build path. Invalidating
the target cache on runner image OS/version changes fixes the compatibility
boundary without reverting that feature or changing codec behavior. Registry
caching remains independent. The identity step records the image and Rust
identity in diagnostics, and both target restore and save consume its digest.

The workflow regression executes that actual Bash step with fixed Rust output
and varying image identities. It proves that identical environments reuse a
key and either image or Rust changes invalidate it, rather than only checking
that the YAML mentions a new variable. Windows CI remains the native build and
GUI qualification authority.
