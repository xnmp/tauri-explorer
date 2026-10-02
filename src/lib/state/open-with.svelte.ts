import { listOpenWithApplications, openFileWithApplication } from "$lib/api/open";
import type { OpenWithApplication } from "$lib/domain/open-with";

export function createOpenWithStore() {
  let session = $state.raw<object | null>(null);
  let path = $state("");
  let applications = $state<readonly OpenWithApplication[]>([]);
  let phase = $state<"closed" | "loading" | "ready" | "launching">("closed");
  let error = $state<string | null>(null);

  function close(): void {
    if (phase === "launching") return;
    session = null;
    phase = "closed";
    path = "";
    applications = [];
    error = null;
  }

  async function open(selectedPath: string): Promise<void> {
    if (phase === "launching") return;
    const opening = {};
    session = opening;
    path = selectedPath;
    applications = [];
    error = null;
    phase = "loading";
    const result = await listOpenWithApplications(selectedPath);
    if (session !== opening) return;
    phase = "ready";
    if (!result.ok) error = result.error;
    else applications = result.data;
  }

  async function choose(id: string): Promise<void> {
    if (phase !== "ready" || !applications.some(application => application.id === id)) return;
    const opening = session;
    const selectedPath = path;
    phase = "launching";
    error = null;
    const result = await openFileWithApplication(selectedPath, id);
    if (session !== opening) return;
    phase = "ready";
    if (!result.ok) error = result.error;
    else close();
  }

  return {
    get isOpen() { return phase !== "closed"; },
    get path() { return path; },
    get applications() { return applications; },
    get phase() { return phase; },
    get error() { return error; },
    open, choose, close,
  };
}

export const openWithStore = createOpenWithStore();
