import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { accept } = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock("$lib/api/plugin-jobs", () => ({ startNanoBananaJob: vi.fn() }));
vi.mock("$lib/state/plugin-jobs", () => ({ pluginJobsController: { accept } }));
import { startExternalJobProbe } from "../../src/test-support/external-job-probe";

let dataset: Record<string, string>;
beforeEach(() => {
  dataset = {};
  accept.mockReset();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => vi.unstubAllGlobals());

const request = { token: "job-1", sourcePath: "/in.png", outputDir: "/out", outputFilename: "out.png" };

it("reports a rejected job acceptance to the spec instead of timing out", async () => {
  accept.mockRejectedValue(new Error("plugin disabled"));
  startExternalJobProbe(new AbortController().signal);
  window.dispatchEvent(new CustomEvent("e2e-external-job", { detail: request }));
  await vi.waitFor(() => expect(dataset.e2eExternalJobResult).toBeDefined());
  expect(JSON.parse(dataset.e2eExternalJobResult)).toEqual({ token: "job-1", error: "Error: plugin disabled" });
});

it("publishes the accepted job under the request token", async () => {
  accept.mockResolvedValue({ accepted: true });
  startExternalJobProbe(new AbortController().signal);
  window.dispatchEvent(new CustomEvent("e2e-external-job", { detail: request }));
  await vi.waitFor(() => expect(dataset.e2eExternalJobResult).toBeDefined());
  expect(JSON.parse(dataset.e2eExternalJobResult)).toEqual({ token: "job-1", result: { accepted: true } });
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "nano-banana", label: "out.png" }),
    expect.any(Function),
  );
});
