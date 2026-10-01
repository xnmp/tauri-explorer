/** E2E-only gate between a successful native file mutation and UI publication. */
import { interceptFileMutations, type HeldFileMutationCommand } from "$lib/api/files";

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

/**
 * Arm with `e2e-file-mutation-probe` `{ token, command, targetPath }`; the
 * next matching successful mutation is held (status in
 * `data-e2e-file-mutation-probe`) until `e2e-file-mutation-release`
 * `{ token }`, a re-arm, or the page session ends.
 */
export function startFileMutationProbe(signal: AbortSignal): void {
  if (signal.aborted) return;
  const root = document.documentElement;
  let active: ActiveProbe | null = null;

  const publish = (record: ProbeRecord) => {
    if (!signal.aborted) root.dataset.e2eFileMutationProbe = JSON.stringify(record);
  };

  const releaseActive = (reason: ProbeRecord["releaseReason"], token?: string) => {
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
  };

  /** Hold one matching successful result until its token is explicitly released. */
  const stopIntercepting = interceptFileMutations(async (command, targetPath, resultPath) => {
    const probe = active;
    if (!probe || probe.held || probe.command !== command || probe.targetPath !== targetPath) return;
    probe.held = true;
    await new Promise<void>((resolve) => {
      if (active !== probe) {
        resolve();
        return;
      }
      probe.release = resolve;
      publish({ token: probe.token, command, targetPath, resultPath, status: "held", heldAt: Date.now() });
    });
  });

  window.addEventListener("e2e-file-mutation-probe", ((
    event: CustomEvent<{ token?: string; command?: HeldFileMutationCommand; targetPath?: string }>,
  ) => {
    const { token, command, targetPath } = event.detail ?? {};
    if (!token || !targetPath || (command !== "create_directory" && command !== "rename_entry")) return;
    releaseActive("rearmed");
    active = { token, command, targetPath, held: false, release: null };
    publish({ token, command, targetPath, status: "armed" });
  }) as EventListener, { signal });

  window.addEventListener("e2e-file-mutation-release", ((event: CustomEvent<{ token?: string }>) => {
    if (event.detail?.token) releaseActive("test", event.detail.token);
  }) as EventListener, { signal });

  // A held mutation must never outlive its page: release it on unload as well
  // as when the page session retires the probe.
  const retire = () => {
    releaseActive("pagehide");
    stopIntercepting();
    delete root.dataset.e2eFileMutationProbe;
    delete root.dataset.e2eFileMutationProbeReady;
  };
  window.addEventListener("pagehide", retire, { once: true, signal });
  signal.addEventListener("abort", retire, { once: true });

  root.dataset.e2eFileMutationProbeReady = "true";
}
