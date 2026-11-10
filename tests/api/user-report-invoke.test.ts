import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({ invoke: invokeMock }));

import { submitUserReport } from "$lib/api/user-report";

describe("submitUserReport", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sends the token flag under the camelCase name Tauri derives from use_github_token", async () => {
    invokeMock.mockResolvedValue({});
    await submitUserReport({ title: "t", body: "b", kind: "bug", contact: "", attachments: [] } as never, true);
    const payload = invokeMock.mock.calls[0][1];
    expect(payload.useGithubToken).toBe(true);
    expect("useGitHubToken" in payload).toBe(false);
  });
});
