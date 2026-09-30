# Security Policy

## Supported versions

Only the [latest release](https://github.com/xnmp/tauri-explorer/releases/latest) receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, report privately via [GitHub Security Advisories](https://github.com/xnmp/tauri-explorer/security/advisories/new).

You can expect an acknowledgement within a week. If the report is confirmed, a fix will be prioritized and credited to you in the release notes unless you prefer otherwise.

## Scope notes

Tauri Explorer has no telemetry. It checks GitHub for new releases at most once a day. Network requests also occur when you choose a Git remote operation, enable and invoke an AI plugin, or submit an issue from inside the app. An in-app issue sends the text, optional contact details, app/OS information, and selected images to the report service, which creates a public GitHub issue; images are stored at public URLs. The report service uses a hashed source-IP value for short-lived rate-limit counters; it does not include that value in the public issue. The report dialog shows the public content before submission. Crash reports and logs stay local unless you choose to share them. Unexpected data transfer outside these user-initiated paths is treated as high severity.

### Report service override

Release builds honour `TAURI_EXPLORER_REPORT_URL`, which replaces the in-app report service so release smoke tests can exercise rejected and ambiguous submissions against a controlled local relay. It accepts only an `https://` URL or an `http://` URL whose host is `localhost` or a literal loopback address (`127.0.0.0/8`, `::1`). Any other value, including a cleartext remote URL, `file:`, or a malformed URL, fails the submission before anything is sent. An empty value means unset. Reports are still sent only when you submit one.

End-to-end test hooks are not part of release builds: the frontend hooks require the `VITE_E2E_HOOKS=1` build flag and the native ones the `e2e-hooks` Cargo feature, and the release bundle check fails if hook code is present.
