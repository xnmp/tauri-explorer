# CLI text adapters: isolation and refusal rules

Short-text requests (Trace prompt titles and other consumers of the host text service) can run through the **Codex CLI** (the default profile) or the **Claude Code CLI** using the CLI's saved login. A title request must never become an agent run. The code is `src-tauri/src/ai/cli.rs`, and its tests are in `src-tauri/src/ai/cli_tests.rs`.

Evidence was gathered on 2026-10-10 from the installed **codex-cli 0.162.0** (`codex exec --help`) and **Claude Code 2.1.296** (`claude --help`), from the official documentation linked below, and from the Codex `rust-v0.162.0` source. Only `--help` was run. No login, generation or provider request was made.

## How a request runs

1. **Model check.** The model ID must be 1–128 characters from `A-Z a-z 0-9 . _ - : / @ [ ] +` and must not start with `-`. It is the only variable value in argv, so it cannot inject an option or cmd.exe syntax.
2. **Managed-policy check.** This runs before any process starts; see [Refusal](#refusal).
3. **Executable discovery.** The configured absolute path is used, or the CLI is discovered on PATH, nvm/volta/npm/bun bins and Homebrew. On Windows the candidates are `<name>.exe`, then the npm shim `<name>.cmd`. Rust std runs `.cmd` files through cmd.exe with batch-argument escaping. Argv therefore stays fixed, short (under 4 KiB against cmd.exe's 8191-character limit) and free of `" % ! ^ & | < >`.
4. **Help probe.** `codex exec --help` or `claude --help` runs with a 4 s bound. Its option names are matched as exact tokens. The outcome is cached per executable identity (resolved path, size and mtime), so an upgrade probes again. Only a completed listing is cached. Spawn failures, timeouts, failed listings (for example a missing Node runtime) and probes interrupted by cancellation are retried on the next request. An interrupted probe reports `cancelled` or `timed_out`.
5. **Run.**
   - The working directory is a fresh empty temporary directory. The prompt file sits beside it, not inside it, and both are removed afterwards.
   - The prompt (caller instructions, plus the input framed as JSON data) is passed on **stdin** only.
   - The process runs under the host's owned supervision (`process_ext::output_with_stdin`): a Unix process group or Windows job object, bounded stdout/stderr, and the whole tree killed on deadline or cancellation.
6. **Result.** Only the final assistant text is returned, and it must pass the shared `final_text` rules. Each of the following is a typed error and never partial text:
   - a nonzero exit (`provider_failed`);
   - a truncated or invalid event stream, or no completion (`invalid_response`);
   - an empty result or missing text field (`invalid_response`);
   - any tool activity (`invalid_response`);
   - a provider-reported failure (`provider_failed`).

## Environment

The child starts from a **cleared environment** plus an allowlist:

- home and user identity: `HOME`, `USERPROFILE`, `USER`, …;
- locale and temp directories;
- XDG directories and the D-Bus session (for the OS keyring);
- the Windows system variables;
- proxy and CA variables;
- `PATH`, with the executable's directory first so npm shims find Node.

Per CLI, the child also gets `CODEX_HOME` and `CODEX_CA_CERTIFICATE` (Codex), or `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_GIT_BASH_PATH` (Claude). These keep the saved login, which lives under the CLI home, working.

CLI profiles have no credential source: they use the saved login only. Everything else is therefore withheld, so a request is never silently switched to API-key billing or another provider:

- `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`;
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`;
- base-URL and provider-routing variables such as `CLAUDE_CODE_USE_BEDROCK`;
- `NODE_OPTIONS`.

Claude also gets `DISABLE_AUTOUPDATER=1`, so that a background self-update never races the process-tree teardown.

## Codex CLI flags

`codex exec` is followed by these flags. The prompt is `-` (read from stdin). Help text is quoted from 0.162.0.

| Flag | Why |
| --- | --- |
| `--ignore-user-config` | "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`". This drops user MCP servers, profiles and features while keeping the saved login. |
| `--ignore-rules` | "Do not load user or project execpolicy `.rules` files". |
| `--ephemeral` | "Run without persisting session files to disk". |
| `--skip-git-repo-check` | The working directory is an empty temp directory, not a repository. |
| `--sandbox read-only` | The strongest sandbox. Any command that slipped through could not write. |
| `--json` | JSONL events. Only `agent_message` text, after `turn.completed`, is accepted. |
| `--model <id>` | An explicit model; Codex never picks one. |
| `-c features.<f>=false` | This disables every tool, hook, agent, plugin and connector feature: shell/unified exec, view_image, image_generation, hooks, multi_agent(+v2), apps, plugins, remote_plugin, tool_suggest, skills, goals, memories, computer/browser use, code mode, standalone web search, request_permissions and the MCP 2026-07-28 features. `-c` is used instead of `--disable`: `--disable` rejects an unknown name ("Unknown feature flag", `codex-rs/cli/src/main.rs`), while an unknown `-c features.*` key is only a warning (`codex-rs/features/src/lib.rs`). A renamed feature therefore cannot break titles. |
| `-c web_search=disabled`, `-c approval_policy=never`, `-c project_doc_max_bytes=0` | No web search, no approval prompts (anything needing approval is refused) and no AGENTS.md project docs. These are bare TOML words, so cmd.exe needs no quotes. |

`exec` has no switch that removes all tools. Isolation is therefore the feature set plus the read-only sandbox. As a backstop, any `item.completed` other than `agent_message`, `reasoning` or `error` fails the request. Codex reports config warnings as `error` items; fatal errors arrive as `error` or `turn.failed` events.

## Claude Code CLI flags

The prompt is read from stdin; there is no positional prompt. Descriptions are from the [CLI reference](https://code.claude.com/docs/en/cli-reference) and the 2.1.296 help.

| Flag | Why |
| --- | --- |
| `--print` | Non-interactive. |
| `--output-format json` | A single `result` object. `subtype` must be `success`, `is_error` false, and `permission_denials` empty. |
| `--model <id>` | An explicit model. |
| `--tools ""` | "Use `""` to disable all tools". |
| `--disallowedTools mcp__*` | `--tools` "doesn't affect MCP tools; to deny those too, use `--disallowedTools "mcp__*"`". |
| `--strict-mcp-config` | No `--mcp-config` is passed, so no MCP servers load. |
| `--setting-sources ""` | Loads no user, project or local settings. The Agent SDK uses the same empty list. |
| `--safe-mode` | CLAUDE.md, skills, plugins, hooks, MCP, custom commands/agents, output styles and auto memory are not loaded. Auth and model selection still work. |
| `--restricted` | Removes code-running tools and WebFetch, ignores user/project/local settings, refuses bypass permissions. Needs v2.1.248+. |
| `--no-session-persistence` | No transcript is saved. |
| `--disable-slash-commands` | Disables all skills and commands. |
| `--no-chrome` | No browser integration. |
| `--permission-prompts none` | Anything that would prompt is denied. Needs v2.1.259+. |
| `--system-prompt <fixed text>` | Replaces the coding-agent prompt with a constant. No request text is passed here. |

`--bare` is not used: it ignores OAuth and keychain logins ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper").

## Refusal

A CLI profile is `unavailable` with an actionable message, and nothing is generated, when either of the following holds.

**The installed CLI lacks a required flag.** The message names the missing options, for example "Codex CLI lacks the options needed … : --ignore-rules. Update the CLI or use an HTTP language-model profile."

**Managed or organisation policy is present.** Both CLIs apply managed policy above command-line flags:

- Codex requirements can pin features, including hooks, on (`managed_features.rs`).
- Claude's `--safe-mode` keeps "policy-configured hooks".

The message names the policy source that was found. The sources checked are:

| CLI | Source | Location |
| --- | --- | --- |
| Codex | System requirements, legacy managed config and system config | `/etc/codex/{requirements.toml, managed_config.toml, config.toml}` on Unix; `%ProgramData%\OpenAI\Codex\{requirements.toml, config.toml}` on Windows ([managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration); `codex-rs/config/src/loader/mod.rs` at 0.162.0) |
| Codex | macOS MDM | `/Library/Managed Preferences[/<user>]/com.openai.codex.plist` |
| Codex | Cloud-managed config | The cache at `$CODEX_HOME/cloud-config-bundle-cache.json`. It is fetched only for Business, Education and Enterprise plans (`codex-rs/cloud-config/src/{cache,service}.rs`). |
| Claude | Managed files | `managed-settings.json`, `managed-settings.d/` and `managed-mcp.json` under `/etc/claude-code/` (Linux/WSL), `/Library/Application Support/ClaudeCode/` (macOS) or `%ProgramFiles%\ClaudeCode\` (Windows) ([managed settings](https://code.claude.com/docs/en/managed-settings)). On WSL, `/mnt/c/Program Files/ClaudeCode/` is also checked. |
| Claude | macOS MDM | `/Library/Managed Preferences[/<user>]/com.anthropic.claudecode.plist` |
| Claude | Windows registry | The `Settings` value under `HKLM\SOFTWARE\Policies\ClaudeCode` or `HKCU\SOFTWARE\Policies\ClaudeCode`. A key that is present but unreadable also counts. |
| Claude | Server-managed settings | The cache at `$CLAUDE_CONFIG_DIR/remote-settings.json`, or `~/.claude/remote-settings.json` ([server-managed settings](https://code.claude.com/docs/en/server-managed-settings)) |

## Known limits

- **Organisation policy without a local cache.** Server- or cloud-delivered policy can be fetched during the run itself and cannot be detected beforehand: a first run after login, or Claude settings that need approval, which `-p` runs apply without caching. The host deliberately does not read login tokens to infer the account's plan. A policy change between the check and the run (time-of-check/time-of-use) is likewise not excluded. The backstops are:
  - the event and result checks reject any tool activity;
  - the read-only sandbox and empty tool set still apply;
  - every request runs in an empty, owned and reaped process tree.
- **Global instructions.** Codex may still include `$CODEX_HOME/AGENTS.md` as global instructions. That affects wording only; it cannot add tools.
- **Windows.** Windows behaviour (job-object reaping of a `.cmd` shim, registry detection) is covered by `cli_cancellation_reaps_a_cmd_shim_process_tree` and type-checked for `x86_64-pc-windows-msvc`. Both run only in Windows CI, not locally.
