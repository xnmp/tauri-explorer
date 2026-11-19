use super::*;

fn unix() -> Redactor {
    Redactor::new(&["/home/alex".to_owned()], false)
}

#[test]
fn redacts_the_home_in_every_form_a_log_line_can_carry_it() {
    let unix = unix();
    let windows = Redactor::new(&[r"C:\Users\alex".to_owned()], true);
    let cases: Vec<(&Redactor, &str, &str)> = vec![
        // as displayed
        (
            &unix,
            "cannot read /home/alex/Documents/a.txt",
            "cannot read ~/Documents/a.txt",
        ),
        // end of line, quote and sentence punctuation
        (&unix, "in /home/alex", "in ~"),
        (&unix, "path \"/home/alex\" failed", "path \"~\" failed"),
        (&unix, "cannot open /home/alex.", "cannot open ~."),
        // Debug-escaped Windows path ({:?} doubles the backslashes)
        (
            &windows,
            r#"failed: "C:\\Users\\alex\\Docs\\a.txt""#,
            r#"failed: "~\\Docs\\a.txt""#,
        ),
        // plain Windows, forward-slash Windows, and case differences
        (&windows, r"C:\Users\alex\Docs", r"~\Docs"),
        (&windows, "C:/Users/alex/Docs", "~/Docs"),
        (&windows, r"c:\users\ALEX\Docs", r"~\Docs"),
        // percent-encoded in asset-protocol URLs, both slash styles
        (
            &unix,
            "asset://localhost/%2Fhome%2Falex%2Fpics%2Fa.png",
            "asset://localhost/~%2Fpics%2Fa.png",
        ),
        (
            &unix,
            "asset://localhost/%2fhome%2falex%2fa.png",
            "asset://localhost/~%2fa.png",
        ),
        (&unix, "file:///home/alex/a%20b.png", "file://~/a%20b.png"),
        // removable media embed the user name
        (
            &unix,
            "mount /run/media/alex/USB/x failed",
            "mount /run/media/~/USB/x failed",
        ),
        (&unix, "mount /media/bob/disk", "mount /media/~/disk"),
        // nothing to redact
        (&unix, "no path here", "no path here"),
    ];
    for (redactor, input, expected) in cases {
        assert_eq!(redactor.redact(input), expected, "input: {input}");
    }
}

#[test]
fn a_longer_user_name_sharing_the_prefix_is_not_truncated() {
    let redacted = unix().redact("/home/alexander/x and /home/alex_b/y and /home/alex-2/z");
    assert_eq!(
        redacted,
        "/home/alexander/x and /home/alex_b/y and /home/alex-2/z"
    );
}

#[test]
fn a_symlinked_home_is_redacted_through_its_canonical_form() {
    let redactor = Redactor::new(
        &["/home/alex".to_owned(), "/var/home/alex".to_owned()],
        false,
    );
    assert_eq!(redactor.redact("/var/home/alex/a /home/alex/b"), "~/a ~/b");
}

#[test]
fn case_matters_on_case_sensitive_platforms() {
    assert_eq!(unix().redact("/HOME/ALEX/a"), "/HOME/ALEX/a");
}

#[test]
fn degenerate_homes_never_redact_everything() {
    let redactor = Redactor::new(&["/".to_owned(), String::new(), "a".to_owned()], false);
    assert_eq!(redactor.redact("/usr/a/b"), "/usr/a/b");
}

#[test]
fn non_ascii_homes_and_text_are_handled_on_char_boundaries() {
    let redactor = Redactor::new(&["/home/josé".to_owned()], true);
    assert_eq!(redactor.redact("é /home/JOSé/ä /home/josé"), "é ~/ä ~");
}

#[test]
fn redaction_is_idempotent() {
    let once = unix().redact("/run/media/alex/USB /home/alex/a");
    assert_eq!(unix().redact(&once), once);
}
