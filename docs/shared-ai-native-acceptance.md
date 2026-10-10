# Shared AI native acceptance (working snapshot)

This record covers the `test/shared-ai-native-e2e` worktrees. It is not a clean release or package qualification. The clean qualification wrapper, `scripts/build-native-qualification.ts`, requires a clean source worktree.

## Fixtures and isolation

`e2e-tauri/specs/shared-ai-services.spec.ts` drives the real native stack:

- the actual host debug binary;
- the installed SDK3 Trace and Image Generation archives;
- native plugin processes;
- shipped custom-protocol assets.

`e2e-tauri/run-shared-ai-services.sh` isolates each run:

- It creates a private XDG profile and runtime directory under `$TMPDIR`.
- It queues the archives only into that profile.
- It runs WebDriver under private Xvfb, Openbox and D-Bus.
- It removes the AI authentication variables from this launch without changing `HOME`.

The fixture verifies that the app and its helpers share the private display, profile and D-Bus session. The private profile, journals and run manifest are kept for inspection.

Every connection the fixture creates uses credential `none` and a loopback endpoint:

- **Images:** `/fixture/images/{generations,edits}`. Replies can be scripted per request (400, then 200). Each output PNG is distinct.
- **Text:** `/fixture/text/v1/chat/completions` returns a distinct title for each model. One model can be held to simulate a slow response.

The server records, for each request:

- the path and headers;
- the body (JSON, or multipart fields);
- the SHA-256 of every image part, in order.

Generation cases run only with `SHARED_AI_NATIVE_GENERATE=1`.

## Build identity

The host was built with:

```sh
VITE_E2E_HOOKS=1 CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=/var/tmp/te-wt/host-e2e-target bun run tauri build --debug --no-bundle --features e2e-hooks -- --locked
```

The Trace archive was built with `bun run build:frontend`, then `python3 scripts/package-plugin.py --binary <target>/debug/trace-explorer-backend --output package-e2e`. The provider archive was built the same way with `--plugin image-generation`.

Tested artifacts (SHA-256):

| Artifact | SHA-256 |
|---|---|
| Host binary | `6d1a8f4fcd248c9db2c9613ebbde679b4a9caa3341e6be0107a21810e5fdb453` |
| `TraceExplorer-0.2.3-x86_64-unknown-linux-gnu.teplugin` | `f0e4a243f7e36e1e15e1624e8f866efb9560c643e8b1869472c0ca22fb2df23f` |
| `ImageGeneration-0.1.0-x86_64-unknown-linux-gnu.teplugin` | `5341e04122efda6c65a5eaff338021a3328be55dee02f38c9ae28ee4af92c589` |

The run manifest records the same hashes and is labelled `dirty-working-snapshot`. Its `buildCommandKnown: false` flag means the recorded command is the documented one, not one that was observed.

## Outcomes (Linux WebKit, 2026-10-10)

| Profile | Result | Log |
|---|---|---|
| Absent provider | 2 passed | `/var/tmp/te-wt/logs/final-absent.log` |
| Present provider, no generation | 3 passed | `final-present-nogen.log` |
| Present provider, generation, run 1 | 9 passed | `final-present-gen-1.log` |
| Present provider, generation, run 2 | 9 passed | `final-present-gen-2.log` |

Earlier cases (cold start, absent-provider refusal, settings navigation, publish plus provider restart) are unchanged and still pass.

The cases below were added for plan §14.4 and §21.3 item 12. Each was checked by temporarily breaking the rule it guards, confirming the native suite failed, and then restoring. The break logs are `/var/tmp/te-wt/logs/break-*.log`.

### Generation from a selection (4.6 selection, 4.9)

The selection case edits two Ctrl-selected images, moves one earlier, and asserts:

- The endpoint received `/edits` image parts in the displayed order.
- The run records its inputs in that order, with their digests.
- The submitted prompt is recorded as entered.
- The published bytes match the endpoint's output.
- Provenance lists both inputs.
- Trace routes link each input to the output tile.
- The progress panel shows exactly one entry: "Complete".

**Break check:** swapping the source and first reference made the image-order assertion fail.

### Retry (4.7, 4.9)

The endpoint rejects the first request with 400. The case then checks:

- The panel shows one "Failed" entry, with the error and a Retry action.
- After Retry, a new run with `retry_of` set to the failed run is read back through the Trace backend RPC `recent_openai_image_runs`.
- The retry has a new `operation_id`.
- It pins the same inputs and the same options: prompt, model, size, resolution, aspect, quality, background, connection and revision, input roles, and submitted prompt.
- The endpoint received the same request bodies apart from the reply status.
- The panel shows one "Complete" entry.

**Break check:** dropping `retryOf` failed the case with "Retry never published a run linked to the failed one".

**Break check for 4.9:** registering a duplicate host job left an extra entry, and the case failed.

