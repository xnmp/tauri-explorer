/** File preview dispatch and per-mount resource ownership. Geometry/diffs stay in the view. */
import type { FileEntry } from "$lib/domain/file";
import { classifyPreview, shouldHoldPreviewImage, type PreviewKind } from "$lib/domain/preview-kind";
import { parseCsvPreview, type CsvPreview } from "$lib/domain/csv-preview";
import { highlightCode, hasLanguageSupport } from "$lib/domain/syntax-highlight";
import { renderMarkdownBlocks } from "$lib/domain/markdown";
import { revealProgressively, type FrameScheduler } from "$lib/domain/progressive-reveal";
import { createVersionedLru } from "$lib/domain/versioned-lru";
import { readTextFile, fetchDirectory } from "$lib/api/files";
import { listArchiveContents } from "$lib/api/archive";
import { getVideoThumbnailData } from "$lib/api/thumbnails";
import { extractError } from "$lib/api/common";
import { logFrontendDiagnostic } from "$lib/api/frontend-log";
import { decodeImage, loadPreviewImage, type PreviewImageOptions, type PreviewImageReady } from "./preview-image";
import { previewSourceSize } from "$lib/domain/preview-rendition";
import type { ImageResolution } from "$lib/domain/image-resolution";
import { createPreviewLifetime, type PreviewRequest } from "./preview-lifetime";
import { createPreviewImageCache } from "./preview-image-cache";
import { createFullResolutionUpgrade, type ShownRendition } from "./preview-resolution";

interface Truncation { readonly truncatedLines: number; readonly truncatedLabel: "lines" | "rows" }
interface Rendition extends ShownRendition { readonly request: PreviewRequest; readonly file: FileEntry }
export type ImageContent = {
  readonly kind: "image" | "audio-cover";
  readonly url: string;
  readonly sourceSize: ImageResolution | null;
  readonly note: string | null;
  readonly held: boolean;
  readonly rendition: Rendition | null;
};
type TextContent =
  | ({ readonly kind: "csv"; readonly csv: CsvPreview } & Truncation)
  /** `partial` while later blocks are still being revealed (#1418). */
  | ({ readonly kind: "markdown"; readonly blocks: readonly string[]; readonly partial: boolean } & Truncation)
  | ({ readonly kind: "code"; readonly html: string } & Truncation)
  | ({ readonly kind: "text"; readonly text: string } & Truncation);

/** Viewers are supplied by the UI layer; state does not import components. */
export interface PreviewViewers<PdfViewer, VideoViewer> {
  pdf(): Promise<PdfViewer>;
  video(): Promise<VideoViewer>;
}

export type PreviewContent<PdfViewer = unknown, VideoViewer = unknown> =
  | { readonly kind: "empty" | "loading" | "unsupported" }
  | { readonly kind: "error"; readonly message: string }
  | ImageContent
  | { readonly kind: "directory" | "zip"; readonly entries: readonly FileEntry[]; readonly collapsedRoot: string | null; readonly collapsedNote: string | null }
  | { readonly kind: "pdf"; readonly path: string; readonly key: string; readonly component: PdfViewer }
  | { readonly kind: "video"; readonly path: string; readonly name: string; readonly key: string; readonly component: VideoViewer }
  | { readonly kind: "html"; readonly document: string }
  | TextContent;

export interface PreviewContentOptions {
  readonly localRevision: number;
  readonly imageOptions: PreviewImageOptions;
}

type MarkdownContent = Extract<TextContent, { kind: "markdown" }>;

/** Rendered Markdown a pane has shown, by path and file version (#1418). */
const MARKDOWN_CACHE_LIMITS = { maxEntries: 32, maxWeight: 8_000_000 };
const markdownWeight = (content: MarkdownContent) => content.blocks.reduce((sum, block) => sum + block.length, 0);

/** Frame boundary for progressive Markdown reveal: the task after the next
 *  rendered frame. A hidden document renders no frames, so it only yields; a
 *  long safety timer bounds a visible webview that stops producing frames. */
const browserFrames: FrameScheduler = {
  now: () => performance.now(),
  nextFrame: () => new Promise(resolve => {
    let pending = true;
    const done = () => { if (pending) { pending = false; resolve(); } };
    if (typeof requestAnimationFrame !== "function" || typeof document === "undefined" || document.visibilityState === "hidden") {
      setTimeout(done, 0);
      return;
    }
    const fallback = setTimeout(done, 1000);
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(fallback); done(); }, 0));
  }),
};

function previewLines(text: string): { displayText: string } & Truncation {
  const lines = text.split("\n");
  return {
    displayText: lines.length > 200 ? lines.slice(0, 200).join("\n") : text,
    truncatedLines: lines.length > 200 ? lines.length : 0, truncatedLabel: "lines",
  };
}

