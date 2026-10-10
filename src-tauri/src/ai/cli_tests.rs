//! CLI text adapter contracts, exercised against fake CLIs only. No real CLI is
//! started and no provider is contacted.
use super::{cli, domain::*, Control};
use serde_json::json;
#[cfg(unix)]
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::{Duration, Instant},
};

const INSTRUCTIONS: &str = "Summarize input as a title";
const INPUT: &str = "An example prompt about lighthouses";
const CODEX_HELP: &str = "--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check -s, --sandbox <SANDBOX_MODE> --json -m, --model <MODEL> -c, --config <key=value>";
const CLAUDE_HELP: &str = "-p, --print --output-format <format> --model <model> --tools <tools...> --disallowedTools, --disallowed-tools <tools...> --strict-mcp-config --setting-sources <sources> --safe-mode --restricted --no-session-persistence --disable-slash-commands --no-chrome --permission-prompts <target> --system-prompt <prompt>";
const SECRET_ENV: &[&str] = &[
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "NODE_OPTIONS",
];

#[cfg(unix)]
pub(super) fn kinds() -> [(&'static str, &'static str); 2] {
    [("codex", CODEX_HELP), ("claude", CLAUDE_HELP)]
}
pub(super) fn profile(kind: &str, executable: &Path, model: &str) -> Profile {
    let executable_path = executable.to_string_lossy().into_owned();
    Profile {
        id: "cli".into(),
        name: "CLI fixture".into(),
        model: model.into(),
        timeout_ms: 45_000,
        connection: if kind == "codex" {
            Connection::Codex { executable_path }
        } else {
            Connection::Claude { executable_path }
        },
    }
}
fn text_request() -> Request {
    serde_json::from_value(json!({"requestId":"x","instructions":INSTRUCTIONS,"input":INPUT,"maxOutputTokens":64,"timeoutMs":2000})).unwrap()
}
fn control(deadline: Duration) -> Arc<Control> {
    let now = Instant::now();
    Arc::new(Control {
        cancelled: AtomicBool::new(false),
        active: AtomicBool::new(false),
        deadline: Mutex::new(now + deadline),
        started: now,
        owner: Arc::new(|| false),
    })
}

/// A fixture environment: a saved-login home plus every credential/routing
/// variable a CLI profile must never forward.
struct Fixture {
    _root: tempfile::TempDir,
    vars: HashMap<String, OsString>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let mut vars: HashMap<String, OsString> = HashMap::new();
        for (key, dir) in [
            ("HOME", "home"),
            ("CODEX_HOME", "codex-home"),
            ("CLAUDE_CONFIG_DIR", "claude-config"),
        ] {
            let path = root.path().join(dir);
            fs::create_dir_all(&path).unwrap();
            vars.insert(key.into(), path.into());
        }
        for key in SECRET_ENV {
            vars.insert((*key).into(), format!("fixture-{key}").into());
        }
        for key in [
            "TMPDIR",
            "TMP",
            "TEMP",
            "SystemRoot",
            "windir",
            "ComSpec",
            "PATHEXT",
            "SystemDrive",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some(value) = std::env::var_os(key) {
                vars.insert(key.into(), value);
            }
        }
        Self { _root: root, vars }
    }
    fn env(&self) -> impl Fn(&str) -> Option<OsString> + '_ {
        move |key| self.vars.get(key).cloned()
    }
    fn var(&self, key: &str) -> PathBuf {
        PathBuf::from(&self.vars[key])
    }
    fn run(&self, kind: &str, executable: &Path, control: &Control) -> Result<String> {
        let env = self.env();
        cli::run(
            &profile(kind, executable, "fixture-model"),
            &text_request(),
            control,
            &env,
        )
        .map(|(text, _, _)| text)
    }
}

