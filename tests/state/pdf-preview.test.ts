import { describe, expect, it, vi } from "vitest";
import {
  createPdfPreview,
  createPdfRenderLifetime,
} from "$lib/state/pdf-preview.svelte";
import type { PdfDocument, PdfPage } from "$lib/api/pdf-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const page = (width: number): PdfPage => ({
  size: { width, height: 800 },
  links: [],
  render: vi.fn(),
  release: vi.fn(),
});
const doc = (getPage: PdfDocument["getPage"]): PdfDocument => ({
  pageCount: 3,
  getPage,
  resolveDestination: async () => 2,
});

describe("PDF preview ownership", () => {
  it("releases departed and stale pages and disposes the active page exactly once", async () => {
    const first = page(100),
      current = page(300),
      stale = page(200);
    const pending = deferred<PdfPage>();
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(
        doc(async (n) =>
          n === 1 ? first : n === 2 ? pending.promise : current,
        ),
      ),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    const old = preview.selectPage(2);
    await preview.selectPage(3);
    pending.resolve(stale);
    await old;
    preview.dispose();
    preview.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(current.release).toHaveBeenCalledOnce();
    expect(stale.release).toHaveBeenCalledOnce();
    expect(preview.state.page).toBeNull();
  });
  it("cancels old document loading and never publishes a delayed old page", async () => {
    const old = deferred<PdfDocument>(),
      current = deferred<PdfDocument>();
    const cancel = vi.fn();
    const preview = createPdfPreview((path) => ({
      promise: path === "old" ? old.promise : current.promise,
      cancel,
    }));
    const first = preview.open("old"),
      second = preview.open("new");
    current.resolve(doc(async () => page(500)));
    await second;
    old.resolve(doc(async () => page(900)));
    await first;
    expect(preview.state.page?.size.width).toBe(500);
    expect(cancel).toHaveBeenCalledOnce();
    preview.dispose();
  });
  it("a late page cannot replace the selected later page", async () => {
    const delayed = deferred<PdfPage>();
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(
        doc(async (n) => (n === 2 ? delayed.promise : page(n * 100))),
      ),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    const old = preview.selectPage(2);
    await preview.selectPage(3);
    delayed.resolve(page(200));
    await old;
    expect(preview.state.pageNumber).toBe(3);
    expect(preview.state.page?.size.width).toBe(300);
    preview.dispose();
  });
  it("an internal link cannot override a newer page selection", async () => {
    const destination = deferred<number | null>();
    const document = {
      ...doc(async (n) => page(n * 100)),
      resolveDestination: () => destination.promise,
    };
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(document),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    const old = preview.navigate("target");
    await preview.selectPage(3);
    destination.resolve(2);
    await old;
    expect(preview.state.pageNumber).toBe(3);
    preview.dispose();
  });
  it("reports malformed documents and clears stale content immediately", async () => {
    const bad = deferred<PdfDocument>();
    const preview = createPdfPreview((path) => ({
      promise:
        path === "good"
          ? Promise.resolve(doc(async () => page(600)))
          : bad.promise,
      cancel: vi.fn(),
    }));
    await preview.open("good");
    const pending = preview.open("bad");
    expect(preview.state.page).toBeNull();
    expect(preview.state.loading).toBe(true);
    bad.reject(new Error("Invalid PDF structure"));
    await pending;
    expect(preview.state.error).toBe("Invalid PDF structure");
    expect(preview.state.loading).toBe(false);
    preview.dispose();
  });
  it("the later internal-link intent wins even if the first destination resolves sooner", async () => {
    const first = deferred<number | null>(),
      second = deferred<number | null>();
    const document = {
      ...doc(async (n) => page(n)),
      resolveDestination: (target: unknown) =>
        target === "first" ? first.promise : second.promise,
    };
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(document),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    const a = preview.navigate("first"),
      b = preview.navigate("second");
    first.resolve(2);
    await a;
    second.resolve(3);
    await b;
    expect(preview.state.pageNumber).toBe(3);
    preview.dispose();
  });
  it("choosing the current page invalidates a pending internal link", async () => {
    const destination = deferred<number | null>();
    const document = {
      ...doc(async (n) => page(n)),
      resolveDestination: () => destination.promise,
    };
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(document),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    const link = preview.navigate("target");
    await preview.selectPage(1);
    destination.resolve(2);
    await link;
    expect(preview.state.pageNumber).toBe(1);
    preview.dispose();
  });
  it("unmount cancels pending work and rejects its later publication", async () => {
    const pending = deferred<PdfDocument>();
    const cancel = vi.fn();
    const preview = createPdfPreview(() => ({
      promise: pending.promise,
      cancel,
    }));
    const opening = preview.open("pdf");
    preview.dispose();
    pending.resolve(doc(async () => page(600)));
    await opening;
    expect(preview.state.page).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("page navigation clamps to the document bounds", async () => {
    const preview = createPdfPreview(() => ({
      promise: Promise.resolve(doc(async (n) => page(n))),
      cancel: vi.fn(),
    }));
    await preview.open("pdf");
    await preview.selectPage(100000);
    expect(preview.state.pageNumber).toBe(3);
    await preview.selectPage(-10);
    expect(preview.state.pageNumber).toBe(1);
    preview.dispose();
  });
  it("superseded rendering cannot paint or report an error over a newer canvas", async () => {
    const old = deferred<HTMLCanvasElement>(),
      current = deferred<HTMLCanvasElement>();
    const cancel = vi.fn();
    const lifetime = createPdfRenderLifetime();
    const publish = vi.fn(),
      fail = vi.fn();
    const first = lifetime.render(
      { promise: old.promise, cancel },
      publish,
      fail,
    );
    const second = lifetime.render(
      { promise: current.promise, cancel: vi.fn() },
      publish,
      fail,
    );
    const canvas = { marker: "current" } as unknown as HTMLCanvasElement;
    current.resolve(canvas);
    await second;
    old.reject(new Error("cancelled"));
    await first;
    expect(publish.mock.calls).toEqual([[canvas]]);
    expect(fail).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    lifetime.dispose();
  });
});
