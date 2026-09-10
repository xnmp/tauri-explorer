/** E2E-only gate between a successful native file mutation and UI publication. */

export type HeldFileMutationCommand = "create_directory" | "rename_entry";

type ProbeStatus = "armed" | "held" | "released";

interface ProbeRecord {
  token: string;
  command: HeldFileMutationCommand;
  targetPath: string;
  status: ProbeStatus;
  resultPath?: string;
  heldAt?: number;
  releasedAt?: number;
  releaseReason?: "test" | "rearmed" | "pagehide";
}

interface ActiveProbe {
  token: string;
  command: HeldFileMutationCommand;
  targetPath: string;
  held: boolean;
  release: (() => void) | null;
}

let active: ActiveProbe | null = null;

function publish(record: ProbeRecord): void {
  document.documentElement.dataset.e2eFileMutationProbe = JSON.stringify(record);
}

function releaseActive(
  reason: ProbeRecord["releaseReason"],
  token?: string,
): void {
  const probe = active;
  if (!probe || (token !== undefined && probe.token !== token)) return;
  active = null;
  publish({
    token: probe.token,
    command: probe.command,
    targetPath: probe.targetPath,
    status: "released",
    releasedAt: Date.now(),
    releaseReason: reason,
  });
  probe.release?.();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("e2e-file-mutation-probe", ((
    event: CustomEvent<{
      token?: string;
      command?: HeldFileMutationCommand;
      targetPath?: string;
    }>,
  ) => {
    const { token, command, targetPath } = event.detail ?? {};
    if (!token || !targetPath || (command !== "create_directory" && command !== "rename_entry")) {
      return;
    }
    releaseActive("rearmed");
    active = { token, command, targetPath, held: false, release: null };
    publish({ token, command, targetPath, status: "armed" });
  }) as EventListener);

  window.addEventListener("e2e-file-mutation-release", ((
    event: CustomEvent<{ token?: string }>,
  ) => {
    if (event.detail?.token) releaseActive("test", event.detail.token);
  }) as EventListener);

  window.addEventListener("pagehide", () => {
    releaseActive("pagehide");
    delete document.documentElement.dataset.e2eFileMutationProbe;
    delete document.documentElement.dataset.e2eFileMutationProbeReady;
  }, { once: true });

  document.documentElement.dataset.e2eFileMutationProbeReady = "true";
}

/** Hold one matching successful result until its token is explicitly released. */
export async function holdFileMutationResult(
  command: HeldFileMutationCommand,
  targetPath: string,
  resultPath: string,
): Promise<void> {
  const probe = active;
  if (!probe || probe.held || probe.command !== command || probe.targetPath !== targetPath) return;

  probe.held = true;
  await new Promise<void>((resolve) => {
    if (active !== probe) {
      resolve();
      return;
    }
    probe.release = resolve;
    publish({
      token: probe.token,
      command,
      targetPath,
      resultPath,
      status: "held",
      heldAt: Date.now(),
    });
  });
}
