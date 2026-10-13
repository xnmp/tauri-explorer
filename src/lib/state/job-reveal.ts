/** Keep reveal effects off startup; cancellation also owns a pending import. */
import { toastStore } from "./toast.svelte";
import type { Job } from "./jobs.svelte";

let revision = 0;
let loaded: typeof import("./job-reveal-effects").jobRevealController | undefined;
let pending: Promise<typeof import("./job-reveal-effects")> | undefined;

const load = () => pending ??= import("./job-reveal-effects").catch(error => {
  pending = undefined;
  throw error;
});

const abort = () => {
  revision += 1;
  loaded?.abort();
};

export const jobRevealController = {
  abort,
  async show(job: Job): Promise<void> {
    abort();
    const request = revision;
    try {
      const { jobRevealController: controller } = await load();
      if (request !== revision) return;
      loaded = controller;
      await controller.show(job);
    } catch {
      if (request === revision) toastStore.show("The image could not be shown", "info");
    }
  },
};
