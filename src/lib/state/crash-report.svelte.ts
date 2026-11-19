/**
 * The crash a launch found (#184) and its path into Report Issue (#1684).
 *
 * `take_crash_report` consumes the crash file on read, so this store is the
 * only holder of the report for the rest of the session: offered by the
 * crash notice, then attached to the report draft until a report is
 * submitted or the reporter removes it. Memory only; never persisted.
 */
import type { CrashReport } from "$lib/api/crash";

export function createCrashReportStore() {
  let offered = $state.raw<CrashReport | null>(null);
  let attached = $state.raw<CrashReport | null>(null);

  return {
    /** Shown by the crash notice until reported or dismissed. */
    get offered(): CrashReport | null {
      return offered;
    },
    /** Offered to the Report Issue dialog as a diagnostics section. */
    get attached(): CrashReport | null {
      return attached;
    },
    offer(report: CrashReport | null): void {
      offered = report;
    },
    dismiss(): void {
      offered = null;
    },
    /** Move the offered crash into the report draft and return it. */
    attachToReport(): CrashReport | null {
      if (!offered) return null;
      attached = offered;
      offered = null;
      return attached;
    },
    /** Forget the attached crash (after a submitted report). */
    detach(): void {
      attached = null;
    },
  };
}

export const crashReportStore = createCrashReportStore();

/**
 * Take the launch's crash report into `store`, in a foreground window only.
 * Taking consumes the report (it is marked seen), so a parked warm window,
 * which may stay hidden for the whole session, must never take it: the
 * notice would be shown where nobody sees it (#1686).
 */
export async function claimLaunchCrash(
  store: Pick<ReturnType<typeof createCrashReportStore>, "offer">,
  take: () => Promise<CrashReport | null>,
  foreground: boolean,
): Promise<void> {
  if (!foreground) return;
  store.offer(await take());
}
