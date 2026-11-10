/**
 * Which path a user report takes (#1455). With a GitHub personal access token
 * saved in Settings, a report is created directly through the GitHub API as
 * that user. Attachments need the relay's public hosting, which a direct issue
 * has no equivalent for, so a report with attachments always uses the
 * anonymous relay. Without a token (or when the OS credential store can't be
 * read) nothing changes.
 */

/** Native `user_report_token_state`: the token itself is never read back. */
export type ReportTokenState = "configured" | "absent" | "unavailable";

export type UserReportRoute = "github-token" | "relay";

export const MAX_GITHUB_TOKEN_CHARS = 255;

export function userReportRoute(
  tokenState: ReportTokenState,
  attachmentCount: number,
): UserReportRoute {
  return tokenState === "configured" && attachmentCount === 0 ? "github-token" : "relay";
}

/** One sentence for the report dialog saying who the issue will be filed as. */
export function userReportRouteNotice(
  tokenState: ReportTokenState,
  attachmentCount: number,
): string {
  if (userReportRoute(tokenState, attachmentCount) === "github-token") {
    return "It will be created by your GitHub account, using the token saved in Settings.";
  }
  if (tokenState === "configured") {
    return "Reports with images or videos are sent anonymously through the Tauri Explorer report service, not your GitHub token.";
  }
  return "It is sent anonymously through the Tauri Explorer report service.";
}

/** Trimmed token, or a user-facing reason it can't be saved. Mirrors the native check. */
export function normalizeGitHubToken(raw: string): { token: string } | { error: string } {
  const token = raw.trim();
  if (!token) return { error: "Paste a GitHub personal access token." };
  if (token.length > MAX_GITHUB_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) {
    return { error: "That doesn't look like a GitHub token: it must have no spaces and at most 255 characters." };
  }
  return { token };
}
