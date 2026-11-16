/**
 * Report a crash through the Report Issue dialog (#1684). Loaded on demand
 * from the crash notice, so the report draft store and dialog stay out of the
 * startup bundle until a reporter chooses to report.
 */
import { crashDraftUpdate } from "$lib/domain/crash-report-draft";
import { crashReportStore } from "./crash-report.svelte";
import { dialogStore } from "./dialogs.svelte";
import { userReportDraftStore } from "./user-report-draft.svelte";

/** Attach the offered crash to the report draft and open Report Issue. */
export function reportOfferedCrash(): void {
  const crash = crashReportStore.attachToReport();
  if (!crash) return;
  const update = crashDraftUpdate(userReportDraftStore.value, crash.contents);
  if (update) userReportDraftStore.update(update);
  dialogStore.openUserReport();
}
