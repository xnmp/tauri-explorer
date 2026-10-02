import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getDocument: vi.fn() }));
vi.mock("$lib/api/common", () => ({
  invoke: mocks.invoke,
  virtualPathGuard: () => null,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  PDFWorker: { create: () => ({ destroy() {} }) },
  getDocument: mocks.getDocument,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "/pdf-worker.mjs",
}));
import { loadPdf } from "$lib/api/pdf-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class OwnedWorker extends EventTarget {
  static instances: OwnedWorker[] = [];
  static afterReady: (() => void) | undefined;
  stopped = false;
  constructor() {
    super();
    OwnedWorker.instances.push(this);
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { sourceName: "worker", targetName: "main", action: "ready" },
        }),
      );
      OwnedWorker.afterReady?.();
    });
  }
  terminate() {
    this.stopped = true;
  }
  fail() {
    this.dispatchEvent(
      Object.assign(new Event("error", { cancelable: true }), {
        message: "Worker failed",
      }),
    );
  }
}
beforeEach(() => {
  OwnedWorker.instances = [];
  OwnedWorker.afterReady = undefined;
  mocks.invoke.mockReset().mockResolvedValue(new ArrayBuffer(4));
  mocks.getDocument.mockReset();
  vi.stubGlobal("Worker", OwnedWorker);
  vi.stubGlobal("document", {
    baseURI: "https://preview.test/",
    documentElement: { dataset: {} },
  });
  vi.stubGlobal("location", { origin: "https://preview.test" });
});
afterEach(() => vi.unstubAllGlobals());

describe("owned PDF transport and lifecycle", () => {
  it("does not start parsing when cancelled in the worker readiness turn", async () => {
    mocks.getDocument.mockReturnValue({
      destroy: async () => {},
      promise: Promise.resolve({ numPages: 1 }),
    });
    const job = loadPdf("/document.pdf");
    OwnedWorker.afterReady = () => job.cancel();
    await expect(job.promise).rejects.toThrow("PDF load cancelled");
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
  for (const ending of ["failure", "cancel"] as const) {
    it(`ends an indirect link resolution on worker ${ending}`, async () => {
      const index = deferred<number>();
      const getPageIndex = vi.fn(() => index.promise);
      mocks.getDocument.mockReturnValue({
        destroy: async () => {},
        promise: Promise.resolve({
          numPages: 3,
          getPageIndex,
          getDestination: async () => [{ num: 8, gen: 0 }],
        }),
      });
      const job = loadPdf("/document.pdf");
      const doc = await job.promise;
      const destination = doc.resolveDestination("chapter");
      await vi.waitFor(() => expect(getPageIndex).toHaveBeenCalled());
      const assertion = expect(destination).rejects.toThrow(
        ending === "failure" ? "Worker failed" : "PDF load cancelled",
      );
      if (ending === "failure") OwnedWorker.instances[0].fail();
      else job.cancel();
      await assertion;
      job.cancel();
    });
  }
  it("cancellation returns before a delayed binary read and starts no stale worker", async () => {
    const bytes = deferred<ArrayBuffer>();
    mocks.invoke.mockReturnValue(bytes.promise);
    const job = loadPdf("/document.pdf");
    const assertion = expect(job.promise).rejects.toThrow("PDF load cancelled");
    job.cancel();
    await assertion;
    bytes.resolve(new ArrayBuffer(4));
    await Promise.resolve();
    expect(OwnedWorker.instances).toHaveLength(0);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
  it("keeps the worker available until document cleanup acknowledges, then terminates it", async () => {
    const cleanup = deferred<void>();
    mocks.getDocument.mockReturnValue({
      destroy: () => cleanup.promise,
      promise: Promise.resolve({ numPages: 1 }),
    });
    const job = loadPdf("/document.pdf");
    await job.promise;
    job.cancel();
    expect(OwnedWorker.instances[0].stopped).toBe(false);
    cleanup.resolve();
    await vi.waitFor(() => expect(OwnedWorker.instances[0].stopped).toBe(true));
  });
});
