# Shared AI contracts — implementation conventions

Target: `origin/dev` at `3ebfba5792379026f749afed78cb2c65736534a7`.
Trace target: `origin/main` at `cae90fb4344375cf8fc1453df74f50ecdc0b4d55`.

Pure validation/state transitions belong in domain modules. Components render state and invoke services; async coordination belongs in state/service modules. Native IO is bounded and owned. Do not hold database or global lifecycle locks over provider IO. Use bun. Automated adapters use fake CLIs and local HTTP; no paid requests. Work only in the assigned checkout using relative paths. The coordinator owns host SDK, broker initialization/routing, reverse RPC IDs, and Trace integration. Changes to these seams require agreement.

## Text v1

Capability `textGeneration`; initialization `textService: {version:1}`.
Reverse methods `host.text.describe`, `host.text.generate`, `host.text.cancel`.
Native UI commands: `ai_connections_read`, `ai_connections_save` (configuration, expectedRevision), `ai_connection_set_credential` (profileId, key, expectedRevision), `ai_connection_clear_credential` (profileId, expectedRevision), `ai_connection_check` (profileId), `ai_connection_test` (profileId, requestId, expectedConfigurationRevision), `ai_connection_cancel_test` (requestId).
Committed event `ai:text-configuration-changed` contains `{revision}`.

Configuration: `{schemaVersion:1, revision:number, enabled:boolean, defaultProfileId:string|null, profiles:TextProfile[]}`. Shared profile fields: `id`, `name`, `model`, `timeoutMs`.
CLI: `transport:codex-cli|claude-code-cli`, `executablePath:string` (empty means discovery). HTTP: `transport:openai-chat-completions|anthropic-messages`, `baseUrl:string`, `allowInsecureHttp:boolean`, `credential:{kind:none}|{kind:environment,name:string}|{kind:secret,id:string}`. Sanitized reads also expose `hasCredential:boolean` on HTTP profiles. Incoming sanitized presence fields must be ignored or removed before saving. Keys never enter configuration, consumer responses or fingerprint.
Enabled requires an existing selected profile. Disabled allows an empty list/null selection. Model IDs remain editable strings.

Describe: `{version:1, enabled:boolean, available:boolean, configurationRevision:number, context?:TextContext, error?:ServiceError}`. Context: `{profileId, configurationRevision, fingerprint, transport, requestedModel, actualModel?}`. `available` is local configured availability, never a paid/authentication probe. An absent host capability yields quiet fallback.
Generate request: `{requestId,instructions,input,maxOutputTokens,timeoutMs?,expectedConfigurationRevision?}`. Result: `{text,context,usage?}`. Cancel: `{requestId}`. Native interface: `ai::describe()`, `ai::generate(caller:String, request:Value)`, `ai::cancel(caller:&str, request_id:&str)`, `ai::cancel_caller(caller:&str)`; use async functions for execution. Safe wire errors: `{code,message,retryAfterMs?}`. Rust errors may implement Serialize/display but never contain raw provider responses.

Caller is broker-derived package/incarnation. 64 KiB combined input/instructions; max 4 active, 32 pending; per caller quota; total deadlines include queueing, max 45s for Trace. No automatic retries. HTTP roots include prefix/version and append `chat/completions` or `messages`; reject userinfo/query/fragment; redirects disabled.
CLI isolation preserves saved login, clears API-key override environment, no external tools/rules/project config. Unsupported isolation is explicit unavailable. CLI docs/help inspected: Codex 0.162.0 and Claude Code 2.1.296 (2026-10-10). Default must be documented against available official evidence. Do not use Claude `--bare` because it disables saved-login auth.

Trace title recipe v1: concise 2–6 word title, prompt treated as data, same language, text only, maximum 120 Unicode scalars, one line. Request maxOutputTokens=64, timeoutMs=45000. Additive cache keyed by prompt SHA256, recipe version, host fingerprint. Legacy cache untouched. Describe before cache lookup/generation; generate expected configuration revision; actual response context must match. Native summary migration copies legacy off only when `plugin.trace.json.summarizePrompts` is absent, respecting symlinked legacy config.

## Ownership of work

- Native text agent: `src-tauri/src/ai/**`, credential abstraction/dependencies, native command registration, config/migration primitives and tests.
- UI agent: TS text domain/API/state, settings components and SettingsDialog integration, tests and mocks. No native or SDK edits.
- Coordinator: broker/SDK integration, code map integration, Trace changes, service/image contracts and further extraction.

Tracking issue publication was rejected by automatic approval review; local work proceeds without publishing. No release or user-app installation is authorized.

## Implementation-time decision: CLI availability

Codex CLI and Claude Code CLI text generation are enabled with enforced isolation:

- the installed CLI's isolation flags;
- an empty working directory;
- an allowlisted environment (saved login kept, API keys withheld);
- the prompt on stdin;
- owned process-tree cancellation.

