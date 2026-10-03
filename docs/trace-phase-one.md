# Trace Explorer stage 1: recorded image edits and a read-only DAG

Status: implemented in stacked PRs; verification and limitations below, 3 October 2026.

## Implementation status

The stacked [host inspector PR #978](https://github.com/xnmp/tauri-explorer/pull/978) and [Trace/OpenAI Images PR #979](https://github.com/xnmp/tauri-explorer/pull/979) provide the plugin pane, read-only DAG, native durable records, and a separate OpenAI image plugin. The host changes were made in a new worktree; the original Tauri Explorer checkout is untouched.

**Available workflows:** native crop saved as a copy; OpenAI image editing from a selected PNG/JPEG/WebP; and prompt-only generation into a selected local folder. The default is `gpt-image-2`, the documented Codex image model. Authentication uses a configured OpenAI API key or `OPENAI_API_KEY`. Existing Codex ChatGPT sign-in is not reused: the user explicitly authorized API key fallback when supported sign-in reuse was unavailable.

Runs are recorded before execution and retain prompts, settings, input revisions, safe status/error codes, and available provider request/usage details. Successful publication records the output revision. Startup reconciliation uses retained native file identity and a digest to recover a published output after an interrupted database update. Failed and cancelled runs do not invent outputs. The OpenAI run-history command exposes the latest 64 runs, including failed prompt-only generations; pending publication paths are labelled unverified.

The pane shows ancestors, descendants, forks, and multi-input joins. Selecting a node shows revision/run details. Changed selected bytes are labelled as a historical revision, missing paths are marked, and oversized files are explicitly unverified. Explorer rename and history undo/redo preserve the current revision's locator.

**Deliberate first-release limits:** provenance is in app-local SQLite, not embedded in exported PNGs; graph editing, regeneration, relinking, retention controls, portable export, and asset identity are later stages. Crop replacement is untraced because it uses a separate native recovery journal; save-as-copy is traced. The format supports multiple inputs, but this OpenAI UI accepts one input image. Provider revision and monetary cost remain unknown when not reported. A crash in the narrow interval before staging evidence is recorded can leave a private temporary directory. No live paid OpenAI request has been made during verification.

### Use

1. Enable **Trace** and **OpenAI Images** in plugin settings (both default on). In **AI / OpenAI Images**, enter the API key, or launch the app with `OPENAI_API_KEY` set.
2. Right-click an image → **AI → Edit with OpenAI**, enter a prompt and PNG filename, and submit. For a new image, right-click a local folder → **AI → Generate image with OpenAI…**.
3. Select the source or output to inspect the Trace pane. Repeat an edit on the output to extend the graph organically.
4. Use the command palette's **OpenAI: Image Run History** to inspect failed generations with no output file.

### Verification

The full native suite passed (1,745 tests; 44 ignored), and the full frontend suite passed (3,221 tests; 3 skipped). Svelte checks reported no errors or warnings. Targeted browser workflows passed in Chromium and WebKit, covering generation/edit submission, failure history, all three explorer views, multi-parent lineage, changed bytes, and verification limits. Native tests exercise actual HTTP JSON/multipart transport through a local server, captured-byte identity, no-overwrite publication, cancellation, interrupted completion, and startup recovery. Browser tests use a provider mock; live model/account availability still requires a user API key.

## Purpose and user experience

Start with the image-editing action Tauri Explorer already ships. When a user edits an image, Trace records what the edit actually consumed and produced. Selecting either the source or result shows a **Trace pane** with a small, read-only provenance DAG. This should work without creating a project, importing files, or assigning descendants by hand.

The first model action is an OpenAI image edit using an API key. Native crop-as-copy also records provenance. The recording boundary should remain provider-neutral so later upscale, animation, and other model actions can use the same durable format. The existing explorer remains the way to browse, select, preview, and open files.

## The first complete workflow

1. Right-click an image and use the OpenAI image edit action. Enter a prompt and output filename.
2. Before remote work starts, the native backend creates a durable run record with a stable ID and the submitted recipe. It records the exact bytes staged as input, rather than assuming the source path still identifies those bytes later.
3. When the output is safely published, the backend records its path, content fingerprint, status, and completion details. A failed or cancelled run remains in history without inventing an output artifact.
4. Select the output image. The Trace pane shows `source image → edit run → output image`, with the prompt, model, provider, timestamps, and any known version/cost information in a details area. Select the source to see edits branching from it. A second edit of an output extends the DAG naturally.
5. Restart the app and select either file again; the same graph and run details appear.

The pane may let the user focus a node, inspect its recorded fields, and reveal a file in the explorer. It does not change prompts, rewire edges, import unrelated files, or regenerate anything in this stage.

## What to record

- **Artifact revision:** stable ID, image type, path as a locator, content hash of the bytes used or produced, size, and availability status. An untraced source is shown as `Existing image; earlier origin unknown`.
- **Edit run:** stable ID, operation type, input revision ID and role, output revision ID when successful, exact submitted prompt and model choice, relevant non-secret settings, provider identity, available provider/model revision, start/end times, status, and error details. Unknown provider revision or cost must remain explicitly unknown.
- **Evidence:** distinguish the user's submitted parameters from a provider's actual reported version/cost and from values inferred by Trace. Do not persist API keys, tokens, temporary upload URLs, or raw private diagnostics by default.

Model outputs can be nondeterministic. The record explains how a result was obtained; it does not promise that rerunning the same prompt will reproduce identical bytes.

## Integrity and lifecycle nuances

- **Capture at execution:** hash the exact source bytes staged for the image provider. The source may move or change while the job runs; its path alone is insufficient evidence of what was submitted.
- **Record before notifying:** persist the run's terminal state in the native backend before emitting a completion event. Frontend events update the pane and Jobs panel; they are not the sole record of history. On restart, reconcile incomplete runs and any published output whose final database update was interrupted.
- **Publish safely:** never silently overwrite the source or an existing result. Handle file publication and database updates as a recoverable sequence, since the filesystem and SQLite cannot share one atomic transaction.
- **Identify a selected file:** use recorded location plus content fingerprint and host file-mutation receipts where available. A rename through Tauri Explorer should update the locator. If a file is missing or its bytes differ, retain the historical node and show `missing` or `changed`; do not attach the path's new bytes to the old revision automatically. External moves may require relinking later.
- **Bound the graph:** center it on the selected artifact, showing its ancestry and nearby branches. The current query rejects connected graphs exceeding 1,024 artifacts or runs; branch collapsing and paged expansion can follow later.
- **Keep provenance honest:** edits made outside this recorded path have unknown ancestry. The pane should say so rather than infer causation from filenames or timestamps. Disabling the Trace pane does not stop native recording. Crop-as-copy remains usable with a warning if recording fails; OpenAI generation requires a durable start record before a paid request. Its dialog explicitly states that the prompt and settings are recorded.

## Storage and plugin boundary

Use a schema-versioned, app-local SQLite store for the first release so an edit anywhere can be recorded without project setup or sidecar files. This is a local index, not embedded metadata in the PNG. Keep storage behind a repository interface so later project-local storage, export, or portable sidecars can be added without rewriting the graph model. Prompts are captured only for explicitly submitted model actions, with disclosure in the dialog. Retention/delete-history controls remain future work; there is no claim of encrypted storage or PNG-embedded provenance.

The Trace plugin owns its domain records, query/projection logic, and pane. The host plugin API provides a selection-aware pane contribution. A native provider-neutral recording module survives plugin UI teardown; the crop and OpenAI adapters call it directly. The workspace context also provides automatically disposed file-change notifications, so Trace does not import core state. A public recording API for third-party native adapters can be added when another producer needs it. This stage uses the inspector and durable-operation portions of [tauri-explorer issue #969](https://github.com/xnmp/tauri-explorer/issues/969). Artifact-as-folder navigation and generic virtual-resource activation are later work.

## Acceptance walkthrough

Edit `griswold.png` into `griswold-fog.png`, then edit that output into `griswold-night.png`. Selecting the last image shows all three images and the two edit runs in order; selecting the original shows the branching history. Every run shows the prompt and model actually submitted, and no secret. Close and reopen the app: the graph remains. Rename one output through Tauri Explorer: its graph identity survives. Change its bytes externally: Trace flags the mismatch. Simulate a failed edit and a renderer restart during a successful edit: neither produces an invented output, and a published result can be recovered from the native run record.

Verification should cover the native persistence/recovery path, the selected-file lookup, and the user-visible pane in all supported explorer views. A browser mock alone cannot establish that a native job's output and provenance survived a restart.
