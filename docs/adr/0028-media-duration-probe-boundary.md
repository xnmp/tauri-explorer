# ADR 0028: Media duration probe boundary

Status: Accepted.

Governs: `src-tauri/src/media_duration.rs`,
`src/lib/state/media-durations.svelte.ts`.

## Problem

The Details view's Length column (#995) reads playback length from video files
the user merely browses past. Those files are untrusted input: any directory can
contain a truncated, corrupt or deliberately hostile container. The probe also
starts a new external process (ffmpeg) for containers without a native parser.
Without an explicit contract, one malformed file could occupy a probe worker
indefinitely, a parser could report a length read from bytes outside the element
that declares it, and a stuck ffmpeg could pin a blocking thread and its pipe.

## Decision

### Parser bounds

Native parsers read container headers only, through `Read + Seek`, and never
load media data.

- Every per-level scan (ISO-BMFF boxes, Matroska Segment children and Info
  children) visits at most `MAX_SIBLINGS` (4096) elements. Exhausting the
  budget yields no duration; it is never treated as "end of level".
- A value is read only from inside the payload that declares it. An ISO-BMFF
  box must fit inside its parent, and `mvhd` must be long enough for its
  version's timescale and duration fields. A Matroska Info child's header and
  payload must end at or before the end of Info (clamped to the file length).
  A child that crosses the boundary invalidates the Info scan; it is never
  completed from a sibling's bytes.
- Matroska scanning stops at the first Cluster and rejects unknown-size
  elements other than the Segment itself, so a missing Info cannot turn into a
  scan of media data.

### Subprocess ownership

ffmpeg is only a fallback, for containers without a native parser and for
native files whose header carries no usable duration. It runs through the
configured `thumbnails::ffmpeg_path` with a fixed argument vector (no shell),
with the probed path as one argument and stdin/stdout closed. The probe owns the
child until it is reaped:

- stderr is drained on a helper thread and capped at `MAX_FFMPEG_STDERR` bytes;
- the child must exit within `FFMPEG_PROBE_TIMEOUT`, or it is killed and
  reaped, and the file yields no duration;
- the stderr helper thread is joined only after the child exits. A configured
  `ffmpeg_path` that is a wrapper script and does not `exec` can leave a
  grandchild holding stderr, and only the wrapper is killed. A real ffmpeg
  binary does not fork, so this is accepted rather than handled with process
  groups.

### Resource limits

Each window's frontend resolver batches same-tick row requests (16 paths per
call) and keeps at most two `get_media_durations` calls in flight. It caches at
most 5000 results, keyed by path and revision (size + mtime). Each call runs its
batch sequentially on one blocking task, so a window runs at most two probes,
and therefore at most two ffmpeg children, at once. The limit is per window,
not per process: every explorer window has its own resolver and the native
command has no global semaphore, so N open windows can run up to 2N probes.

### Failure behavior

Every failure is per file and yields `null`: unreadable, unsupported, malformed
or over-budget input, a missing ffmpeg, a timeout or an unparseable ffmpeg
report. The frontend renders `null` as an empty cell and caches it for that
revision, so a bad file is not re-probed until it changes. A timeout is cached
the same way: a file that once took longer than `FFMPEG_PROBE_TIMEOUT` (for
example on a cold network share) shows no length until it changes or the window
reloads. A failure never fails the batch, the listing, or other rows.

## Consequences

Durations that ffmpeg could recover from a container that violates these bounds
are not shown: correctness and bounded cost come before coverage. New native
container parsers must follow the same budget and containment rules and add a
malformed-input regression test.