A profile is `unavailable` only when managed or organisation policy is detected, or when the installed CLI lacks a required isolation flag. Policy can force hooks or tools on above command-line flags. Details, evidence and limits: [CLI text isolation](shared-ai-cli-text-isolation.md).

## Owned processes (`host.process.run`)

Reverse request from a plugin backend; the host runs the program as an owned process tree (SDK 3 on Unix: the parent-death-safe supervisor; Windows: a kill-on-close job). Implementation: `src-tauri/src/installed_plugins/process_run.rs`. Plugin side: Trace `crates/plugin-runtime/src/process.rs`, whose `ProcessRequest` has this exact shape.

Params (unknown fields are refused): `{program, args, cwd, env, stdoutLimit, stderrLimit, stdin?, consumerPackageId?, operationId?}`. `program` is an absolute path; at most 128 `args` of 64 KiB each; `cwd` is a path or null; `env` is at most 128 `[name, value|null]` pairs, where null removes the variable; `stdoutLimit` ≤ 16 MiB and `stderrLimit` ≤ 1 MiB. The result is `{handle, status, stdout, stderr}`, where `stdout`/`stderr` are spool paths kept until `host.process.release {handle}`. `host.process.cancel {requestId}` cancels a run; the plugin runtime sends it on its own cancellation or deadline.

**Complete output custody.** SDK 3 hosts reserve spool capacity before execution and fsync complete stdout/stderr plus a completion manifest before replying. Complete output survives broker failure, compatible replacement and host restart, including a lost reply; cancellation cannot erase a completed execution. `initialize` advertises `processRecovery: {version: 1, owner: {packageId, digest, incarnation}}`. Persist that original owner together with the reverse request ID before execution. `host.process.recover {requestId, owner}` returns the original `{handle, owner, status, stdout, stderr}` without running the process. An omitted owner is accepted only when the request ID identifies exactly one retained execution; IDs reused across incarnations are rejected as ambiguous. Release complete output only after preserving the provider's original bytes or sealing them into artifact custody.

**Operation custody.** A run done for a shared-service operation names it with `consumerPackageId` and `operationId`, both or neither. Hosts that accept them advertise `processCustody: {version: 1}` in `initialize`; older hosts refuse the fields as unknown, so providers detect the capability and never compare versions. The host binds that run's complete output to the operation's admission before spawning: a lost reply is retained and recoverable for that operation, keeps it from settling as no-output work, and is released when the operation settles, is discarded or its consumer is removed. Custody needs an admission of the calling provider package that is not released and has no failed or cancelled receipt, and either is active (forwarding or accepted, execution not released) for the calling provider generation or holds that operation's unpaid recovery permit. Anything else is refused before spawning as `not_started`, whose message names the reason (internally `process_custody_refused`). A run without custody (a login check, a version probe, a credential helper) is never bound to any operation: the host does not infer custody from the provider's other admissions, because settled Unknown history stays unreleased by design and live operations can run concurrently. Its output is retained only until `host.process.release`, and a successful unreleased reply still keeps the provider generation's unpaid status discovery alive. Hosts between the custody fields and the capability inferred custody from every unreleased admission of the provider; that refused every custody-less run once settled history existed (tauri-explorer#1172).

**Stdin.** Hosts that accept `stdin` advertise `processStdin: {version: 1, maxBytes: 262144}` in `initialize`. `stdin` is a UTF-8 string of at most `maxBytes` bytes (256 KiB). The whole request frame must still fit the 1 MiB plugin frame. The host writes the bytes to the child's stdin on a dedicated thread and then closes it; an absent or null `stdin` means stdin is null. A child that exits or closes stdin without reading it is an ordinary outcome: its exit status and output stand. A child that never reads cannot block the host, and cancellation and deadline reaping still apply. Older hosts don't advertise the capability and refuse the field as unknown, so plugins detect the capability and never compare versions.

**Errors** (`error.data.code`). Each refusal before spawning has its own code, so a plugin can tell "never ran" from "may have run":

| Code | Meaning | Could the program have run? |
|---|---|---|
| `invalid_request` | Malformed request, unknown field, invalid request ID, or a limit exceeded (including `stdin` over `maxBytes`) | No |
| `capacity_reached` | The plugin already has 4 running processes or 8 retained output spools | No |
| `not_found` | The executable or working directory does not exist | No |
| `permission_denied` | The executable or working directory is not accessible | No |
| `not_started` | Any other refusal or failure before the program executed: the plugin is not active, a lifecycle change or shutdown, call admission, output spool or supervision setup, worker start, cancellation before spawn, or another spawn error | No |
| `interrupted` | The program was spawned and did not return a complete result: cancellation, an output limit, supervision loss or spool failure | Maybe |
| `protocol_error` | The request ID belongs to a process that is still running; the reply reaches that process's waiter | Maybe |

`preflight_not_active` (a validation-only backend) is refused before dispatch, as for every host service. Hosts before these codes reported every pre-spawn refusal as `service_unavailable` (and SDK 3 post-spawn failures as `interrupted`). A plugin must keep treating `service_unavailable` as uncertain.
