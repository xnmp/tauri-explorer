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

## Folder agent

Purpose (#1884): answer a question about the files of one folder in one job,
for example "for every file, find the invoice date; reply with JSON keyed by
file name" for an AI Details column (#1886). A cheap model runs as a read-only
agent in the folder and reads only the files it needs. No file content is
pasted into the prompt. Code: `src-tauri/src/ai/` (`Service::run_agent`,
`cli::run_agent`, `agent_folder.rs`; tests in `agent_tests.rs`); frontend
`src/lib/api/ai-agent.ts`, `src/lib/domain/ai-agent.ts`; plugin SDK `ctx.agent`
(capability `folderAgent`).

**Commands** (per-window agent callers, `agent:window:<label>`, separate from
the `window:<label>` caller of `ai_text_*`):

- `ai_agent_describe` → `{version:1, enabled, available, configurationRevision, context?, models, defaultModel?, readScope?, isolation?, maxTimeoutMs, maxConcurrent, error?}`. It runs only the CLI's `--help` probe and is bounded to 5 s.
- `ai_agent_run {requestId, folder, instructions, input, model?, maxOutputTokens, timeoutMs?, maxTurns?, expectedConfigurationRevision?}` → `{text, model, usage?}`.
- `ai_agent_cancel {requestId}` → `true`.

Errors are the shared `{code, message}`. Agent-specific codes are
`unsupported` (no CLI connection), `not_found` (folder missing),
`configuration_changed` (see Limits), `timed_out` with a folder message (folder
resolution did not return in time) and, from the plugin SDK only,
`folder_not_open`.

**Connection.** Only the CLI transports (`claude-code-cli`, `codex-cli`) can
run agents. The default profile is used when it is a CLI; otherwise the first
CLI profile in the list is used. With only HTTP profiles, `describe` reports
`available:false` and `error.code:"unsupported"`, and `run` refuses with the
same code before anything starts. Executable resolution, the managed-policy
refusal, the help probe, the cleared environment and the prompt on stdin are
the text adapter's ([CLI text isolation](shared-ai-cli-text-isolation.md)).

**Models.** `models` lists the IDs `run` accepts, cheapest first, and
`defaultModel` is the cheapest:

- Claude: `haiku`, `sonnet`, `opus`. These are the CLI's aliases (`claude --help`: "an alias for the latest model"); `haiku` ran as `claude-haiku-5-5` with 2.1.330.
- Codex: `gpt-6-luna`, the host's default Codex model, which Codex's model catalog describes as its "fast and affordable" model.
- The profile's own model is always accepted as well. Any other model is refused as `invalid_request`.

**Folder.** Two layers decide where a job may run.

1. *Plugin SDK* (`src/lib/plugins/plugin-agent.ts`): `ctx.agent.run` refuses
   (`folder_not_open`) a folder that is not the path of a pane open in one of
   this window's tabs (`windowTabsManager.getAllExplorers()`, compared with
   `sameDirectory`). It is checked once, when the job starts; navigating away
   later does not cancel it (the plugin's abort signal does). It is a
   frontend check that stops a plugin from aiming the agent at a folder the
   user is not looking at. It is not a security boundary against code
   calling `ai_agent_run` directly, since any code in the window can invoke
   the command.
2. *Native policy* (`agent_folder.rs`, `FolderPolicy`). It binds every
   caller and is the boundary. The folder must be an absolute path to an
   existing directory. It is canonicalized (symlinks resolved), the rules
   below are applied to the canonical path, and the canonical directory
   becomes the CLI's working directory; it is not passed in argv. Refused:
   - relative paths;
   - virtual `<scheme>://` paths, `trash://` included;
   - missing paths (`not_found`) and anything that is not a directory;
   - trash storage: `$XDG_DATA_HOME/Trash`, `.Trash`, `.Trash-<uid>`, `$Recycle.Bin`;
   - the filesystem root, the home folder, and every ancestor of home (`/home`, `/Users`, `C:\Users`);
   - any folder inside home with a path component starting with `.` (`~/.ssh`, `~/.config/…`, `~/src/.git`);
   - OS system trees, with everything beneath them. On Unix: `/proc`, `/sys`, `/dev`, `/etc`, `/run`, `/boot`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/var`, `/opt`, `/snap`, `/nix`. On macOS, also `/System`, `/Library`, `/private`, `/Applications`. On Windows: `%SystemRoot%`, both Program Files, `ProgramData`, `%APPDATA%` and `%LOCALAPPDATA%`. A tree that contains home (Fedora Atomic's `/var/home`) does not refuse folders inside home;
   - Windows network shares (`\\server\share`, `\\?\UNC\…`).

   The rules are a pure, table-tested function (`FolderPolicy::refusal`).
   Unix network mounts (NFS, SMB, sshfs) are not detected and are allowed.
   Resolution runs in its own pool of 2 blocking workers with a 5 s timeout,
   separate from the settings and text workers. A hung mount therefore fails
   the job as `timed_out` and holds only a folder worker until the OS
   returns. It never delays text requests or settings. Two such hangs hold
   both folder workers, so later agent jobs, even on healthy folders, fail
   as `unavailable` (waiting behind folders that stopped responding) until
   the OS returns those calls.

**Isolation actually achieved.**

| | Claude Code CLI | Codex CLI |
| --- | --- | --- |
| Tools | `--tools Read,Glob,Grep`; `--disallowedTools mcp__*,Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch`. Every other text isolation flag is kept: `--restricted`, `--safe-mode`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-prompts none`, `--no-session-persistence`, `--disable-slash-commands`, `--no-chrome` and a fixed `--system-prompt`. | Codex has no file-read tool; it reads with its shell tool. Every other tool, hook, agent, plugin, connector and web-search feature stays disabled, `approval_policy=never`, and `project_doc_max_bytes=0` (the folder's AGENTS.md is not loaded). |
| Reads | **Confined to the folder, enforced by the CLI** (`readScope:"folder"`). `--restricted` "confines the file tools to the working directories". Verified with Claude Code 2.1.330 on Linux: absolute paths, `../` paths, a symlinked file and a symlinked directory pointing outside, and Grep/Glob with an outside path were all refused ("… is outside …; --restricted confines the file tools to the working directory"). Recursive Grep/Glob inside the folder did not follow those symlinks. | **Requested through a permission profile** (`readScope:"folderRequested"`): `default_permissions=tauri_explorer_folder_agent` with filesystem `{':root'='deny', ':minimal'='read', ':workspace_roots'='read', '<codex install dir>'='read'}` and `network.enabled=false`. `--sandbox` is not passed, because it would select the legacy policy. Codex's own files must be readable because the Linux sandbox re-executes Codex. The grant is the narrowest the install allows: the native executable file itself; the `@openai/codex` package directory for an npm `codex.js` launcher; `node_modules/@openai/codex` beside a Windows npm shim. Any other launcher, a grant that is the root, home or an ancestor of home, and a path with quotes or cmd.exe metacharacters make `describe` report agents unavailable with the reason. The folder rules about dot-folders and system trees do not apply to this grant: an install under `~/.nvm` or `/usr/local` is ordinary, and only its own files are granted. Verified with 0.169.0 on Linux for both the vendored native binary and the npm launcher. Verified with codex-cli 0.169.0 on Linux (bubblewrap): files outside the folder and both symlinks were "No such file or directory", `~` listed empty, and inside reads worked. Permission profiles are a Codex **beta**, and a version without them ignores these keys. It then falls back to the read-only sandbox, which can **read the whole disk**; the host cannot detect that from `--help`. macOS (Seatbelt) and Windows enforce profiles with their own sandboxes. Codex documents that it refuses to run a command it cannot sandbox, but this host has not verified that on macOS or Windows. |
| Writes, shell, network | No write, edit or shell tool exists in the session. Web tools are denied. | Commands run in the sandbox with no writable path and no network. `approval_policy=never` refuses any escalation. |
| Output check | `permission_denials` are allowed (a refused outside read is confinement working). | `command_execution` items are allowed. Any other tool item (`file_change`, `mcp_tool_call`, `web_search`, …) fails the job as `invalid_response`. |

`describe().isolation` states the same per connection.

**Limits.**

- Deadline: `timeoutMs` covers the whole job, queueing included. It defaults to 120 s and is capped at 300 s; larger values are clamped, and 0 is refused. The profile's 1–45 s text timeout does not apply.
- Concurrency: at most 2 agent jobs run at once across all callers, in their own pool; others queue within their deadline. A running agent job never holds a text slot. Agent jobs do still briefly take a shared settings worker to read the configuration snapshot, and the global admission bounds (36 live, 32 queued) are shared, so text and agents are not fully independent.
- Quota: agent jobs have their own caller identity per window (`agent:window:<label>`) and their own per-caller limit of 6 (2 running + 4 queued). They never use a window's text quota of 8.
- Turns: Claude Code gets `--max-turns` only when its `--help` lists the flag (2.1.330 does not). The limit is the request's `maxTurns` (1–40), else 40. Codex has no turn or budget flag. For a CLI without one, the only bound is the deadline (≤ 300 s).
- Configuration changes: saving the AI settings (enable/disable, profile edits, credentials) or another process's write seen by the config watcher announces a new configuration revision. Live and queued agent jobs pinned to an older revision are cancelled with `configuration_changed`, and their process trees are killed.
- Cancellation records: cancelling a live job stops it, and cancelling a recently finished one does nothing; neither leaves a record. Only a cancel for a request ID not yet seen is recorded (120 s), so that a cancel that overtakes its own `run` still refuses that run, and the refusal consumes the record. Cancelling on every navigation therefore cannot fill a caller's records (64 per caller).
- Sizes: instructions plus input are at most 64 KiB, and `maxOutputTokens` is 1–16384 (a prompt hint). The final text is at most 256 KiB, and CLI stdout is bounded to 32 MiB.
- Cancellation (`ai_agent_cancel`, a closed window, the deadline, a configuration change, `cancel_all` at exit) kills the CLI's owned process tree, exactly like text requests: on Unix, a SIGKILL to the process group; on Windows, the job object. The agent slot is released only after that kill.
- Residual risk: on Unix, a descendant that leaves the process group (`setsid`/`setpgid`) escapes the group kill. On Linux, Codex's bubblewrap sandbox runs with `--die-with-parent` and does not start a new session (from the 0.169.0 binary's strings). Host tests cover a CLI child and grandchild, not a real sandboxed Codex grandchild. On macOS, whether Seatbelt-sandboxed Codex commands stay in the group has not been checked.

**Privacy.** The provider sees whatever files the agent reads, as well as the
instructions and input. Anything readable in the folder (subfolders included)
can be sent. A file in the folder can also carry instructions that steer the
model, for example to read other files in the folder; it cannot reach past the
confinement above. Consumers should tell users which folder a job reads, and
should run jobs only on request or on a folder the user opted in.

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