function textContent(file: FileEntry, kind: PreviewKind, text: string): TextContent {
  if (kind === "csv") {
    const csv = parseCsvPreview(text);
    if (csv) return { kind: "csv", csv, truncatedLines: csv.totalRows > csv.rows.length ? csv.totalRows : 0, truncatedLabel: "rows" };
  }
  const { displayText, ...truncation } = previewLines(text);
  if (displayText.length < 50_000 && hasLanguageSupport(file.name)) {
    try { return { kind: "code", html: highlightCode(displayText, file.name), ...truncation }; }
    catch { /* Plain text remains previewable if highlighting fails. */ }
  }
  return { kind: "text", text: displayText, ...truncation };
}

export function createPreviewContentLoader<PdfViewer, VideoViewer>(
  revokeObjectUrl: (url: string) => void,
  viewers: PreviewViewers<PdfViewer, VideoViewer>,
  frames: FrameScheduler = browserFrames,
) {
  type Content = PreviewContent<PdfViewer, VideoViewer>;
  const lifetime = createPreviewLifetime(revokeObjectUrl);
  const cache = createPreviewImageCache(revokeObjectUrl);
  const markdownCache = createVersionedLru<MarkdownContent>(MARKDOWN_CACHE_LIMITS, markdownWeight);
  const textVersion = (file: FileEntry, options: PreviewContentOptions) => `${file.modified}|${file.size}|${options.localRevision}`;

  /**
   * Markdown is typeset and shown a slice per frame, starting the frame after
   * the selection, and abandoned as soon as another selection replaces it
   * (#1418). Falls back to highlighted/plain text when rendering fails.
   */
  async function markdownContent(file: FileEntry, text: string, request: PreviewRequest, options: PreviewContentOptions, publish: (content: Content) => void): Promise<Content | null> {
    const { displayText, ...truncation } = previewLines(text);
    if (displayText.length >= 200_000) return textContent(file, "markdown", text);
    try {
      const rendered = await renderMarkdownBlocks(displayText);
      const blocks = await revealProgressively(
        rendered.blocks,
        () => lifetime.isCurrent(request),
        shown => publish({ kind: "markdown", blocks: shown, partial: true, ...truncation }),
        frames,
      );
      if (!blocks) return null;
      const content: MarkdownContent = { kind: "markdown", blocks, partial: false, ...truncation };
      // A render without KaTeX (chunk load failed) is retried on the next visit.
      if (!rendered.degraded) markdownCache.set(file.path, textVersion(file, options), content);
      return content;
    } catch {
      if (!lifetime.isCurrent(request)) return null;
      return textContent(file, "markdown", text);
    }
  }
  const fullResolution = createFullResolutionUpgrade(async (path, bust, owner) => {
    const image = cache.lookup(path, bust, {}) ?? await loadPreviewImage(path, bust, owner);
    if (image.status === "ready" && !owner.isCurrent()) {
      owner.adoptBlob(image.url);
      return { status: "stale" };
    }
    return image;
  });

  const imageOwner = (request: PreviewRequest) => ({
    isCurrent: () => lifetime.isCurrent(request),
    adoptBlob: (url: string) => lifetime.adoptBlob(request, url),
    releaseBlob: (url: string) => lifetime.releaseBlob(request, url),
  });
  function imageContent(request: PreviewRequest, file: FileEntry, bust: string, image: PreviewImageReady): ImageContent {
    const rendition: Rendition | null = image.resolution === "rendition"
      ? { path: file.path, cacheBust: bust, owner: imageOwner(request), request, file } : null;
    fullResolution.showing(rendition);
    return { kind: "image", url: image.url, held: false, rendition,
      sourceSize: previewSourceSize(image.resolution, image.sourceSize ?? null, { width: image.decoded.naturalWidth, height: image.decoded.naturalHeight }),
      note: image.viaBackend && /\.avif$/i.test(file.name) ? "AVIF fallback preview shows the first frame." : null };
  }
  function remember(request: PreviewRequest, file: FileEntry, bust: string, options: PreviewImageOptions, image: PreviewImageReady): ImageContent | null {
    // The real image loader already guards ownership; retain the guard here at
    // the cache-publication boundary too (including full-resolution upgrades).
    if (!lifetime.isCurrent(request)) {
      lifetime.adoptBlob(request, image.url);
      return null;
    }
    lifetime.disownBlob(request, image.url);
    cache.store(file.path, bust, options, image);
    lifetime.clearBlob();
    return imageContent(request, file, bust, image);
  }

  async function showRemembered(content: MarkdownContent, request: PreviewRequest, publish: (content: Content) => void): Promise<Content | null> {
    const shown = await revealProgressively(content.blocks, () => lifetime.isCurrent(request),
      blocks => publish({ ...content, blocks, partial: true }), frames);
    return shown && content;
  }

  async function loadKind(file: FileEntry, kind: PreviewKind, request: PreviewRequest, options: PreviewContentOptions, publish: (content: Content) => void): Promise<Content | null> {
    switch (kind) {
      case "directory": {
        let path = file.path;
        const chain: string[] = [];
        // Bound single-folder descent, including symlink cycles.
        for (let depth = 0; depth < 40; depth++) {
          const result = await fetchDirectory(path);
          if (!lifetime.isCurrent(request)) return null;
          if (!result.ok) return { kind: "error", message: result.error };
          const entries = result.data.entries;
          if (entries.length === 1 && entries[0].kind === "directory") {
            chain.push(entries[0].name); path = entries[0].path;
          } else {
            return { kind, entries, collapsedRoot: chain.length ? chain.join("/") : null,
              collapsedNote: chain.length ? (chain.length === 1 ? "single subfolder" : "single-folder chain") : null };
          }
        }
        return { kind, entries: [], collapsedRoot: null, collapsedNote: null };
      }
      case "zip": {
        const result = await listArchiveContents(file.path);
        if (!result.ok) return { kind: "error", message: result.error };
        return { kind, entries: result.data.entries, collapsedRoot: result.data.rootFolder ?? null,
          collapsedNote: result.data.rootFolder ? "single top-level folder" : null };
      }
      case "pdf":
        try {
          const component = await viewers.pdf();
          return { kind, path: file.path, key: request.key, component };
        } catch (error) { return { kind: "error", message: `Cannot preview PDF: ${error instanceof Error ? error.message : String(error)}` }; }
      case "video":
        try {
          const component = await viewers.video();
          return { kind, path: file.path, name: file.name, key: `${request.key}|${options.localRevision}`, component };
        } catch (error) { return { kind: "error", message: `Cannot preview video: ${extractError(error)}` }; }
      case "image": {
        const bust = `${file.modified}-${file.size}-${options.localRevision}`;
        const image = await loadPreviewImage(file.path, bust, imageOwner(request), options.imageOptions);
        if (image.status === "stale") return null;
        if (image.status === "failed") return { kind: "error", message: "Cannot preview image" };
        return remember(request, file, bust, options.imageOptions, image);
      }
      case "audio-cover": {
        const result = await getVideoThumbnailData(file.path, 1024);
        if (!result.ok) {
          if (!lifetime.isCurrent(request)) return null;
          logFrontendDiagnostic("preview video frame extraction failed", { path: file.path, error: result.error });
          return { kind: "error", message: "Cannot preview video" };
        }
        if (!lifetime.adoptBlob(request, result.data)) return null;
        try {
          await decodeImage(result.data);
          return { kind, url: result.data, sourceSize: null, note: null, held: false, rendition: null };
        } catch (error) {
          if (!lifetime.isCurrent(request)) return null;
          lifetime.releaseBlob(request, result.data);
          logFrontendDiagnostic("preview video frame decode failed", { path: file.path, error: extractError(error) });
          return { kind: "error", message: "Cannot preview video" };
        }
      }
      case "html": case "csv": case "markdown": case "code": case "text": {
        const result = await readTextFile(file.path, 524288);
        if (!lifetime.isCurrent(request)) return null;
        if (!result.ok) return { kind: "error", message: result.error };
        // HTML is already bounded by the reader. Do not truncate its structure
        // at the source-preview line limit or syntax-highlight it on the UI thread.
        if (kind === "html") return { kind, document: result.data };
        return kind === "markdown" ? markdownContent(file, result.data, request, options, publish) : textContent(file, kind, result.data);
      }
      case "unsupported": return { kind };
    }
  }

  return {
    /** Publishes replacements atomically; obsolete requests never publish. Cache hits are synchronous. */
    async load(file: FileEntry, previous: Content, options: PreviewContentOptions, publish: (content: Content) => void): Promise<void> {
      const request = lifetime.begin(`${file.path}|${file.modified}|${file.size}`);
      const kind = classifyPreview(file);
      fullResolution.showing(null);
      const image = previous.kind === "image" || previous.kind === "audio-cover" ? previous : null;
      const hold = image && shouldHoldPreviewImage(image.kind, kind);
      if (!hold) lifetime.clearBlob();
      if (kind === "image") {
        const bust = `${file.modified}-${file.size}-${options.localRevision}`;
        const cached = cache.lookup(file.path, bust, options.imageOptions);
        if (cached) {
          lifetime.clearBlob();
          publish(imageContent(request, file, bust, cached));
          return;
        }
      }
      publish(hold ? { ...image, held: true, note: null, rendition: null } : { kind: "loading" });
      // A remembered document skips the read and typesetting, but is still
      // shown progressively: its layout is the larger cost (#1418).
      const remembered = kind === "markdown" ? markdownCache.get(file.path, textVersion(file, options)) : undefined;
      const content = remembered
        ? await showRemembered(remembered, request, publish)
        : await loadKind(file, kind, request, options, publish);
      if (!content || !lifetime.isCurrent(request)) return;
      if (content.kind === "error") lifetime.clearBlob();
      publish(content);
    },
    async upgrade(content: Content, wanted: () => boolean): Promise<Content | null> {
      if (content.kind !== "image" || !content.rendition) return null;
      const source = content.rendition;
      const image = await fullResolution.upgrade(wanted);
      if (!image) return null;
      return remember(source.request, source.file, source.cacheBust, {}, image);
    },
    clear(): Content {
      lifetime.invalidate(); lifetime.clearBlob(); fullResolution.showing(null);
      return { kind: "empty" };
    },
    dispose(): void { lifetime.dispose(); cache.clear(); markdownCache.clear(); fullResolution.showing(null); },
  };
}
