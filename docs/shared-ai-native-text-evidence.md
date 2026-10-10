# Native text service: implementation and CLI isolation boundary

Implemented against host `origin/dev` at `3ebfba5792379026f749afed78cb2c65736534a7`.

The native service owns typed profile validation, bounded requests and responses, per-incarnation cancellation, queue deadlines, credential snapshots, configuration CAS, and HTTP execution. Native settings commands return sanitized documents or typed safe errors; write-only key changes create immutable profile-owned OS secret records. The credential abstraction is injectable in tests. Linux uses an encrypted Secret Service session with interactive unlocking disabled, macOS uses Keychain with interaction disabled, and Windows uses Credential Manager through keyring. There is no plaintext-key fallback.

Configuration serialization uses an OS file lock shared by separate host processes, a private temporary file, file sync, atomic replacement, and a revision commit. Unix syncs the containing directory; Windows uses `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`. Actual persistence remains subject to platform/filesystem guarantees. The existing-file replacement test runs on every platform, but Windows and macOS runtime qualification has not been performed in this Linux session. Post-replacement failure injection verifies that a newly committed credential remains resolvable even if the operation reports a durability failure. Native writes and the config watcher publish revisions only after readable configuration exists.

First-run text migration imports an explicit legacy `titleCodexPath`, falling back to `codexPath`, only when `ai-connections.json` is absent. Paths retain the legacy resolver's trimming semantics. It imports no image key or image-provider selection. A private pending/complete marker converges from the committed destination. Summary migration copies `titleGenerator: disabled` to an absent `plugin.trace.json.summarizePrompts`; both native Trace reads and writes use the same cross-process coordination. Legacy symlink targets remain supported, while FIFO/device/directory targets are rejected without blocking. Explicit destination preferences win.

The two HTTP adapters are enabled. Their API root includes any version/prefix; they append `chat/completions` or `messages` exactly once. Redirects are disabled. They return only complete final text, reject tool calls, refusals, truncation, malformed or oversized bodies, and never echo provider diagnostics or credentials. HTTP cancellation drops the native request future. Blocking local work and CLI children retain their worker permits until their owned work ends even if the calling async task is dropped.

## CLI adapters enabled behind isolation checks

Codex CLI (the default) and Claude Code CLI profiles are enabled. Each runs with:

- every isolation flag its installed help advertises;
- an empty temporary working directory;
- a cleared, allowlisted environment that keeps the saved login and withholds API keys;
- the prompt on stdin;
- owned process-tree supervision.

A profile is refused as `unavailable`, before any process starts, when either of the following holds:

- **Managed or organisation policy is detected.** This means system, MDM or registry policy, or the local cache of server- or cloud-delivered policy.
- **The installed CLI's `--help` lacks a required flag.** Only `--help` runs for availability.

Flags, evidence (Codex 0.162.0, Claude Code 2.1.296, 2026-10-10) and residual limits are in [CLI text isolation](shared-ai-cli-text-isolation.md). The earlier finding still holds: managed requirements can force features back on, and Claude safe mode keeps policy hooks. That is why detected policy is refused and not run. Policy fetched during the run itself, without a local cache, remains a documented limit. The backstops reject any tool activity in the output.

## Verification

Native fixtures cover HTTP auth and protocol headers, nested roots, redirect refusal, provider failures and safe messages, final text extraction, malformed/truncated/oversized responses, cancellation/dead owners, pre-admission cancellation, queue deadlines and caller quotas, cross-process CAS, credential rotation/clear/deletion, post-replacement failure, worker ownership after task abortion, first-run migrations, symlink preservation, and CLI isolation: exact argv, prompt never in argv, allowlisted environment, empty working directory, help-probe refusal and caching, managed-policy refusal before start, typed failures, and deadline/cancel reaping of the owned tree (`ai/cli_tests.rs`).

The final combined native regression run passed **66 tests** (37 AI service fixtures plus broker admission, process ownership and config/watch regressions). Its log is `/tmp/te-ai-native-regression.log`; fixture runs contain no paid provider requests. Full browser/plugin acceptance is owned by the coordinator. Native OS credential stores and Windows/macOS process/replacement behavior still need qualification on those operating systems.
