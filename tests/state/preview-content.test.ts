import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewImageOptions } from "$lib/state/preview-image";
import type { FileEntry } from "$lib/domain/file";
const mocks = vi.hoisted(() => ({ readTextFile: vi.fn(), fetchDirectory: vi.fn(), listArchiveContents: vi.fn(), loadPreviewImage: vi.fn(), decodeImage: vi.fn(), getVideoThumbnailData: vi.fn() }));
vi.mock("$lib/api/files", () => ({ readTextFile: mocks.readTextFile, fetchDirectory: mocks.fetchDirectory }));
vi.mock("$lib/api/archive", () => ({ listArchiveContents: mocks.listArchiveContents }));
vi.mock("$lib/api/thumbnails", () => ({ getVideoThumbnailData: mocks.getVideoThumbnailData }));
vi.mock("$lib/state/preview-image", () => ({ loadPreviewImage: mocks.loadPreviewImage, decodeImage: mocks.decodeImage }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));
import { createPreviewContentLoader, type PreviewContent } from "$lib/state/preview-content";
import { renderMarkdown } from "$lib/domain/markdown";
import type { FrameScheduler } from "$lib/domain/progressive-reveal";
const file = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ name, path: `/${name}`, kind, size: 12, modified: "today" });
const ready = (url: string, resolution: "original" | "rendition" = "original") => ({ status: "ready", url, viaBackend: true, resolution, decoded: { naturalWidth: 100, naturalHeight: 100 } });
const Pdf = function Pdf() {};
const Video = function Video() {};
/** Frames end immediately unless a test drives them (`manualFrames`). */
const immediateFrames: FrameScheduler = { now: () => 0, nextFrame: async () => {} };
function surface(viewers = { pdf: vi.fn(async () => Pdf), video: vi.fn(async () => Video) }, frames: FrameScheduler = immediateFrames) {
  let content: PreviewContent<typeof Pdf, typeof Video> = { kind: "empty" };
  const published: PreviewContent<typeof Pdf, typeof Video>[] = [];
  const revoked = vi.fn();
  const loader = createPreviewContentLoader(revoked, viewers, frames);
  return { loader, revoked, viewers, published, get content() { return content; }, load: (entry: FileEntry, revision = 0, imageOptions: PreviewImageOptions = {}) => loader.load(entry, content, { localRevision: revision, imageOptions }, next => { content = next; published.push(next); }) };
}
/** A frame boundary the test advances explicitly. */
function manualFrames() {
  let waiting: (() => void)[] = [];
  const scheduler: FrameScheduler = { now: () => 0, nextFrame: () => new Promise<void>(resolve => { waiting.push(resolve); }) };
  return {
    scheduler,
    get pending() { return waiting.length; },
    /** Ends the current frame and lets the work it released run. */
    async frame() {
      const released = waiting; waiting = [];
      released.forEach(resolve => resolve());
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}
const markdownHtml = (content: PreviewContent) => content.kind === "markdown" ? content.blocks.join("") : null;
beforeEach(() => { vi.resetAllMocks(); });

describe("preview content dispatch and replacement", () => {
  it("loads HTML without syntax highlighting or the source preview line limit", async () => {
    const s = surface();
    const document = "<!doctype html>\n" + "\n".repeat(220) + "<h1>Last heading</h1>";
    mocks.readTextFile.mockResolvedValue({ ok: true, data: document });
    await s.load(file("page.html"));
    expect(mocks.readTextFile).toHaveBeenCalledWith("/page.html", 524288);
    expect(s.content).toEqual({ kind: "html", document });
  });

  it("discards HTML that finishes after the user selects text", async () => {
    const s = surface();
    let finish!: (value: unknown) => void;
    mocks.readTextFile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = s.load(file("slow.html"));
    mocks.readTextFile.mockResolvedValueOnce({ ok: true, data: "Current selection" });
    await s.load(file("current.txt"));
    finish({ ok: true, data: "<h1>Obsolete</h1>" });
    await pending;
    expect(s.content).toEqual({ kind: "text", text: "Current selection", truncatedLines: 0, truncatedLabel: "lines" });
  });

  it.each(["LICENSE", "notes.txt", "output.log"])("keeps %s prose literal instead of guessing a code language", async name => {
    const s = surface();
    const text = 'MIT License\nCopyright (c) 2026 <xnmp> & contributors\nPermission is hereby granted, free of charge, to any person.';
    mocks.readTextFile.mockResolvedValue({ ok: true, data: text });
    await s.load(file(name));
    expect(s.content).toEqual({ kind: "text", text, truncatedLines: 0, truncatedLabel: "lines" });
  });

  it("keeps explicit shell syntax highlighting even when the icon category is not code", async () => {
    const s = surface();
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "#!/bin/sh\necho hello" });
    await s.load(file("run.sh"));
    expect(s.content).toMatchObject({ kind: "code", html: expect.stringContaining('class="hljs-built_in"') });
  });

  it("replaces image content and its hold with the next format, without leftover metadata", async () => {
    const s = surface();
    mocks.loadPreviewImage.mockResolvedValue(ready("blob:photo"));
    await s.load(file("a.avif"));
    expect(s.content).toMatchObject({ kind: "image", url: "blob:photo", note: "AVIF fallback preview shows the first frame.", held: false });
    let resolve!: (value: unknown) => void;
    mocks.loadPreviewImage.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = s.load(file("b.png"));
    expect(s.content).toMatchObject({ kind: "image", url: "blob:photo", note: null, held: true, rendition: null });
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "# Title" });
    await s.load(file("a.md"));
    expect(s.content).toMatchObject({ kind: "markdown", blocks: [expect.stringContaining("<h1>Title</h1>")], truncatedLines: 0 });
    resolve(ready("blob:late"));
    await pending;
    expect(s.content.kind).toBe("markdown");
    expect(s.revoked).toHaveBeenCalledWith("blob:late");
    s.loader.dispose();
    expect(s.revoked).toHaveBeenCalledWith("blob:photo");
  });

  it("drops a held image when its replacement fails", async () => {
    const s = surface();
    mocks.loadPreviewImage.mockResolvedValueOnce(ready("blob:a")).mockResolvedValueOnce({ status: "failed" });
    await s.load(file("a.png")); await s.load(file("b.png"));
    expect(s.content).toEqual({ kind: "error", message: "Cannot preview image" });
  });

  it("returns cached images synchronously and versions them by local revisions", async () => {
    const s = surface(); mocks.loadPreviewImage.mockResolvedValue(ready("blob:a"));
    await s.load(file("a.png")); await s.load(file("a.exe"));
    const pending = s.load(file("a.png"));
    expect(s.content).toMatchObject({ kind: "image", url: "blob:a", held: false });
    await pending;
    expect(mocks.loadPreviewImage).toHaveBeenCalledTimes(1);
    await s.load(file("a.png"), 1);
    expect(mocks.loadPreviewImage).toHaveBeenCalledTimes(2);
  });

  it("rejects an old same-path image revision and reuses source pixels on an unchanged revisit", async () => {
    const s = surface();
    const entry = file("a.jpg");
    let finish!: (value: unknown) => void;
    mocks.loadPreviewImage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = s.load(entry);
    mocks.loadPreviewImage.mockResolvedValueOnce({ ...ready("blob:new", "rendition"), sourceSize: { width: 7680, height: 4320 } });
    const updated = { ...entry, size: entry.size + 1, modified: "tomorrow" };
    await s.load(updated, 0, { rendition: { maxEdge: 2048 } });
    expect(s.content).toMatchObject({ sourceSize: { width: 7680, height: 4320 }, url: "blob:new" });
    finish({ ...ready("blob:old", "rendition"), sourceSize: { width: 1000, height: 500 } });
    await old;
    expect(s.content).toMatchObject({ sourceSize: { width: 7680, height: 4320 }, url: "blob:new" });
    await s.load(file("unsupported.exe"));
    await s.load(updated, 0, { rendition: { maxEdge: 2048 } });
    expect(s.content).toMatchObject({ sourceSize: { width: 7680, height: 4320 }, url: "blob:new" });
    expect(mocks.loadPreviewImage).toHaveBeenCalledTimes(2);
  });

  it.each(["mtime", "size", "local-revision", "selection"] as const)("rejects delayed source pixels when %s alone changes", async change => {
    const s = surface();
    const entry = file("a.jpg");
    const rendition = (width: number) => ({
      ...ready(`blob:${width}`, "rendition"), sourceSize: { width, height: 500 },
    });
    let finish!: (value: unknown) => void;
    mocks.loadPreviewImage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = s.load(entry, 0, { rendition: { maxEdge: 2048 } });
    const updated = change === "mtime" ? { ...entry, modified: "tomorrow" }
      : change === "size" ? { ...entry, size: entry.size + 1 }
      : change === "selection" ? file("b.jpg") : entry;
    mocks.loadPreviewImage.mockResolvedValueOnce(rendition(8000));
    await s.load(updated, change === "local-revision" ? 1 : 0, { rendition: { maxEdge: 2048 } });
    finish(rendition(1000));
    await old;
    expect(s.content).toMatchObject({ sourceSize: { width: 8000, height: 500 }, url: "blob:8000", held: false });
    s.loader.dispose();
  });

  it("removes source pixel metadata when a held rendition's replacement fails", async () => {
    const s = surface();
    mocks.loadPreviewImage.mockResolvedValueOnce({
      ...ready("blob:old-rendition", "rendition"), sourceSize: { width: 8000, height: 4000 },
    }).mockResolvedValueOnce({ status: "failed" });
    await s.load(file("a.jpg"));
    expect(s.content).toMatchObject({ sourceSize: { width: 8000, height: 4000 } });
    await s.load(file("broken.jpg"));
    expect(s.content).toEqual({ kind: "error", message: "Cannot preview image" });
    s.loader.dispose();
  });

  it.each(["LICENSE", "notes.txt", "server.log", "CHANGELOG.txt"])("preserves literal markup and ampersands in %s", async name => {
    const s = surface();
    const text = "<script>alert(1)</script> & plain = 123";
    mocks.readTextFile.mockResolvedValue({ ok: true, data: text });
    await s.load(file(name));
    expect(s.content).toMatchObject({ kind: "text", text });
    s.loader.dispose();
  });

  it("owns audio art through decoding and releases it on a non-image selection", async () => {
    const s = surface(); mocks.getVideoThumbnailData.mockResolvedValue({ ok: true, data: "blob:cover" });
    await s.load(file("a.mp3"));
    expect(mocks.getVideoThumbnailData).toHaveBeenCalledWith("/a.mp3", 1024);
    expect(mocks.decodeImage).toHaveBeenCalledWith("blob:cover");
    expect(s.content).toMatchObject({ kind: "audio-cover", url: "blob:cover", held: false });
    await s.load(file("a.exe"));
    expect(s.content).toEqual({ kind: "unsupported" });
    expect(s.revoked).toHaveBeenCalledWith("blob:cover");
  });

  it("collapses folder chains and presents archives through the folder result", async () => {
    const s = surface();
    mocks.fetchDirectory.mockResolvedValueOnce({ ok: true, data: { entries: [file("nested", "directory")] } }).mockResolvedValueOnce({ ok: true, data: { entries: [file("a.txt")] } });
    await s.load(file("folder", "directory"));
    expect(s.content).toEqual({ kind: "directory", entries: [file("a.txt")], collapsedRoot: "nested", collapsedNote: "single subfolder" });
    mocks.listArchiveContents.mockResolvedValue({ ok: true, data: { entries: [file("b.txt")], rootFolder: "root" } });
    await s.load(file("a.zip"));
    expect(s.content).toEqual({ kind: "zip", entries: [file("b.txt")], collapsedRoot: "root", collapsedNote: "single top-level folder" });
  });

  it("parses CSV before truncation and replaces its row label with text line truncation", async () => {
    const s = surface();
    mocks.readTextFile.mockResolvedValueOnce({ ok: true, data: 'a,b\n"line1\nline2",c\n' + 'x,y\n'.repeat(202) });
    await s.load(file("a.csv"));
    expect(s.content).toMatchObject({ kind: "csv", csv: { rows: expect.arrayContaining([["line1\nline2", "c"]]) }, truncatedLabel: "rows", truncatedLines: 203 });
    mocks.readTextFile.mockResolvedValueOnce({ ok: true, data: "hello\n".repeat(205) });
    await s.load(file("a.txt"));
    expect(s.content).toMatchObject({ kind: "text", truncatedLabel: "lines", truncatedLines: 206 });
    expect(mocks.readTextFile).toHaveBeenLastCalledWith("/a.txt", 524288);
  });

  it.each(["a.pdf", "a.mp4"])("loads the lazy viewer for %s with the full file revision", async name => {
    const s = surface(); await s.load(file(name), 7);
    expect(s.content).toMatchObject({ kind: name.endsWith("pdf") ? "pdf" : "video", path: `/${name}`, component: expect.any(Function), key: expect.stringContaining("today|12") });
    expect(mocks.loadPreviewImage).not.toHaveBeenCalled();
    expect(mocks.getVideoThumbnailData).not.toHaveBeenCalled();
  });

  it("uses only the selected viewer factory and publishes its returned component", async () => {
    const s = surface();
    expect(s.viewers.pdf).not.toHaveBeenCalled();
    expect(s.viewers.video).not.toHaveBeenCalled();
    await s.load(file("a.pdf"));
    expect(s.viewers.pdf).toHaveBeenCalledTimes(1);
    expect(s.viewers.video).not.toHaveBeenCalled();
    expect(s.content).toMatchObject({ kind: "pdf", component: Pdf });
    await s.load(file("a.mp4"));
    expect(s.viewers.pdf).toHaveBeenCalledTimes(1);
    expect(s.viewers.video).toHaveBeenCalledTimes(1);
    expect(s.content).toMatchObject({ kind: "video", component: Video });
  });

  it.each(["pdf", "video"] as const)("reports a rejected %s viewer factory without retaining old content", async kind => {
    const s = surface();
    s.viewers[kind].mockRejectedValueOnce(new Error("viewer unavailable"));
    await s.load(file(kind === "pdf" ? "a.pdf" : "a.mp4"));
    expect(s.content).toEqual({ kind: "error", message: `Cannot preview ${kind === "pdf" ? "PDF" : "video"}: viewer unavailable` });
  });

  it("discards a lazy viewer that resolves after a different format is selected", async () => {
    const s = surface(); let resolve!: (viewer: typeof Pdf) => void;
    s.viewers.pdf.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = s.load(file("a.pdf"));
    expect(s.content).toEqual({ kind: "loading" });
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "replacement" });
    await s.load(file("a.txt"));
    resolve(Pdf); await pending;
    expect(s.content).toMatchObject({ kind: "text", text: "replacement" });
  });

  it("upgrades renditions while rejecting an upgrade superseded by a new selection", async () => {
    const s = surface(); mocks.loadPreviewImage.mockResolvedValueOnce(ready("blob:small", "rendition")).mockResolvedValueOnce(ready("blob:full"));
    await s.load(file("a.png"));
    const source = s.content;
    expect(source).toMatchObject({ rendition: expect.objectContaining({ path: "/a.png" }) });
    const upgraded = await s.loader.upgrade(source, () => true);
    expect(upgraded).toMatchObject({ kind: "image", url: "blob:full", rendition: null });
    mocks.loadPreviewImage.mockResolvedValueOnce(ready("blob:small2", "rendition"));
    await s.load(file("b.png"));
    let resolve!: (value: unknown) => void;
    mocks.loadPreviewImage.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = s.loader.upgrade(s.content, () => true);
    await s.load(file("a.exe"));
    resolve(ready("blob:stale-full"));
    expect(await pending).toBeNull();
    expect(s.content.kind).toBe("unsupported");
    expect(s.revoked).toHaveBeenCalledWith("blob:stale-full");
  });

  it("clears image holds before loading a dedicated PDF viewer", async () => {
    const s = surface(); mocks.loadPreviewImage.mockResolvedValue(ready("blob:a"));
    await s.load(file("a.png"));
    const pending = s.load(file("a.pdf"));
    expect(s.content).toEqual({ kind: "loading" });
    await pending;
    expect(s.content).toMatchObject({ kind: "pdf", path: "/a.pdf" });
  });

  it("reports failed reads as an error replacement for every non-image loader", async () => {
    const s = surface();
    mocks.readTextFile.mockResolvedValue({ ok: false, error: "text denied" });
    await s.load(file("a.txt"));
    expect(s.content).toEqual({ kind: "error", message: "text denied" });
    mocks.fetchDirectory.mockResolvedValue({ ok: false, error: "folder denied" });
    await s.load(file("folder", "directory"));
    expect(s.content).toEqual({ kind: "error", message: "folder denied" });
    mocks.listArchiveContents.mockResolvedValue({ ok: false, error: "archive denied" });
    await s.load(file("a.zip"));
    expect(s.content).toEqual({ kind: "error", message: "archive denied" });
    mocks.getVideoThumbnailData.mockResolvedValue({ ok: false, error: "no cover" });
    await s.load(file("a.mp3"));
    expect(s.content).toEqual({ kind: "error", message: "Cannot preview video" });
  });

  it("keeps malformed CSV as readable text and large text on plain text", async () => {
    const s = surface();
    mocks.readTextFile.mockResolvedValueOnce({ ok: true, data: 'a,b\n"unterminated' });
    await s.load(file("a.csv"));
    expect(s.content).toMatchObject({ kind: "text", text: expect.stringContaining("unterminated"), truncatedLabel: "lines" });
    const text = "a".repeat(50_000);
    mocks.readTextFile.mockResolvedValueOnce({ ok: true, data: text });
    await s.load(file("a.txt"));
    expect(s.content).toEqual({ kind: "text", text, truncatedLabel: "lines", truncatedLines: 0 });
  });

  it("discards and releases cover art decoded after a newer file revision", async () => {
    const s = surface(); let decoded!: () => void;
    mocks.getVideoThumbnailData.mockResolvedValue({ ok: true, data: "blob:old-cover" });
    mocks.decodeImage.mockReturnValue(new Promise<void>(resolve => { decoded = resolve; }));
    const pending = s.load(file("a.mp3"));
    // Let the old request adopt its blob and enter decoding.
    await Promise.resolve();
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "new contents" });
    await s.load(file("new.txt"));
    decoded(); await pending;
    expect(s.content.kind).toBe("text");
    if (s.content.kind === "text") expect(s.content.text).toBe("new contents");
    expect(s.revoked).toHaveBeenCalledWith("blob:old-cover");
  });

  it("reset and disposal invalidate delayed results", async () => {
    const s = surface(); let resolve!: (value: unknown) => void;
    mocks.getVideoThumbnailData.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = s.load(file("a.mp3"));
    expect(s.loader.clear()).toEqual({ kind: "empty" });
    s.loader.dispose(); resolve({ ok: true, data: "blob:late" }); await pending;
    expect(s.content.kind).toBe("loading"); // no publication after reset/disposal
    expect(s.revoked).toHaveBeenCalledWith("blob:late");
  });
});

