# Security Policy

## Supported versions

Only the [latest release](https://github.com/xnmp/tauri-explorer/releases/latest) receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities. Instead, report privately via [GitHub Security Advisories](https://github.com/xnmp/tauri-explorer/security/advisories/new).

You can expect an acknowledgement within a week. If the report is confirmed, a fix will be prioritized and credited to you in the release notes unless you prefer otherwise.

## Scope notes

Tauri Explorer is a local desktop application. It makes no network calls except: a once-a-day GitHub API check for new releases, and optional AI plugin features that only activate when you configure an API key. There is no telemetry. Reports about data leaving the machine outside those paths are treated as high severity.