/// Writes an executable fake and waits until it can be exec'd. Another test
/// thread's `fork` inherits the write descriptor until that child execs, and
/// exec of a file still open for writing fails with ETXTBSY (see
/// `files::git_status::tests::write_fake_git`, #764).
#[cfg(unix)]
fn write_executable(path: &Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    for _ in 0..1000 {
        match std::process::Command::new(path)
            .arg("__exec_probe")
            .status()
        {
            Ok(status) => {
                assert!(status.success(), "fake CLI probe failed: {status}");
                return;
            }
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("fake CLI cannot run: {error}"),
        }
    }
    panic!("fake CLI stayed busy after 1000 exec attempts");
}

/// A Python fake CLI. `--help` appends its argv to `help.log` and prints
/// `help`; any other invocation records argv, environment, working directory,
/// its entries and stdin to `run.json`, then prints `stdout` and exits `code`.
#[cfg(unix)]
pub(super) fn fake_cli(dir: &Path, kind: &str, help: &str, stdout: &str, code: i32) -> PathBuf {
    let script = dir.join(kind);
    write_executable(
        &script,
        &format!(
            r#"#!/usr/bin/env python3
import json,os,sys
if sys.argv[1:]==['__exec_probe']: sys.exit(0)
record={record:?}
argv=sys.argv[1:]
if '--help' in argv:
    open(os.path.join(record,'help.log'),'a').write(json.dumps(argv)+'\n')
    print({help:?})
    sys.exit(0)
data=sys.stdin.read()
json.dump({{'argv':argv,'env':dict(os.environ),'cwd':os.getcwd(),'entries':os.listdir('.'),'stdin':data}},open(os.path.join(record,'run.json'),'w'))
sys.stdout.write({stdout:?})
sys.exit({code})
"#,
            record = dir.to_string_lossy(),
        ),
    );
    script
}
#[cfg(unix)]
pub(super) fn success_output(kind: &str) -> String {
    if kind == "codex" {
        [
            json!({"type":"thread.started","thread_id":"fixture"}),
            json!({"type":"item.completed","item":{"type":"reasoning","text":"Do not return reasoning"}}),
            json!({"type":"item.completed","item":{"type":"agent_message","text":"Fixture title"}}),
            json!({"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}),
        ]
        .map(|v| v.to_string() + "\n")
        .concat()
    } else {
        json!({"type":"result","subtype":"success","is_error":false,"result":"Fixture title","permission_denials":[],"usage":{"input_tokens":10,"output_tokens":2}}).to_string()
    }
}
#[cfg(unix)]
fn help_count(dir: &Path) -> usize {
    fs::read_to_string(dir.join("help.log"))
        .map(|log| log.lines().count())
        .unwrap_or(0)
}

#[cfg(unix)]
#[test]
fn cli_runs_isolated_with_prompt_on_stdin_and_returns_only_final_text() {
    for (kind, help) in kinds() {
        let fixture = Fixture::new();
        let dir = tempfile::tempdir().unwrap();
        let executable = fake_cli(dir.path(), kind, help, &success_output(kind), 0);
        let text = fixture
            .run(kind, &executable, &control(Duration::from_secs(10)))
            .unwrap();
        assert_eq!(
            text, "Fixture title",
            "{kind}: reasoning is never the answer"
        );

        let record: Value =
            serde_json::from_slice(&fs::read(dir.path().join("run.json")).unwrap()).unwrap();
        let argv: Vec<&str> = record["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        if kind == "codex" {
            assert_eq!(
                argv[..10],
                [
                    "exec",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "read-only",
                    "--json",
                    "--model",
                    "fixture-model"
                ]
            );
            assert_eq!(argv.last(), Some(&"-"), "codex reads the prompt from stdin");
            let overrides: Vec<&str> = argv[10..argv.len() - 1]
                .chunks(2)
                .map(|pair| {
                    assert_eq!(pair[0], "-c", "{argv:?}");
                    pair[1]
                })
                .collect();
            for feature in [
                "shell_tool",
                "unified_exec",
                "hooks",
                "apps",
                "plugins",
                "multi_agent",
                "image_generation",
                "computer_use",
                "browser_use",
                "memories",
                "code_mode",
                "code_mode_host",
            ] {
                assert!(
                    overrides.contains(&format!("features.{feature}=false").as_str()),
                    "{feature} must be disabled: {overrides:?}"
                );
            }
            for setting in [
                "web_search=disabled",
                "approval_policy=never",
                "project_doc_max_bytes=0",
            ] {
                assert!(overrides.contains(&setting), "{setting}: {overrides:?}");
            }
            assert!(overrides
                .iter()
                .all(|o| o.ends_with("=false") || !o.starts_with("features.")));
        } else {
            let prompt = argv.iter().position(|a| *a == "--system-prompt").unwrap();
            let mut fixed = argv.clone();
            fixed.remove(prompt + 1);
            assert_eq!(
                fixed,
                [
                    "--print",
                    "--output-format",
                    "json",
                    "--model",
                    "fixture-model",
                    "--tools",
                    "",
                    "--disallowedTools",
                    "mcp__*",
                    "--strict-mcp-config",
                    "--setting-sources",
                    "",
                    "--safe-mode",
                    "--restricted",
                    "--no-session-persistence",
                    "--disable-slash-commands",
                    "--no-chrome",
                    "--permission-prompts",
                    "none",
                    "--system-prompt",
                ]
            );
        }
        for arg in &argv {
            assert!(
                !arg.contains("lighthouses") && !arg.contains("Summarize input"),
                "{kind}: request text reached argv: {arg:?}"
            );
        }
        let stdin = record["stdin"].as_str().unwrap();
        assert!(
            stdin.contains(INSTRUCTIONS) && stdin.contains(INPUT),
            "{stdin}"
        );

        let cwd = PathBuf::from(record["cwd"].as_str().unwrap());
        assert_eq!(record["entries"], json!([]), "{kind}: cwd must be empty");
        assert_ne!(cwd, std::env::current_dir().unwrap());
        assert!(!cwd.exists(), "{kind}: the isolated directory is removed");

        let env = record["env"].as_object().unwrap();
        for key in SECRET_ENV {
            assert!(!env.contains_key(*key), "{kind}: {key} was forwarded");
        }
        assert_eq!(env["HOME"], json!(fixture.var("HOME").to_string_lossy()));
        let (home_key, other_key) = if kind == "codex" {
            ("CODEX_HOME", "CLAUDE_CONFIG_DIR")
        } else {
            ("CLAUDE_CONFIG_DIR", "CODEX_HOME")
        };
        assert_eq!(
            env[home_key],
            json!(fixture.var(home_key).to_string_lossy())
        );
        assert!(!env.contains_key(other_key));
        assert_eq!(
            env.get("DISABLE_AUTOUPDATER").and_then(Value::as_str),
            (kind == "claude").then_some("1")
        );
        let allowed = [
            "HOME",
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "TMPDIR",
            "TMP",
            "TEMP",
            "PATH",
            "DISABLE_AUTOUPDATER",
            // Python's PEP 538 locale coercion and macOS add these themselves.
            "LC_CTYPE",
            "__CF_USER_TEXT_ENCODING",
        ];
        for key in env.keys() {
            assert!(allowed.contains(&key.as_str()), "{kind}: unexpected {key}");
        }
    }
}

#[cfg(unix)]
#[test]
fn cli_help_probe_runs_once_per_executable_identity() {
    for (kind, help) in kinds() {
        let fixture = Fixture::new();
        let dir = tempfile::tempdir().unwrap();
        let executable = fake_cli(dir.path(), kind, help, &success_output(kind), 0);
        for _ in 0..2 {
            fixture
                .run(kind, &executable, &control(Duration::from_secs(10)))
                .unwrap();
        }
        assert_eq!(help_count(dir.path()), 1, "{kind}: probe is cached");
        let help_argv = fs::read_to_string(dir.path().join("help.log")).unwrap();
        let expected = if kind == "codex" {
            "[\"exec\", \"--help\"]"
        } else {
            "[\"--help\"]"
        };
        assert_eq!(help_argv.trim(), expected);
        // An upgraded CLI is a different identity and is probed again.
        let upgraded = format!("{help} --upgraded-option");
        fake_cli(dir.path(), kind, &upgraded, &success_output(kind), 0);
        fixture
            .run(kind, &executable, &control(Duration::from_secs(10)))
            .unwrap();
        assert_eq!(help_count(dir.path()), 2, "{kind}: upgrade re-probes");
    }
}

#[cfg(unix)]
#[test]
fn cli_without_an_isolation_flag_is_unavailable_and_never_generates() {
    let required: [(&str, &[&str]); 2] = [
        (
            "codex",
            &[
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--skip-git-repo-check",
                "--sandbox",
                "--json",
                "--model",
                "--config",
            ],
        ),
        (
            "claude",
            &[
                "--print",
                "--output-format",
                "--model",
                "--tools",
                "--disallowedTools",
                "--strict-mcp-config",
                "--setting-sources",
                "--safe-mode",
                "--restricted",
                "--no-session-persistence",
                "--disable-slash-commands",
                "--no-chrome",
                "--permission-prompts",
                "--system-prompt",
            ],
        ),
    ];
    for (kind, flags) in required {
        for missing in flags {
            let fixture = Fixture::new();
            let dir = tempfile::tempdir().unwrap();
            // Longer look-alike options must not satisfy the exact flag.
            let help = flags
                .iter()
                .map(|flag| {
                    if flag == missing {
                        format!("{flag}-legacy")
                    } else {
                        flag.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let executable = fake_cli(dir.path(), kind, &help, &success_output(kind), 0);
            let error = fixture
                .run(kind, &executable, &control(Duration::from_secs(10)))
                .unwrap_err();
            assert_eq!(error.code, "unavailable", "{kind} {missing}");
            assert!(
                error.message.contains(&format!("{missing}."))
                    || error.message.contains(&format!("{missing},")),
                "{kind}: the message names {missing}: {}",
                error.message
            );
            assert!(
                !dir.path().join("run.json").exists(),
                "{kind}: no generation without {missing}"
            );
        }
    }
}

/// A user-writable cache of organisation policy exists only for managed
/// accounts. Refusal happens before any executable starts, on every OS.
#[test]
fn cli_under_managed_policy_is_refused_before_starting() {
    for (kind, cache_dir, cache) in [
        ("codex", "CODEX_HOME", "cloud-config-bundle-cache.json"),
        ("claude", "CLAUDE_CONFIG_DIR", "remote-settings.json"),
    ] {
        let fixture = Fixture::new();
        fs::write(fixture.var(cache_dir).join(cache), "{}").unwrap();
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let executable = fake_cli(
            dir.path(),
            kind,
            if kind == "codex" {
                CODEX_HELP
            } else {
                CLAUDE_HELP
            },
            &success_output(kind),
            0,
        );
        #[cfg(not(unix))]
        let executable = dir.path().join("never-started.exe");
        let env = fixture.env();
        let error = cli::check(&profile(kind, &executable, "fixture-model"), &env, &|| {
            false
        })
        .unwrap_err();
        assert_eq!(error.code, "unavailable", "{kind}");
        assert!(
            error.message.contains("managed policy") && error.message.contains(cache),
            "{kind}: {}",
            error.message
        );
        #[cfg(unix)]
        {
            assert!(fixture
                .run(kind, &executable, &control(Duration::from_secs(10)))
                .is_err());
            assert_eq!(help_count(dir.path()), 0, "{kind}: not even --help ran");
            assert!(!dir.path().join("run.json").exists());
        }
    }
}

#[test]
fn cli_model_ids_cannot_inject_options_or_shell_syntax() {
    for model in [
        "gpt-6-luna",
        "claude-sonnet-5[1m]",
        "openai/gpt-oss:20b",
        "sonnet",
        "model@2026-01+beta",
    ] {
        assert!(cli::validate_cli_model(model).is_ok(), "{model}");
    }
    let long = "m".repeat(129);
    for model in [
        "",
        "--dangerously-bypass-approvals-and-sandbox",
        "-m",
        "a b",
        "a\"b",
        "a%PATH%",
        "a&calc",
        "a|b",
        "a^b",
        "a!b",
        "a<b",
        "x\u{0}",
        long.as_str(),
    ] {
        assert_eq!(
            cli::validate_cli_model(model).unwrap_err().code,
            "invalid_request",
            "{model:?}"
        );
    }
    let fixture = Fixture::new();
    let env = fixture.env();
    let dir = tempfile::tempdir().unwrap();
    let error = cli::check(
        &profile("codex", &dir.path().join("codex"), "--oss"),
        &env,
        &|| false,
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_request");
}

/// Windows `.cmd` shims run through cmd.exe, whose command line is limited to
/// 8191 characters and which interprets `" % ! ^ & | < >`. Argv therefore holds
/// only fixed flags and a validated model; prompts never reach it.
#[test]
fn cli_argv_is_short_and_free_of_cmd_metacharacters() {
    for cli in [cli::Cli::Codex, cli::Cli::Claude] {
        let args = cli.isolation_args("claude-sonnet-5[1m]");
        let length: usize = args.iter().map(|a| a.len() + 3).sum();
        assert!(length < 4096, "{cli:?}: {length}");
        for arg in &args {
            assert!(
                !arg.chars().any(|c| "\"%!^&|<>\r\n".contains(c)),
                "{cli:?}: {arg:?}"
            );
        }
    }
}

#[test]
fn help_flags_match_exact_option_names() {
    let help = "  --model-provider <P>\n  -c, --config <key=value>\n  --disallowedTools, --disallowed-tools <tools...>\n  --system-prompt[-file]";
    let flags = cli::help_flags(help);
    assert!(flags.contains("--config") && flags.contains("--disallowedTools"));
    assert!(flags.contains("--system-prompt"));
    assert!(!flags.contains("--model"));
    assert_eq!(
        cli::missing_flags(cli::Cli::Codex, help).first(),
        Some(&"--ignore-user-config")
    );
    assert!(cli::missing_flags(cli::Cli::Codex, help).contains(&"--model"));
    assert!(cli::missing_flags(cli::Cli::Codex, CODEX_HELP).is_empty());
    assert!(cli::missing_flags(cli::Cli::Claude, CLAUDE_HELP).is_empty());
}

#[cfg(unix)]
#[test]
fn cli_failures_are_typed_and_never_return_partial_text() {
    let message =
        r#"{"type":"item.completed","item":{"type":"agent_message","text":"Fixture title"}}"#;
    let completed = r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#;
    let warning = r#"{"type":"item.completed","item":{"type":"error","message":"unknown feature key in config: code_mode_host"}}"#;
    let todo = r#"{"type":"item.completed","item":{"type":"todo_list","items":[{"text":"Draft title","completed":false}]}}"#;
    let tool = r#"{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}"#;
    let claude = |result: Value| result.to_string();
    let cases: Vec<(&str, String, i32, Option<&str>)> = vec![
        // A well-formed answer from a CLI that exits nonzero is not a title.
        (
            "codex",
            format!("{message}\n{completed}\n"),
            3,
            Some("provider_failed"),
        ),
        (
            "claude",
            claude(
                json!({"type":"result","subtype":"success","is_error":false,"result":"Fixture title"}),
            ),
            1,
            Some("provider_failed"),
        ),
        // Truncated streams: no completed turn, a line cut mid-event.
        ("codex", format!("{message}\n"), 0, Some("invalid_response")),
        (
            "codex",
            format!("{message}\n{{\"type\":\"turn.comp"),
            0,
            Some("invalid_response"),
        ),
        (
            "claude",
            r#"{"type":"result","subtype":"succ"#.into(),
            0,
            Some("invalid_response"),
        ),
        // Empty output and empty results.
        ("codex", String::new(), 0, Some("invalid_response")),
        ("claude", String::new(), 0, Some("invalid_response")),
        (
            "codex",
            format!(
                "{}\n{completed}\n",
                json!({"type":"item.completed","item":{"type":"agent_message","text":"  "}})
            ),
            0,
            Some("invalid_response"),
        ),
        (
            "claude",
            claude(json!({"type":"result","subtype":"success","is_error":false,"result":""})),
            0,
            Some("invalid_response"),
        ),
        // A completed turn or success result without its text field.
        (
            "codex",
            format!("{completed}\n"),
            0,
            Some("invalid_response"),
        ),
        (
            "claude",
            claude(json!({"type":"result","subtype":"success","is_error":false})),
            0,
            Some("invalid_response"),
        ),
        // Provider-reported failures.
        (
            "codex",
            format!(
                "{message}\n{}\n",
                json!({"type":"turn.failed","error":{"message":"x"}})
            ),
            0,
            Some("provider_failed"),
        ),
        (
            "claude",
            claude(json!({"type":"result","subtype":"error_max_turns","is_error":true})),
            0,
            Some("provider_failed"),
        ),
        // Any tool activity fails the request even if text follows.
        (
            "codex",
            format!("{tool}\n{message}\n{completed}\n"),
            0,
            Some("invalid_response"),
        ),
        (
            "claude",
            claude(
                json!({"type":"result","subtype":"success","is_error":false,"result":"Fixture title","permission_denials":[{"tool_name":"Bash"}]}),
            ),
            0,
            Some("invalid_response"),
        ),
        // Codex's plan tool emits todo_list items; they are harmless.
        (
            "codex",
            format!("{todo}\n{message}\n{completed}\n"),
            0,
            None,
        ),
        // Codex reports config warnings as error items; they are not failures.
        (
            "codex",
            format!("{warning}\n{message}\n{completed}\n"),
            0,
            None,
        ),
    ];
    for (index, (kind, stdout, code, expected)) in cases.into_iter().enumerate() {
        let fixture = Fixture::new();
        let dir = tempfile::tempdir().unwrap();
        let help = if kind == "codex" {
            CODEX_HELP
        } else {
            CLAUDE_HELP
        };
        let executable = fake_cli(dir.path(), kind, help, &stdout, code);
        let result = fixture.run(kind, &executable, &control(Duration::from_secs(10)));
        match expected {
            Some(code) => assert_eq!(result.unwrap_err().code, code, "case {index}"),
            None => assert_eq!(result.unwrap(), "Fixture title", "case {index}"),
        }
    }
}

/// A fake CLI that starts a child, which starts a grandchild, records all three
/// PIDs and then blocks forever.
#[cfg(unix)]
fn tree_cli(dir: &Path, kind: &str, help: &str) -> (PathBuf, PathBuf) {
    let pids = dir.join("pids");
    let executable = dir.join(kind);
    write_executable(
        &executable,
        &format!(
            r#"#!/usr/bin/env python3
import os,subprocess,sys,time
if sys.argv[1:]==['__exec_probe']: sys.exit(0)
if '--help' in sys.argv:
    print({help:?}); sys.exit(0)
child=subprocess.Popen([sys.executable,'-c','import os,subprocess,sys,time\ng=subprocess.Popen([sys.executable,"-c","import time\\nwhile True: time.sleep(1)"])\nopen(sys.argv[1]+".tmp","w").write(str(g.pid))\nos.rename(sys.argv[1]+".tmp",sys.argv[1])\nwhile True: time.sleep(1)',{grand:?}])
while not os.path.exists({grand:?}): time.sleep(.01)
grandchild=open({grand:?}).read()
open({pids:?}+'.tmp','w').write(' '.join([str(os.getpid()),str(child.pid),grandchild]))
os.rename({pids:?}+'.tmp',{pids:?})
while True: time.sleep(1)
"#,
            grand = dir.join("grandchild").to_string_lossy(),
            pids = pids.to_string_lossy(),
        ),
    );
    (executable, pids)
}
#[cfg(unix)]
fn running(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        // Exited, or a zombie awaiting its reaper: never still running.
        fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                !stat
                    .rsplit_once(')')
                    .unwrap()
                    .1
                    .trim_start()
                    .starts_with('Z')
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        unsafe { libc::kill(pid, 0) == 0 }
    }
}
#[cfg(unix)]
fn assert_tree_reaped(pids: &Path) {
    let owned: Vec<i32> = fs::read_to_string(pids)
        .expect("the CLI tree started before it was stopped")
        .split_whitespace()
        .map(|pid| pid.parse().unwrap())
        .collect();
    assert_eq!(owned.len(), 3);
    let deadline = Instant::now() + Duration::from_secs(3);
    while owned.iter().any(|pid| running(*pid)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    let survivors: Vec<_> = owned.iter().filter(|pid| running(**pid)).collect();
    for pid in &survivors {
        unsafe { libc::kill(**pid, libc::SIGKILL) };
    }
    assert!(
        survivors.is_empty(),
        "orphaned CLI processes: {survivors:?}"
    );
}

#[cfg(unix)]
#[test]
fn cli_deadline_reaps_the_owned_process_tree() {
    for (kind, help) in kinds() {
        let fixture = Fixture::new();
        let dir = tempfile::tempdir().unwrap();
        let (executable, pids) = tree_cli(dir.path(), kind, help);
        let started = Instant::now();
        let error = fixture
            .run(kind, &executable, &control(Duration::from_secs(3)))
            .unwrap_err();
        assert_eq!(error.code, "timed_out", "{kind}");
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_tree_reaped(&pids);
    }
}

#[cfg(unix)]
#[test]
fn cli_cancellation_reaps_the_owned_process_tree() {
    for (kind, help) in kinds() {
        let fixture = Fixture::new();
        let dir = tempfile::tempdir().unwrap();
        let (executable, pids) = tree_cli(dir.path(), kind, help);
        let control = control(Duration::from_secs(30));
        let canceller = {
            let control = control.clone();
            let pids = pids.clone();
            std::thread::spawn(move || {
                // Gate on the tree having started, not on elapsed time.
                let give_up = Instant::now() + Duration::from_secs(20);
                while !pids.exists() && Instant::now() < give_up {
                    std::thread::sleep(Duration::from_millis(10));
                }
                control.cancel();
            })
        };
        let error = fixture.run(kind, &executable, &control).unwrap_err();
        canceller.join().unwrap();
        assert_eq!(error.code, "cancelled", "{kind}");
        assert_tree_reaped(&pids);
    }
}

/// A failed listing (for example an npm shim whose Node runtime is missing)
/// is not cached: once the runtime is fixed the same executable works.
#[cfg(unix)]
#[test]
fn cli_failed_help_listing_is_retried() {
    let fixture = Fixture::new();
    let dir = tempfile::tempdir().unwrap();
    let broken = dir.path().join("runtime-missing");
    fs::write(&broken, "").unwrap();
    let executable = dir.path().join("codex");
    write_executable(
        &executable,
        &format!(
            r#"#!/usr/bin/env python3
import os,sys
if sys.argv[1:]==['__exec_probe']: sys.exit(0)
if '--help' in sys.argv:
    if os.path.exists({broken:?}): sys.exit(127)
    print({CODEX_HELP:?}); sys.exit(0)
sys.stdin.read()
sys.stdout.write({output:?})
"#,
            broken = broken.to_string_lossy(),
            output = success_output("codex"),
        ),
    );
    let error = fixture
        .run("codex", &executable, &control(Duration::from_secs(10)))
        .unwrap_err();
    assert_eq!(error.code, "unavailable");
    fs::remove_file(&broken).unwrap();
    assert_eq!(
        fixture
            .run("codex", &executable, &control(Duration::from_secs(10)))
            .unwrap(),
        "Fixture title"
    );
}

/// Cancelling while the one-off `--help` probe runs reports `cancelled`, not
/// an unusable CLI, and leaves no cached outcome behind.
#[cfg(unix)]
#[test]
fn cli_cancellation_during_the_help_probe_reports_cancelled() {
    let fixture = Fixture::new();
    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("help-started");
    let executable = dir.path().join("claude");
    write_executable(
        &executable,
        &format!(
            r#"#!/usr/bin/env python3
import sys,time
if sys.argv[1:]==['__exec_probe']: sys.exit(0)
open({started:?},'a').write('x')
time.sleep(30)
"#,
            started = started.to_string_lossy()
        ),
    );
    let control = control(Duration::from_secs(30));
    let canceller = {
        let control = control.clone();
        let started = started.clone();
        std::thread::spawn(move || {
            let give_up = Instant::now() + Duration::from_secs(20);
            while !started.exists() && Instant::now() < give_up {
                std::thread::sleep(Duration::from_millis(10));
            }
            control.cancel();
        })
    };
    let begun = Instant::now();
    let error = fixture.run("claude", &executable, &control).unwrap_err();
    canceller.join().unwrap();
    assert_eq!(error.code, "cancelled", "{}", error.message);
    assert!(begun.elapsed() < Duration::from_secs(10));
    // Not cached: the next request probes again.
    let again = probe_count_after_retry(&fixture, &executable, &started);
    assert_eq!(again, 2, "an interrupted probe is not cached");
}
#[cfg(unix)]
fn probe_count_after_retry(fixture: &Fixture, executable: &Path, started: &Path) -> usize {
    let control = control(Duration::from_secs(30));
    let canceller = {
        let control = control.clone();
        let started = started.to_path_buf();
        std::thread::spawn(move || {
            let give_up = Instant::now() + Duration::from_secs(20);
            while fs::read_to_string(&started).map_or(0, |s| s.len()) < 2
                && Instant::now() < give_up
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            control.cancel();
        })
    };
    let _ = fixture.run("claude", executable, &control);
    canceller.join().unwrap();
    fs::read_to_string(started).map_or(0, |s| s.len())
}

/// Windows counterpart: a `.cmd` shim (as npm installs) that starts a
/// PowerShell child. Cancellation must end both through the owned job object.
#[cfg(windows)]
#[test]
fn cli_cancellation_reaps_a_cmd_shim_process_tree() {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    let fixture = Fixture::new();
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    let pending = dir.path().join("pids.tmp");
    let executable = dir.path().join("codex.cmd");
    fs::write(
        &executable,
        format!(
            "@echo off\r\nif \"%~2\"==\"--help\" (\r\necho {help}\r\nexit /b 0\r\n)\r\npowershell.exe -NoProfile -NonInteractive -Command \"$c=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden; Set-Content -LiteralPath '{pending}' -Value $c.Id; Move-Item -LiteralPath '{pending}' -Destination '{pids}'; Start-Sleep -Seconds 60\"\r\n",
            // cmd.exe would treat CODEX_HELP's <placeholders> as redirection.
            help = "--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --model --config",
            pending = pending.display(),
            pids = pids.display(),
        ),
    )
    .unwrap();
    // Two nested PowerShell cold starts can take tens of seconds on a loaded
    // runner. Readiness may use most of the deadline; cancellation must still
    // land before it.
    let control = control(Duration::from_secs(150));
    let canceller = {
        let control = control.clone();
        let pids = pids.clone();
        std::thread::spawn(move || {
            let give_up = Instant::now() + Duration::from_secs(120);
            while !pids.exists() && Instant::now() < give_up {
                std::thread::sleep(Duration::from_millis(20));
            }
            control.cancel();
        })
    };
    let error = fixture.run("codex", &executable, &control).unwrap_err();
    canceller.join().unwrap();
    assert_eq!(error.code, "cancelled");
    let pid: u32 = fs::read_to_string(&pids)
        .expect("the CLI tree started before it was cancelled")
        .trim()
        .parse()
        .unwrap();
    let exited = || unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return true;
        }
        let mut code = 259;
        let read = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        read != 0 && code != 259
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while !exited() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        exited(),
        "the shim's PowerShell child survived cancellation"
    );
}
