import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { invoke, virtualPathGuard } from "./common";
import { safePdfLink, type Size } from "$lib/domain/pdf-preview";

export interface PdfLink {
  readonly rect: readonly number[];
  readonly label: string;
  readonly url: string | null;
  readonly destination: string | unknown[] | null;
}
export interface PdfRenderJob {
  readonly promise: Promise<HTMLCanvasElement>;
  cancel(): void;
}
export interface PdfPage {
  readonly size: Size;
  readonly links: readonly PdfLink[];
  render(scale: number, pixelRatio: number): PdfRenderJob;
  release(): void;
}
export interface PdfDocument {
  readonly pageCount: number;
  getPage(number: number): Promise<PdfPage>;
  resolveDestination(destination: string | unknown[]): Promise<number | null>;
}
export interface PdfLoadJob {
  readonly promise: Promise<PdfDocument>;
  cancel(): void;
}

function wrapPage(
  page: PDFPageProxy,
  links: readonly PdfLink[],
  workerFailure: Promise<never>,
): PdfPage {
  const viewport = page.getViewport({ scale: 1 });
  const renders = new Set<{ cancel(): void }>();
  let released = false;
  const cleanup = () => {
    if (released && !renders.size) page.cleanup();
  };
  return {
    size: { width: viewport.width, height: viewport.height },
    links,
    render(scale, pixelRatio) {
      if (released)
        return {
          promise: Promise.reject(new Error("PDF page was released")),
          cancel() {},
        };
      const view = page.getViewport({ scale });
      // Bound backing memory independently of CSS zoom and document dimensions.
      const ratio = Math.min(
        Math.max(1, pixelRatio),
        4096 / view.width,
        4096 / view.height,
        Math.sqrt(16_000_000 / (view.width * view.height)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(view.width * ratio));
      canvas.height = Math.max(1, Math.floor(view.height * ratio));
      const task = page.render({
        canvas,
        viewport: view,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      renders.add(task);
      return {
        promise: Promise.race([task.promise, workerFailure])
          .then(() => canvas)
          .finally(() => {
            renders.delete(task);
            cleanup();
          }),
        cancel: () => task.cancel(),
      };
    },
    release() {
      released = true;
      for (const task of renders) task.cancel();
      cleanup();
    },
  };
}

async function wrapDocument(
  doc: PDFDocumentProxy,
  workerFailure: Promise<never>,
): Promise<PdfDocument> {
  return {
    pageCount: doc.numPages,
    async getPage(number) {
      const page = await Promise.race([doc.getPage(number), workerFailure]);
      const viewport = page.getViewport({ scale: 1 });
      const annotations = await Promise.race([
        page.getAnnotations({ intent: "display" }),
        workerFailure,
      ]);
      const links = annotations
        .filter((a) => a.subtype === "Link")
        .flatMap((a) => {
          const url = safePdfLink(a.url);
          const destination =
            typeof a.dest === "string" || Array.isArray(a.dest) ? a.dest : null;
          if (!url && !destination) return [];
          const rect = [
            ...viewport.convertToViewportPoint(a.rect[0], a.rect[1]),
            ...viewport.convertToViewportPoint(a.rect[2], a.rect[3]),
          ];
          return [
            {
              rect: [
                Math.min(rect[0], rect[2]),
                Math.min(rect[1], rect[3]),
                Math.abs(rect[2] - rect[0]),
                Math.abs(rect[3] - rect[1]),
              ],
              label: a.contentsObj?.str || url || "Go to PDF destination",
              url,
              destination,
            },
          ];
        });
      return wrapPage(page, links, workerFailure);
    },
    async resolveDestination(destination) {
      const dest =
        typeof destination === "string"
          ? await Promise.race([doc.getDestination(destination), workerFailure])
          : destination;
      if (!dest?.length) return null;
      const reference = dest[0];
      const index =
        typeof reference === "number"
          ? reference
          : reference &&
              typeof reference === "object" &&
              "num" in reference &&
              "gen" in reference
            ? await Promise.race([
                doc.getPageIndex(reference as { num: number; gen: number }),
                workerFailure,
              ])
            : -1;
      return index >= 0 && index < doc.numPages ? index + 1 : null;
    },
  };
}

function workerReceipt(
  id: string,
  path: string,
  phase: string,
  url?: string,
): void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_E2E_HOOKS === "1")) return;
  try {
    const root = document.documentElement;
    const events = JSON.parse(root.dataset.e2ePdfWorkers || "[]");
    root.dataset.e2ePdfWorkers = JSON.stringify(
      [
        ...events,
        {
          id,
          path,
          phase,
          url,
          origin: location.origin,
          at: performance.now(),
        },
      ].slice(-64),
    );
  } catch {
    /* Diagnostic receipts must not affect preview behavior. */
  }
}