### Save and discard (4.10)

The case runs "Save image permanently" and then "Delete unsaved image" through the native context menu. It checks:

- The saved file is in the run's folder and its bytes equal the output.
- Provenance points at the saved file and is no longer temporary.
- The discarded file is gone from disk, and its provenance artifact reads `discarded: true`.
- The folder lists exactly one new PNG.
- Provider receipts stay Succeeded/Acquired.
- No new endpoint requests were made.

The temporary file is intentionally kept after Save, as a provenance locator.

**Break checks:** making save a no-op failed the case ("Save did not move the image"). Making discard a no-op failed it too ("Discard left the temporary image on disk").

### Text titles and independent settings (4.2, 4.3, 4.5)

**4.2.** Two text profiles are created in host Settings. When each is made the global default, the real Trace prompt node shows that profile's distinct title ("Alpha…", then "Beta…").

**4.3.** A held, slow profile is made the default, and then Beta is restored before the slow response is released. The case asserts:

- The node never displays "Slow stale title" (a MutationObserver watches it).
- Once all slow responses close, a barrier `trace_prompt_title` call returns Beta, and so does the node.
- Each model and prompt pair is requested at most once.

**4.5.** Saving text settings leaves `settings.read` (image) unchanged. Saving a different default image connection changes the image default and leaves `ai_connections_read` (text) unchanged.

**Break checks:**

- Removing Trace's revision filter made the node fall back to the prompt instead of Beta.
- Inverting each persisted-equality assertion made it fail.
- Before the host palette fix, the image connections dialog never opened (run `e2e-present-gen-15`).

### Generation from a folder entry point (4.6 folder)

The case uses the folder's context menu ("AI", then "Generate image with OpenAI…") and asserts:

- The request is `/generations` with no image parts.
- The run's inputs are empty.
- The output is temporary, with the suggested directory set to that folder.
- The folder stays empty until a save.
- The panel shows one "Complete" entry.

**Break check:** opening on the parent folder made the suggestion assertion fail.

### Plugins page to provider configuration (21.12, present profile, no generation needed)

"Configure connections" is opened from the Plugins page. The case asserts:

- The connections dialog is the only `aria-modal` surface.
- Focus stays inside it across 12 Tabs.
- The Plugins page is `inert` underneath.
- Escape on a dirty draft asks for confirmation, and "Keep editing" keeps the draft.
- Discarding returns focus to the section button, keeps the Plugins filter, and leaves settings unchanged.

**Break check:** routing `requestTopClose` to the bottom surface failed only this case.

## Product bugs found and fixed

1. **Host: commands run from the palette could not open managed dialogs.** `CommandPalette.executeSelected` ran the command while the palette's modal surface was still on top. `dialogRegistry.openManaged` therefore bound the new dialog to the palette and closed it ("caller-closed") as the palette unmounted.
   - **Fix:** `src/lib/state/run-after-close.ts` waits a tick for the palette to release its surface before running the command.
   - **Test:** `tests/state/run-after-close.test.ts`.
2. **Trace: a provider success that was still sealing was shown as uncertain.**
   - **Fix:** `src-tauri/src/trace/service_images.rs` treats `storage_unavailable` as temporary within the settlement budget (plan §8.2).
3. **Trace: a repeated text-configuration revision cleared titles and re-sent paid title requests.** The host emits the same revision twice, from `ai/mod.rs` and from `config_watch.rs`.
   - **Fix:** `prompt-titles.svelte.ts` ignores repeated or older revisions.

## Not closed natively

The editor entry point for 4.6 cannot be reached. The host opens `ImageCropEditor` only with the "crop" tool. It has no tool switcher, and nothing opens it with a plugin tool id, so Trace's registered "AI edit" editor tool cannot be reached. Closing this needs a host change: either a tool switcher in the editor, or a command or SDK call that opens it with a tool id.

Killing the real Trace package while the provider runs is not driven here. The host-side contract for that case (a consumer SIGKILLed while the provider runs, in both gate orders) is covered by the stand-in fixture `src-tauri/src/installed_plugins/service_native_kill_tests.rs`, which uses real processes and the production brokers.

## Notes

- **WebKitWebDriver drops Shift after a right-click action.** After any right-click action, later typing in the session loses Shift (`:` becomes `;`, and capitals become lowercase). For that reason the spec types lowercase text, and the right-click (folder) case runs after the typing cases.
- **The progress corner panel stays above modal dialogs by design** (`--z-progress`). At 1200×800 it covers modal footers, so cases dismiss finished entries first, as a user would.
- **Host startup logs show several frontend "unhandled rejection: … 'e.startsWith'" messages.** They were not investigated.

## Out of scope

Only Linux private-display acceptance is covered here. None of the following is claimed:

- Windows or macOS;
- physical-display or user-desktop interaction;
- installation in the active profile;
- clean release qualification.