describe("Markdown preview navigation (#1418)", () => {
  const md = (name: string, modified = "today", size = 12): FileEntry => ({ name, path: `/${name}`, kind: "file", size, modified });
  /** ~100 KB of paragraphs: more than two reveal slices. */
  const longDocument = (label: string) => Array.from({ length: 90 }, (_, i) => `${label} paragraph ${i} ${"word ".repeat(220)}`).join("\n\n");
  const readsOf = (path: string) => mocks.readTextFile.mock.calls.filter(([p]) => p === path).length;
  async function settle(frames: ReturnType<typeof manualFrames>, pending: Promise<unknown>) {
    let done = false;
    void pending.then(() => { done = true; });
    for (let i = 0; i < 100 && !done; i++) await frames.frame();
    await pending;
  }

  it("renders nothing in the selection's own task: the document appears from the next frame", async () => {
    const frames = manualFrames();
    const s = surface(undefined, frames.scheduler);
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "# Title\n\nBody" });
    const pending = s.load(md("a.md"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.content).toEqual({ kind: "loading" });
    await settle(frames, pending);
    expect(markdownHtml(s.content)).toBe(renderMarkdown("# Title\n\nBody"));
  });

  it("shows a long document a slice per frame, each slice a prefix of the whole", async () => {
    const frames = manualFrames();
    const s = surface(undefined, frames.scheduler);
    const doc = longDocument("Long");
    mocks.readTextFile.mockResolvedValue({ ok: true, data: doc });
    await settle(frames, s.load(md("long.md")));
    const whole = renderMarkdown(doc);
    const shown = s.published.map(markdownHtml).filter((html): html is string => html !== null);
    expect(shown.length).toBeGreaterThanOrEqual(3);
    for (const html of shown) expect(whole.startsWith(html)).toBe(true);
    expect(shown.at(-1)).toBe(whole);
    const partial = s.published.flatMap(content => content.kind === "markdown" ? [content.partial] : []);
    expect(partial).toEqual([...partial.slice(0, -1).map(() => true), false]);
  });

  it("fast navigation publishes only the final selection's document", async () => {
    const frames = manualFrames();
    const s = surface(undefined, frames.scheduler);
    mocks.readTextFile.mockImplementation(async (path: string) => ({ ok: true, data: `# ${path.slice(1)}\n\n$x^2$ and text` }));
    const loads = [s.load(md("a.md"))];
    await Promise.resolve();
    loads.push(s.load(md("b.md")));
    await Promise.resolve();
    loads.push(s.load(md("c.md")));
    await settle(frames, Promise.all(loads));
    const shown = s.published.map(markdownHtml).filter((html): html is string => html !== null);
    expect(shown.length).toBeGreaterThan(0);
    for (const html of shown) expect(html).toContain("c.md");
    expect(markdownHtml(s.content)).toContain("c.md");
  });

  it("abandons a document mid-reveal when the selection moves on", async () => {
    const frames = manualFrames();
    const s = surface(undefined, frames.scheduler);
    mocks.readTextFile.mockImplementation(async (path: string) => ({ ok: true, data: longDocument(path === "/old.md" ? "Old" : "New") }));
    const old = s.load(md("old.md"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await frames.frame(); // first slice of the old document is shown
    expect(markdownHtml(s.content)).toContain("Old paragraph 0");
    const before = s.published.length;
    const next = s.load(md("new.md"));
    await settle(frames, Promise.all([old, next]));
    const later = s.published.slice(before).map(markdownHtml).filter((html): html is string => html !== null);
    for (const html of later) expect(html).not.toContain("Old paragraph");
    expect(markdownHtml(s.content)).toBe(renderMarkdown(longDocument("New")));
  });

  it("going back to an unchanged document skips the read; a changed version renders again", async () => {
    const s = surface();
    mocks.readTextFile.mockImplementation(async (path: string) => ({ ok: true, data: `# ${path} v${readsOf(path)}` }));
    await s.load(md("a.md"));
    await s.load(md("b.md"));
    await s.load(md("a.md"));
    expect(readsOf("/a.md")).toBe(1);
    expect(markdownHtml(s.content)).toContain("/a.md v1");

    await s.load(md("a.md", "later"));
    expect(readsOf("/a.md")).toBe(2);
    expect(markdownHtml(s.content)).toContain("/a.md v2");
    await s.load(md("a.md", "later", 99));
    expect(readsOf("/a.md")).toBe(3);
    await s.load(md("a.md", "later", 99), 1);
    expect(readsOf("/a.md")).toBe(4);
    expect(markdownHtml(s.content)).toContain("/a.md v4");
  });

  it("an abandoned render is not remembered", async () => {
    const frames = manualFrames();
    const s = surface(undefined, frames.scheduler);
    mocks.readTextFile.mockImplementation(async (path: string) => ({ ok: true, data: longDocument(path) }));
    const old = s.load(md("old.md"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await settle(frames, Promise.all([old, s.load(md("new.md"))]));
    await settle(frames, s.load(md("old.md")));
    expect(readsOf("/old.md")).toBe(2);
    expect(markdownHtml(s.content)).toBe(renderMarkdown(longDocument("/old.md")));
  });
});
