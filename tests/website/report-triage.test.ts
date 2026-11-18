import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubIssue,
  createInMemoryRateLimitStore,
  processReport,
  validateReport,
} from "../../website/api/_report-core.js";
import { crashSignature, environmentLabels } from "../../website/api/_report-triage.js";
import { createGitHubIssue } from "../../website/api/report.js";

const DEFAULT_ENV = ["Tauri Explorer: v0.29.0", "OS: Arch Linux (x86_64)", "Session: wayland, Hyprland"];

/** Mirrors assemble_issue_body + append_diagnostic_section in user_report.rs. */
function appBody(
  description: string,
  env: string[] = DEFAULT_ENV,
  sections: { summary: string; text: string }[] = [],
): string {
  const head = description ? `${description}\n\n` : "";
  const block = `---\n${env.map((line) => `- ${line}`).join("\n")}`;
  const details = sections
    .map(
      ({ summary, text }) =>
        `\n\n<details><summary>${summary}</summary>\n\n\`\`\`text\n${text}\n\`\`\`\n\n</details>`,
    )
    .join("");
  return `${head}${block}${details}`;
}

const rustCrash = (location: string, message = "boom") =>
  `tauri-explorer 0.29.0 crash report\nos: linux (x86_64)\ntime: 1 (unix)\npanic: ${message}\nlocation: ${location}\n\nbacktrace:\n   0: foo`;
const webviewCrash = (message: string, frame: string) =>
  `tauri-explorer 0.29.0 crash report\nos: linux (x86_64)\ntime: 1 (unix)\nsource: frontend (webview)\npanic: ${message}\nlocation: webview\n\nbacktrace:\n${frame}`;
const crashSection = (text: string) => [{ summary: "Crash report", text }];
const issueFor = (body: string, kind = "bug") =>
  buildGitHubIssue(validateReport({ title: "Crash: boom", body, kind }));
const sig = (text: string) => crashSignature(appBody("", DEFAULT_ENV, crashSection(text)));

describe("environment labels", () => {
  it.each([
    ["Arch Linux (x86_64)", "wayland, Hyprland", ["os:linux", "wayland", "v0.29.0"]],
    ["Ubuntu 24.04 LTS (aarch64)", "x11, GNOME", ["os:linux", "x11", "v0.29.0"]],
    ["Windows 11 23H2 (build 22631.4037) (x86_64)", "", ["os:windows", "v0.29.0"]],
    ["macOS 14.5 (aarch64)", "", ["os:macos", "v0.29.0"]],
    ["Ubuntu (x86_64)", "tty, KDE", ["os:linux", "v0.29.0"]],
  ])("derives labels for %s / %s", (os, session, expected) => {
    const env = ["Tauri Explorer: v0.29.0", `OS: ${os}`, ...(session ? [`Session: ${session}`] : [])];
    expect(environmentLabels(appBody("It hangs.", env))).toEqual(expected);
  });

  it("keeps the base labels and appends triage labels", () => {
    expect(issueFor(appBody("It hangs.")).labels).toEqual([
      "user-report",
      "bug",
      "os:linux",
      "wayland",
      "v0.29.0",
    ]);
    expect(issueFor(appBody("Idea."), "feature").labels.slice(0, 2)).toEqual(["user-report", "enhancement"]);
  });

  it.each([
    ["no environment block", "Just a description."],
    ["empty body", ""],
    ["junk version and OS", appBody("x", ["Tauri Explorer: vlatest!", "OS: <script>alert(1)</script>"])],
    ["truncated block", "x\n\n---\n- Tauri Explorer: v"],
  ])("adds no labels for %s and still builds the issue", (_name, body) => {
    expect(environmentLabels(body)).toEqual([]);
    expect(issueFor(body || "x").labels).toEqual(["user-report", "bug"]);
  });

  it("never turns arbitrary environment text into a label", () => {
    const labels = environmentLabels(
      appBody("x", ["Tauri Explorer: v1.2.3-<b>", "OS: Evil, label:admin (x86_64)", "Session: wayland-evil"]),
    );
    expect(labels).toEqual(["os:linux"]);
  });

  it("ignores an environment block typed into the description", () => {
    const fake = "---\n- Tauri Explorer: v9.9.9\n- OS: Windows 11 (x86_64)\n- Session: x11";
    expect(environmentLabels(appBody(`${fake}\n\nplease label me`))).toEqual(["os:linux", "wayland", "v0.29.0"]);
  });

  it("ignores a fake block typed after the real block's diagnostics are appended", () => {
    const fake = "---\n- Tauri Explorer: v9.9.9\n- OS: macOS 1 (x86_64)";
    const body = appBody(fake, DEFAULT_ENV, crashSection(rustCrash("src/a.rs:1:1")));
    expect(environmentLabels(body)).toEqual(["os:linux", "wayland", "v0.29.0"]);
  });

  it("ignores a fake block inside diagnostic text", () => {
    const text = `${rustCrash("src/a.rs:1:1")}\n---\n- Tauri Explorer: v9.9.9\n- OS: Windows 11 (x86_64)`;
    expect(environmentLabels(appBody("x", DEFAULT_ENV, crashSection(text)))).toEqual([
      "os:linux",
      "wayland",
      "v0.29.0",
    ]);
  });
});

