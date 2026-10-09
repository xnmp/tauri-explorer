/**
 * Retry action for a failed job entry in a jobs surface (the Image
 * generation panel, the Background Jobs panel). A successful retry removes
 * the focused Retry button with its entry; focus then moves to the
 * replacement job's entry (`[data-job-id]`), else to the surface itself, so
 * it never falls to <body>. Focus the user moved elsewhere meanwhile is kept.
 */
import { tick } from "svelte";
import { jobsStore } from "$lib/state/jobs.svelte";

export async function retryJobAndRefocus(id: number, surface: HTMLElement | undefined): Promise<void> {
  const replacement = await jobsStore.retryJob(id);
  if (replacement === null || !surface) return;
  await tick();
  const active = document.activeElement;
  if (active && active !== document.body && !surface.contains(active)) return;
  const entry = surface.querySelector<HTMLElement>(`[data-job-id="${replacement}"]`);
  (entry ?? surface).focus();
}
