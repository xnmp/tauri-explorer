#[cfg(test)]
mod tests {
    use super::{assemble_issue_body, Environment};

    #[test]
    fn user_report_body_contains_description_contact_environment_and_log_tail() {
        let body = assemble_issue_body(
            "It freezes on café/🐛 paths.",
            Some("@reporter"),
            &Environment { version: "1.7.0", os: "linux", arch: "x86_64" },
            Some("line one\nline two"),
        );
        assert!(body.contains("It freezes on café/🐛 paths."));
        assert!(body.contains("How to reach the reporter: @reporter"));
        assert!(body.contains("Tauri Explorer: v1.7.0"));
        assert!(body.contains("OS: linux (x86_64)"));
        assert!(body.contains("line one\nline two"));
    }

    #[test]
    fn user_report_body_omits_absent_optional_sections() {
        let body = assemble_issue_body(
            "Description only",
            None,
            &Environment { version: "1.7.0", os: "macos", arch: "aarch64" },
            None,
        );
        assert!(!body.contains("How to reach"));
        assert!(!body.contains("Recent logs"));
        assert!(body.contains("Description only"));
    }
}
