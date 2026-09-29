# Security Policy

## Supported versions

Only the [latest release](https://github.com/xnmp/tauri-explorer/releases/latest) receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, report privately via [GitHub Security Advisories](https://github.com/xnmp/tauri-explorer/security/advisories/new).

You can expect an acknowledgement within a week. If the report is confirmed, a fix will be prioritized and credited to you in the release notes unless you prefer otherwise.

## Scope notes

Tauri Explorer has no telemetry. It checks GitHub for new releases at most once a day. Network requests also occur when you choose a Git remote operation, enable and invoke an AI plugin, or submit an issue from inside the app. An in-app issue sends the text, optional contact details, app/OS information, and selected images to the report service, which creates a public GitHub issue; images are stored at public URLs. The report service uses a hashed source-IP value for short-lived rate-limit counters; it does not include that value in the public issue. The report dialog shows the public content before submission. Crash reports and logs stay local unless you choose to share them. Unexpected data transfer outside these user-initiated paths is treated as high severity.