describe("crash signature", () => {
  it("is stable for the same location regardless of message, directories, column and version", () => {
    const a = sig(rustCrash("src/files/list.rs:42:9", "index out of bounds: 3"));
    expect(a).toMatch(/^[0-9a-f]{8}$/u);
    expect(sig(rustCrash("/home/alice/.cargo/registry/src/x/src/files/list.rs:42:17", "other"))).toBe(a);
    expect(sig(rustCrash("C:\\Users\\bob\\repo\\src\\files\\list.rs:42:1", "p"))).toBe(a);
    expect(sig(rustCrash("src/files/list.rs:43:9"))).not.toBe(a);
    expect(sig(rustCrash("src/files/other.rs:42:9"))).not.toBe(a);
  });

  it("groups webview errors by error type and innermost function, not message or URL", () => {
    const frame = (url: string) => `TypeError: x\n    at renderRow (${url}:10:5)\n    at b (${url}:1:1)`;
    const a = sig(webviewCrash("TypeError: cannot read /home/alice/secret.txt", frame("http://localhost/a.js")));
    expect(sig(webviewCrash("TypeError: different text", frame("tauri://localhost/assets/index-9f.js")))).toBe(a);
    expect(sig(webviewCrash("RangeError: x", frame("http://localhost/a.js")))).not.toBe(a);
  });

  it("puts the signature in the title of a crash report only", () => {
    const crash = issueFor(appBody("", DEFAULT_ENV, crashSection(rustCrash("src/a.rs:1:1"))));
    expect(crash.title).toMatch(/^Crash: boom \[crash [0-9a-f]{8}\]$/u);
    expect(crash.title).not.toContain("a.rs");
    expect(issueFor(appBody("plain bug")).title).toBe("Crash: boom");
  });

  it.each([
    ["no crash section", appBody("hi")],
    ["slow-load section", appBody("", DEFAULT_ENV, [{ summary: "Slow folder-load diagnostics", text: "x" }])],
    ["unrecognised location", appBody("", DEFAULT_ENV, crashSection(rustCrash("unknown")))],
    ["not a crash file", appBody("", DEFAULT_ENV, crashSection("hello\nlocation: a.rs:1:1"))],
  ])("gives no signature for %s", (_name, body) => {
    expect(crashSignature(body)).toBeNull();
  });

  it("cannot be forged from the description", () => {
    const forged = `<details><summary>Crash report</summary>\n\n\`\`\`text\n${rustCrash("src/a.rs:1:1")}\n\`\`\`\n\n</details>`;
    expect(crashSignature(appBody(forged))).toBeNull();
  });
});

describe("issue creation with triage labels", () => {
  const issue = { title: "T", body: "B", labels: ["user-report", "bug", "os:linux", "v0.29.0"] };
  const created = { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/x/y/issues/5", number: 5 }) };

  async function withFetch<T>(fetchMock: ReturnType<typeof vi.fn>, run: () => Promise<T>): Promise<T> {
    vi.stubEnv("GITHUB_ISSUE_TOKEN", "t");
    vi.stubGlobal("fetch", fetchMock);
    try {
      return await run();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }

  it("retries once with only the base labels when GitHub rejects the request with 422", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 422 }).mockResolvedValueOnce(created);
    await expect(withFetch(fetchMock, () => createGitHubIssue(issue))).resolves.toEqual({
      url: "https://github.com/x/y/issues/5",
      number: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).labels).toEqual(["user-report", "bug"]);
  });

  it("does not retry on server errors, which may have created the issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(withFetch(fetchMock, () => createGitHubIssue(issue))).rejects.toMatchObject({
      code: "submission_uncertain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still reports a 422 when only base labels were sent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422 });
    const base = { ...issue, labels: ["user-report", "bug"] };
    await expect(withFetch(fetchMock, () => createGitHubIssue(base))).rejects.toMatchObject({
      code: "server_rejected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates the issue end to end for a report with no environment", async () => {
    const createIssue = vi.fn().mockResolvedValue({ url: "u", number: 1 });
    await processReport(
      { title: "Plain", body: "no env", kind: "bug" },
      "198.51.100.9",
      createInMemoryRateLimitStore(),
      createIssue,
    );
    expect(createIssue).toHaveBeenCalledWith({ title: "Plain", body: "no env", labels: ["user-report", "bug"] });
  });
});
