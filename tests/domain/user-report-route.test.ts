import { describe, expect, it } from "vitest";
import {
  normalizeGitHubToken,
  userReportRoute,
  userReportRouteNotice,
} from "$lib/domain/user-report-route";
import { userReportFallbackNotice } from "$lib/domain/user-report";
import { SETTINGS_ROWS } from "$lib/domain/settings-rows";
import { matchesSettingsQuery } from "$lib/domain/settings-search";

describe("userReportRoute (#1455)", () => {
  it("files text-only reports as the user only when a token is saved", () => {
    expect(userReportRoute("configured", 0)).toBe("github-token");
    expect(userReportRoute("absent", 0)).toBe("relay");
    expect(userReportRoute("unavailable", 0)).toBe("relay");
  });

  it("keeps attachments on the relay, which alone can host them", () => {
    expect(userReportRoute("configured", 1)).toBe("relay");
    expect(userReportRoute("configured", 3)).toBe("relay");
  });

  it("tells the reporter who will file the issue", () => {
    expect(userReportRouteNotice("configured", 0)).toMatch(/your GitHub account/);
    expect(userReportRouteNotice("configured", 2)).toMatch(/images or videos are sent anonymously/);
    expect(userReportRouteNotice("absent", 0)).toMatch(/anonymously/);
    expect(userReportRouteNotice("unavailable", 2)).toMatch(/anonymously/);
  });
});

describe("normalizeGitHubToken", () => {
  it("trims pasted whitespace", () => {
    expect(normalizeGitHubToken("  ghp_abc123\n")).toEqual({ token: "ghp_abc123" });
    expect(normalizeGitHubToken("github_pat_11AB_cd")).toEqual({ token: "github_pat_11AB_cd" });
  });

  it.each(["", "   ", "ghp_has space", "ghp_tab\tinside", "ghp_é", "a".repeat(256)])(
    "rejects %j without echoing it",
    (raw) => {
      const result = normalizeGitHubToken(raw);
      expect(result).toHaveProperty("error");
      if ("error" in result && raw.trim()) expect(result.error).not.toContain(raw.trim());
    },
  );
});

describe("token failure notices", () => {
  it("names the token problem instead of a generic failure", () => {
    expect(userReportFallbackNotice("authentication_failed")).toMatch(/saved token.*Settings → Issue Reports/);
    expect(userReportFallbackNotice("credential_unavailable")).toMatch(/credential storage is locked/);
  });
});

describe("settings search", () => {
  it("finds the token row by report and token terms", () => {
    for (const query of ["github", "token", "report issue"]) {
      expect(matchesSettingsQuery(query, ...SETTINGS_ROWS.githubReportToken), query).toBe(true);
    }
  });
});
