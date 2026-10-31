import {
  clearUserReportToken,
  saveUserReportToken,
  userReportTokenState,
} from "$lib/api/user-report";
import { normalizeGitHubToken, type ReportTokenState } from "$lib/domain/user-report-route";

export interface ReportTokenApi {
  state(): Promise<ReportTokenState>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

const nativeApi: ReportTokenApi = {
  state: userReportTokenState,
  save: saveUserReportToken,
  clear: clearUserReportToken,
};

function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * Saved-GitHub-token status for issue reports (#1455). Only whether a token is
 * saved is known here; the value is write-only and lives in the OS keyring.
 */
export function createReportTokenStore(api: ReportTokenApi = nativeApi) {
  let state = $state<ReportTokenState>("absent");
  let busy = $state(false);
  let error = $state("");
  let generation = 0;

  async function refresh(): Promise<ReportTokenState> {
    const current = ++generation;
    let next: ReportTokenState;
    try {
      next = await api.state();
    } catch {
      next = "unavailable";
    }
    // A save/clear that started later owns the state.
    if (current === generation) state = next;
    return state;
  }

  async function mutate(work: () => Promise<void>, fallback: string): Promise<boolean> {
    busy = true;
    error = "";
    generation++;
    try {
      await work();
      return true;
    } catch (cause) {
      error = errorMessage(cause, fallback);
      return false;
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function save(raw: string): Promise<boolean> {
    const normalized = normalizeGitHubToken(raw);
    if ("error" in normalized) {
      error = normalized.error;
      return false;
    }
    return mutate(() => api.save(normalized.token), "Could not save the token.");
  }

  function clear(): Promise<boolean> {
    return mutate(() => api.clear(), "Could not remove the token.");
  }

  return {
    get state() { return state; },
    get busy() { return busy; },
    get error() { return error; },
    refresh,
    save,
    clear,
  };
}

export const reportTokenStore = createReportTokenStore();
