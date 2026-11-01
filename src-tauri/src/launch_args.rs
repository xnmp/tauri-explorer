//! Command-line launch arguments shared by the first process (`main.rs`) and
//! the Linux single-instance handoff (`window_launch.rs`), so both read
//! `tauri-explorer [--new-tab] [PATH]` identically (#1478).

/// Opens the launch path as a tab in the running instance's most recently
/// focused Explorer window instead of a new window. Without a running
/// instance the launch opens a window, exactly as without the flag.
pub const NEW_TAB_FLAG: &str = "--new-tab";

/// One parsed command line (program name excluded).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchArgs {
    /// The first positional argument: the directory to open.
    pub path: Option<String>,
    /// `--new-tab` appeared anywhere before a `--` terminator.
    pub new_tab: bool,
}

/// Parse arguments after the program name. Flags may precede or follow the
/// path; unrecognised `--flags` (such as `--file-chooser-portal`) are ignored
/// rather than mistaken for paths, and `--` makes every later argument
/// positional so a directory literally named `--new-tab` stays reachable.
/// Only the first positional argument is used: the CLI opens one location.
pub fn parse<I, S>(args: I) -> LaunchArgs
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut parsed = LaunchArgs::default();
    let mut options_ended = false;
    for arg in args {
        let arg = arg.as_ref();
        if !options_ended {
            if arg == "--" {
                options_ended = true;
                continue;
            }
            if arg == NEW_TAB_FLAG {
                parsed.new_tab = true;
                continue;
            }
            if arg.starts_with("--") {
                continue;
            }
        }
        if parsed.path.is_none() && !arg.is_empty() {
            parsed.path = Some(arg.to_owned());
        }
    }
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> LaunchArgs {
        parse(list.iter().copied())
    }

    #[test]
    fn plain_path_and_no_arguments_keep_window_launches() {
        assert_eq!(
            args(&["/work"]),
            LaunchArgs {
                path: Some("/work".into()),
                new_tab: false
            }
        );
        assert_eq!(args(&[]), LaunchArgs::default());
    }

    #[test]
    fn new_tab_flag_is_recognised_before_or_after_the_path() {
        let expected = LaunchArgs {
            path: Some("/work".into()),
            new_tab: true,
        };
        assert_eq!(args(&["--new-tab", "/work"]), expected);
        assert_eq!(args(&["/work", "--new-tab"]), expected);
        assert_eq!(
            args(&["--new-tab"]),
            LaunchArgs {
                path: None,
                new_tab: true
            }
        );
    }

    #[test]
    fn unknown_flags_are_not_paths_and_only_the_first_path_is_used() {
        assert_eq!(
            args(&["--file-chooser-portal"]),
            LaunchArgs::default(),
            "portal activation must not be read as a launch path"
        );
        assert_eq!(
            args(&["--other", "rel/dir", "/second"]).path.as_deref(),
            Some("rel/dir")
        );
        assert_eq!(
            args(&["", "/after-empty"]).path.as_deref(),
            Some("/after-empty")
        );
    }

    #[test]
    fn double_dash_ends_option_parsing() {
        assert_eq!(
            args(&["--new-tab", "--", "--new-tab"]),
            LaunchArgs {
                path: Some("--new-tab".into()),
                new_tab: true
            }
        );
        assert_eq!(
            args(&["--", "/work", "--new-tab"]),
            LaunchArgs {
                path: Some("/work".into()),
                new_tab: false
            }
        );
    }
}
