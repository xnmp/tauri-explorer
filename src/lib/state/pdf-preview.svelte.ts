import type {
  PdfDocument,
  PdfLoadJob,
  PdfPage,
  PdfRenderJob,
} from "$lib/api/pdf-preview";
import { extractError } from "$lib/api/common";

export function createPdfPreview(load: (path: string) => PdfLoadJob) {
  let state = $state.raw<{
    loading: boolean;
    error: string | null;
    pageCount: number;
    pageNumber: number;
    page: PdfPage | null;
  }>({
    loading: true,
    error: null,
    pageCount: 0,
    pageNumber: 1,
    page: null,
  });
  let document: PdfDocument | null = null;
  let job: PdfLoadJob | null = null;
  let documentRevision = 0;
  let pageRevision = 0;
  let disposed = false;
  async function selectPage(number: number): Promise<void> {
    const doc = document;
    if (!doc || disposed) return;
    const pageNumber = Math.max(
      1,
      Math.min(doc.pageCount, Math.trunc(number) || 1),
    );
    const revision = ++pageRevision;
    if (pageNumber === state.pageNumber && state.page) return;
    const previousPage = state.page;
    state = { ...state, pageNumber, page: null, loading: true, error: null };
    previousPage?.release();
    try {
      const page = await doc.getPage(pageNumber);
      if (!disposed && revision === pageRevision && doc === document)
        state = { ...state, page, loading: false };
      else page.release();
    } catch (error) {
      if (!disposed && revision === pageRevision && doc === document)
        state = { ...state, error: extractError(error), loading: false };
    }
  }
  return {
    get state() {
      return state;
    },
    async open(path: string): Promise<void> {
      if (disposed) return;
      const revision = ++documentRevision;
      ++pageRevision;
      state.page?.release();
      job?.cancel();
      document = null;
      state = {
        loading: true,
        error: null,
        pageCount: 0,
        pageNumber: 1,
        page: null,
      };
      job = load(path);
      try {
        const doc = await job.promise;
        if (disposed || revision !== documentRevision) return;
        document = doc;
        state = { ...state, pageCount: doc.pageCount };
        await selectPage(1);
      } catch (error) {
        if (!disposed && revision === documentRevision)
          state = { ...state, loading: false, error: extractError(error) };
      }
    },
    selectPage,
    async navigate(destination: string | unknown[]): Promise<void> {
      const doc = document;
      if (!doc || disposed) return;
      const revision = ++pageRevision;
      try {
        const number = await doc.resolveDestination(destination);
        if (
          !disposed &&
          revision === pageRevision &&
          doc === document &&
          number
        )
          await selectPage(number);
      } catch (error) {
        if (!disposed && revision === pageRevision && doc === document)
          state = { ...state, error: extractError(error) };
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ++documentRevision;
      ++pageRevision;
      const page = state.page;
      state = { ...state, page: null, loading: false };
      page?.release();
      job?.cancel();
      job = null;
      document = null;
    },
  };
}

/** Detached canvases let cancelled page/zoom renders finish without painting stale content. */
export function createPdfRenderLifetime() {
  let revision = 0;
  let job: PdfRenderJob | null = null;
  let disposed = false;
  return {
    async render(
      next: PdfRenderJob,
      publish: (canvas: HTMLCanvasElement) => void,
      fail: (error: string) => void,
    ) {
      const current = ++revision;
      job?.cancel();
      job = next;
      try {
        const canvas = await next.promise;
        if (!disposed && current === revision) publish(canvas);
      } catch (error) {
        if (!disposed && current === revision) fail(extractError(error));
      }
    },
    cancel() {
      ++revision;
      job?.cancel();
      job = null;
    },
    dispose() {
      disposed = true;
      ++revision;
      job?.cancel();
      job = null;
    },
  };
}
