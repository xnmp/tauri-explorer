# #748 — directory transport can dominate a WebKit frame gap

After immutable listing revisions removed deep-proxy work, the 100k listing still
left a roughly 150 ms animation-frame gap. The installed Tauri custom-protocol
transport decodes through `Response.json()`: replacing global `JSON.parse` did not
observe that work. A temporary application-world response probe measured a
20,200,168-character ASCII payload and approximately 110 ms of body materialization
plus parsing. These broad timings include scheduling; they do not isolate GC or
prove compositor presentation.

Keep transport compact at the API boundary. Rust streams versioned columns from
its existing shared entries, omitting uniform optional metadata. Share a native
path prefix only if concatenation reproduces every path exactly; otherwise send
full paths. The frontend validates aligned columns and constructs the ordinary
immutable `FileEntry` snapshot. Components and caches keep their existing model.
Capture an acquired watch lease before decoding so a malformed payload cannot
leak native observation.

Shared authored fixtures verify Rust serialization and TypeScript decoding,
including aliases, Windows extended paths, Unicode, mixed optional metadata and
fallback paths. Serialize the actual observed-listing struct in its private test
module; copying its shape into a test would miss integration changes. Final
performance comparisons use uninstrumented release binaries, alternating order,
and explicit assertions of the actual view plus native input/watch outcomes.
