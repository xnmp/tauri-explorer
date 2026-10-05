# Arch installer rebuilt unchanged embedded frontend assets

An actual installer profile on an unchanged checkout took 368.11 seconds:
359 seconds in Rust release compilation/linking, roughly six seconds building
the frontend, and roughly two seconds packaging. Dependency preparation was
under a tenth of a second. Privileged authentication/installation were replaced
with controlled commands for profiling; no installed package was changed.

`makepkg --cleanbuild` clears isolated staging, not the checkout's Cargo target.
The expensive repeated work came from rebuilding the frontend unconditionally:
SvelteKit defaults its version to `Date.now()`, and regenerated assets make the
Rust crate that embeds them dirty. Removing staging cleanup would not solve
this, and skipping `prepare()` would reintroduce #980.

The wrapper enables verified frontend reuse through
`scripts/build-arch-frontend.mjs`. Reuse requires the same source, configuration,
dependency contents, environment and Node/Bun versions, plus intact output.
Cargo still checks native changes every time, package metadata is rebuilt, and
the release optimization settings remain unchanged. Direct makepkg/CI builds
still build frontend assets unconditionally. `--rebuild` forces regeneration.

Real makepkg verification also exposed its automatically generated
`SOURCE_DATE_EPOCH`: a fresh timestamp is exported for every invocation, making
an exact environment key miss even when the source and outputs are unchanged.
Default the wrapper's epoch to the latest source commit timestamp (or the
`package.json` mtime for a source archive), preserving explicit caller values.
This follows the [reproducible-build convention](https://reproducible-builds.org/docs/source-date-epoch/)
and keeps the complete environment contract. Package build timestamps now
follow that source epoch. The reproduction used real makepkg twice: files and
tool versions matched; `SOURCE_DATE_EPOCH` was the only changing build variable.

Treat generated PDF copies and Vite temporary files as outputs, while retaining
authored assets elsewhere under `static/generated/`. A clean checkout initially
lacks the generated container, so its creation with only ignored PDF copies
must not be mistaken for a source edit during the build.

Publish the receipt only after a successful build whose inputs stayed unchanged.
Remove the old receipt before rebuilding and use atomic replacement for the new
one. Serialize helpers with an OS advisory lock, and pass ownership to the build
child: killing a helper does not necessarily stop its child. The wrapper also
owns shared makepkg staging through installation. Its credential keepalive must
close that lock descriptor so an orphan refresher cannot block future installs.

Behavior tests cover reuse, same-mtime edits, additions/deletions, environment
changes, dependency edits, symlinks/cycles, corrupt output/receipts, failed builds,
clean checkouts, overlapping builders and helper termination. Independent
adversarial fixtures exposed the generated-container and lock-lifetime cases.
This optimization targets unchanged repeat installs; frontend or native source
changes still require optimized release compilation.

Actual settled repeat runs took 8.00 and 8.14 seconds, with Cargo completing in
0.24 and 0.21 seconds. The original unchanged install took 368.11 seconds. The
first reuse after frontend regeneration still took 353.19 seconds. Inspection
points to Tauri's content-addressed macro-generated asset inputs being created
after the library's dependency cutoff; a real proc-macro fixture reproduced the
resulting Cargo catch-up compile. Production attribution remains an inference
because that first repeat lacked a dirty trace. Inspect generated inputs
and Cargo fingerprints before claiming every first repeat is fast; two later
real package runs confirmed the cache settled. See
`docs/reviews/989-arch-installer-speed.md` for the full measurement scope.
