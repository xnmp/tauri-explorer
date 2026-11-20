# Companion-audio fixtures must execute stable launchers

Dev CI's opt-in Rust suite failed in the no-audio media-preview contract with
`ExecutableFileBusy` (`ETXTBSY`). The only merge since the last green CI run was
the release-version bump, which did not change this fixture or extraction.

The fake ffmpeg was a freshly written executable script. Another test's fork
can inherit its writable descriptor until that child execs, so closing the
writer in this test does not guarantee Linux will permit execution. This is
the same fixture race documented in lesson 1626.

Each fixture now symlinks a checked-in executable launcher and writes its
response script beside that link. The launcher passes the generated script to
`/bin/sh` as input and preserves the extractor's arguments and process lifetime.
There are no retries or production changes.

The regression holds every generated ffmpeg script open for writing across
production audio preparation, then checks the HTTP status, decoded bytes and
decode invocation. It fails deterministically with the old fixture's exact CI
error. Existing tests retain no-audio refusal, fallback, denial, cancellation
and derived-file cleanup coverage.
