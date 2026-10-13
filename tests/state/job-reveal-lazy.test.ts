import { afterEach, expect, it, vi } from "vitest";
import type { Job } from "$lib/state/jobs.svelte";

const effects = vi.hoisted(() => ({ show: vi.fn(async (_job: Job) => {}), abort: vi.fn() }));
vi.mock("$lib/state/job-reveal-effects", () => ({ jobRevealController: effects }));
import { jobRevealController } from "$lib/state/job-reveal";

const job = (id: number): Job => ({ id, label: "Image", detail: "", source: "fixture", status: "completed", startTime: 0 });
afterEach(() => { jobRevealController.abort(); vi.clearAllMocks(); });

it("does not reveal after the window cancels a pending import", async () => {
  const pending = jobRevealController.show(job(1));
  jobRevealController.abort();
  await pending;
  expect(effects.show).not.toHaveBeenCalled();
});

it("only reveals the latest image when clicks overlap module loading", async () => {
  const first = jobRevealController.show(job(1));
  const latest = job(2);
  const second = jobRevealController.show(latest);
  await Promise.all([first, second]);
  expect(effects.show.mock.calls.map(([job]) => job.id)).toEqual([latest.id]);
});

it("cancels running effects after the module has loaded", async () => {
  await jobRevealController.show(job(1));
  effects.abort.mockClear();
  jobRevealController.abort();
  expect(effects.abort).toHaveBeenCalledOnce();
});
