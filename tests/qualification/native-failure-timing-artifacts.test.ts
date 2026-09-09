import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const workflowPath = new URL(
  "../../.github/workflows/e2e-tauri.yml",
  import.meta.url,
);

type WorkflowStep = {
  name?: string;
  run?: string;
};

type CaptureCase = {
  name: string;
  logName: string;
  timingName: string;
  command: string;
};

const captureCases: CaptureCase[] = [
  {
    name: "Run native contracts",
    logName: "native-contracts.log",
    timingName: "native-contracts-timing.txt",
    command: "bun run check:e2e:tauri",
  },
  {
    name: "Build Tauri binary (debug, embedded frontend, no bundle)",
    logName: "tauri-build.log",
    timingName: "tauri-build-timing.txt",
    command: "bun run tauri build --debug --no-bundle",
  },
];

async function captureStep(name: string): Promise<string> {
  const workflow = parse(await readFile(workflowPath, "utf8")) as {
    jobs: { smoke: { steps: WorkflowStep[] } };
  };
  const step = workflow.jobs.smoke.steps.find(
    (candidate) => candidate.name === name,
  );

  expect(step?.run, `workflow capture step ${name}`).toBeDefined();
  return step!.run!;
}

function replaceProductionCommand(
  step: string,
  stepName: string,
  exitStatus: number,
): string {
  const replacement = `bash -c 'printf "capture-marker-%s\\n" "${exitStatus}"; exit ${exitStatus}' `;
  const contractCommand =
    /CARGO_LOG=cargo::core::compiler::fingerprint=info \\\n+\s*bun run check:e2e:tauri/;
  const buildCommand =
    /CARGO_LOG=cargo::core::compiler::fingerprint=info \\\n+\s*bun run tauri build --debug --no-bundle \$\{\{ runner\.os == 'Windows' && '--features e2e-webview2-attach' \|\| '' \}\} \\\n+\s*/;
  const command =
    stepName === "Run native contracts" ? contractCommand : buildCommand;
  const rendered = step.replace(command, replacement);

  expect(rendered, `replace ${stepName} command`).not.toBe(step);
  return `mkdir -p native-contract-diagnostics\n${rendered}`;
}

async function runCapture(step: string): Promise<{ code: number; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "native-failure-timing-"));

  try {
    await execFileAsync("bash", ["-e", "-o", "pipefail", "-c", step], {
      cwd: directory,
    });
    return { code: 0, directory };
  } catch (error) {
    const code = (error as { code?: number }).code;
    return { code: typeof code === "number" ? code : 1, directory };
  }
}

describe("native capture timing artifacts under Bash errexit (#697)", () => {
  for (const captureCase of captureCases) {
    it(`${captureCase.name} records a successful command`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-failure-timing-"));

      try {
        const step = replaceProductionCommand(
          await captureStep(captureCase.name),
          captureCase.name,
          0,
        );
        const result = await execFileAsync(
          "bash",
          ["-e", "-o", "pipefail", "-c", step],
          { cwd: directory },
        );

        expect(result.stderr).toBe("");
        expect(
          await readFile(
            join(directory, "native-contract-diagnostics", captureCase.logName),
            "utf8",
          ),
        ).toContain("capture-marker-0");
        const timing = await readFile(
          join(directory, "native-contract-diagnostics", captureCase.timingName),
          "utf8",
        );
        expect(timing).toContain(`command=${captureCase.command}`);
        expect(timing).toMatch(
          /started_at=.+\nfinished_at=.+\nexit_status=0\n/,
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });

    it(`${captureCase.name} records a failed command before returning its status`, async () => {
      const exitStatus = 37;
      const result = await runCapture(
        replaceProductionCommand(
          await captureStep(captureCase.name),
          captureCase.name,
          exitStatus,
        ),
      );

      try {
        expect(result.code).toBe(exitStatus);
        expect(
          await readFile(
            join(result.directory, "native-contract-diagnostics", captureCase.logName),
            "utf8",
          ),
        ).toContain(`capture-marker-${exitStatus}`);
        const timing = await readFile(
          join(
            result.directory,
            "native-contract-diagnostics",
            captureCase.timingName,
          ),
          "utf8",
        );
        expect(timing).toContain(`command=${captureCase.command}`);
        expect(timing).toMatch(
          new RegExp(`started_at=.+\\nfinished_at=.+\\nexit_status=${exitStatus}\\n`),
        );
      } finally {
        await rm(result.directory, { force: true, recursive: true });
      }
    });
  }
});