export function loadPdf(path: string): PdfLoadJob {
  let cancelled = false;
  const workerId = crypto.randomUUID();
  let task: { destroy(): Promise<void> } | undefined;
  let worker: Worker | undefined;
  let pdfWorker: { destroy(): void } | undefined;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => undefined);
  const cleanup = () => {
    const ownedTask = task,
      ownedPdfWorker = pdfWorker,
      ownedWorker = worker;
    task = undefined;
    pdfWorker = undefined;
    worker = undefined;
    const terminate = () => {
      ownedPdfWorker?.destroy();
      if (ownedWorker) {
        ownedWorker.terminate();
        workerReceipt(workerId, path, "terminated");
      }
    };
    // Selection/render cancellation is immediate. Keep the port alive until PDF.js
    // acknowledges destruction and releases document FontFaces/filter resources.
    if (ownedTask)
      void ownedTask
        .destroy()
        .catch(() => undefined)
        .finally(terminate);
    else terminate();
  };
  const promise = Promise.race([
    (async () => {
      const guard = virtualPathGuard(path);
      if (guard) throw new Error(guard.error);
      const raw = await invoke<ArrayBuffer | number[]>("read_pdf_bytes", {
        path,
      });
      if (cancelled) throw new Error("PDF load cancelled");
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { default: workerUrl } =
        await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
      if (cancelled) throw new Error("PDF load cancelled");
      // An explicit port avoids PDF.js's opaque-origin blob wrapper/fake-worker fallback in Tauri.
      const ownedWorker = (worker = new Worker(workerUrl, {
        type: "module",
        name: "explorer-pdf",
      }));
      let ready!: () => void;
      const readiness = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const onReady = (event: MessageEvent) => {
        if (
          event.data?.sourceName === "worker" &&
          event.data?.targetName === "main" &&
          event.data?.action === "ready"
        )
          ready();
      };
      workerReceipt(workerId, path, "created", workerUrl);
      ownedWorker.addEventListener("message", onReady);
      let rejectFailure!: (error: Error) => void;
      const failure = new Promise<never>((_, reject) => {
        rejectFailure = reject;
      });
      void failure.catch(() => undefined);
      const ended = Promise.race([failure, cancellation]);
      void ended.catch(() => undefined);
      ownedWorker.addEventListener("error", (event) => {
        event.preventDefault();
        rejectFailure(new Error(event.message || "PDF worker failed to start"));
      });
      try {
        await Promise.race([readiness, failure, cancellation]);
      } finally {
        ownedWorker.removeEventListener("message", onReady);
      }
      if (cancelled) throw new Error("PDF load cancelled");
      workerReceipt(workerId, path, "ready", workerUrl);
      const ownedPdfWorker = pdfjs.PDFWorker.create({ port: ownedWorker });
      pdfWorker = ownedPdfWorker;
      const resources = new URL("generated/pdfjs/", document.baseURI).href;
      const loading = pdfjs.getDocument({
        data: new Uint8Array(raw),
        worker: ownedPdfWorker,
        cMapUrl: `${resources}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${resources}standard_fonts/`,
        wasmUrl: `${resources}wasm/`,
        iccUrl: `${resources}iccs/`,
        useWasm: false,
        stopAtErrors: true,
      });
      task = loading;
      return wrapDocument(
        await Promise.race([loading.promise, failure, cancellation]),
        ended,
      );
    })(),
    cancellation,
  ]).catch((error) => {
    cleanup();
    throw error;
  });
  return {
    promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      rejectCancellation(new Error("PDF load cancelled"));
      cleanup();
    },
  };
}

export function openPdfLink(url: string): Promise<void> {
  const safe = safePdfLink(url);
  if (!safe) return Promise.reject(new Error("Unsupported PDF link"));
  return invoke<void>("open_pdf_link", { url: safe });
}
