/** File preview dispatch and per-mount resource ownership. Geometry/diffs stay in the view. */
import type { FileEntry } from "$lib/domain/file";
import { classifyPreview, shouldHoldPreviewImage, type PreviewKind } from "$lib/domain/preview-kind";
import { parseCsvPreview, type CsvPreview } from "$lib/domain/csv-preview";
import { highlightCode, hasLanguageSupport } from "$lib/domain/syntax-highlight";
import { renderMarkdown } from "$lib/domain/markdown";
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
  | ({ readonly kind: "markdown" | "code"; readonly html: string } & Truncation)
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
  | TextContent;

export interface PreviewContentOptions {
  readonly localRevision: number;
  readonly imageOptions: PreviewImageOptions;
}

function textContent(file: FileEntry, kind: PreviewKind, text: string): TextContent {
  if (kind === "csv") {
    const csv = parseCsvPreview(text);
    if (csv) return { kind: "csv", csv, truncatedLines: csv.totalRows > csv.rows.length ? csv.totalRows : 0, truncatedLabel: "rows" };
  }
  const lines = text.split("\n");
  const displayText = lines.length > 200 ? lines.slice(0, 200).join("\n") : text;
  const truncation = { truncatedLines: lines.length > 200 ? lines.length : 0, truncatedLabel: "lines" as const };
  if (kind === "markdown" && displayText.length < 200_000) {
    try { return { kind: "markdown", html: renderMarkdown(displayText), ...truncation }; }
    catch { /* Keep the existing highlighted/plain-text fallback. */ }
  }
  if (displayText.length < 50_000 && hasLanguageSupport(file.name)) {
    try { return { kind: "code", html: highlightCode(displayText, file.name), ...truncation }; }
    catch { /* Plain text remains previewable if highlighting fails. */ }
  }
  return { kind: "text", text: displayText, ...truncation };
}

export function createPreviewContentLoader<PdfViewer, VideoViewer>(
  revokeObjectUrl: (url: string) => void,
  viewers: PreviewViewers<PdfViewer, VideoViewer>,
) {
  type Content = PreviewContent<PdfViewer, VideoViewer>;
  const lifetime = createPreviewLifetime(revokeObjectUrl);
  const cache = createPreviewImageCache(revokeObjectUrl);
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

  async function loadKind(file: FileEntry, kind: PreviewKind, request: PreviewRequest, options: PreviewContentOptions): Promise<Content | null> {
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
      case "csv": case "markdown": case "code": case "text": {
        const result = await readTextFile(file.path, 524288);
        if (!lifetime.isCurrent(request)) return null;
        return result.ok ? textContent(file, kind, result.data) : { kind: "error", message: result.error };
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
      const content = await loadKind(file, kind, request, options);
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
    dispose(): void { lifetime.dispose(); cache.clear(); fullResolution.showing(null); },
  };
}
