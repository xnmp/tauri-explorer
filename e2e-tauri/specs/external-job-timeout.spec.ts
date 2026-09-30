/** Real Nano worker timeout: reap the CLI, withhold output, report in Jobs. */
import fs from "node:fs";
import path from "node:path";
import { expect } from "expect-webdriverio";
import { createNativeFixtureDirectory } from "../native-qualification";

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  await browser.waitUntil(async () => predicate(), { timeout: 15_000, timeoutMsg: message });
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

describe("external plugin job timeout", () => {
  it("reaps the real CLI and never publishes its late output", async function () {
    if (process.platform !== "linux") this.skip();
    const pidFile = process.env.TAURI_E2E_EXTERNAL_JOB_PID;
    if (!pidFile) throw new Error("external-job fixture was not installed");
    const fixture = createNativeFixtureDirectory("external-job-outcome-");
    const sourcePath = path.join(fixture, "source.png");
    const outputFilename = "should-not-exist.png";
    const outputPath = path.join(fixture, outputFilename);
    fs.writeFileSync(sourcePath, "fixture image bytes");
    const token = crypto.randomUUID();

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.documentElement.dataset.e2eHooksReady === "true",
        ),
      {
        timeout: 15_000,
        timeoutMsg: "native E2E hooks did not become ready",
      },
    );
    await browser.execute(
      (request) => {
        delete document.documentElement.dataset.e2eExternalJobResult;
        window.dispatchEvent(
          new CustomEvent("e2e-external-job", { detail: request }),
        );
      },
      { token, sourcePath, outputDir: fixture, outputFilename },
    );
    await browser.waitUntil(
      async () => {
        const encoded = await browser.execute(
          () => document.documentElement.dataset.e2eExternalJobResult ?? "",
        );
        if (!encoded) return false;
        const reply = JSON.parse(encoded) as { token: string; error?: string };
        if (reply.token !== token) return false;
        // The probe reports a rejected acceptance instead of timing out.
        if (reply.error !== undefined) throw new Error(`plugin job was not accepted: ${reply.error}`);
        return true;
      },
      {
        timeout: 15_000,
        timeoutMsg: "native plugin job did not start through its UI owner",
      },
    );

    await waitUntil(() => fs.existsSync(pidFile), "fake gemini never started");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitUntil(
      () => !processExists(pid),
      `fake gemini ${pid} was not reaped`,
    );
    expect(fs.existsSync(outputPath)).toBe(false);

    await browser.keys(["Control", "j"]);
    const panel = await $("[aria-labelledby='jobs-panel-title']");
    await expect(panel).toBeDisplayed();
    const failed = await panel.$(".job-item.error");
    await expect(failed).toBeDisplayed();
    await expect(failed).toHaveText(expect.stringContaining("timed out"));
    expect(fs.existsSync(outputPath)).toBe(false);
    const evidence = path.resolve(
      "screenshots/test/external-jobs-acceptance/external-job-timeout.png",
    );
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    await browser.saveScreenshot(evidence);
  });
});
