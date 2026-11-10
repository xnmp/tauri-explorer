/**
 * Mock preview and media commands: thumbnails, image/PDF/video previews, image crop, folder
 * previews and media metadata.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import { selectPreviewImages } from "$lib/domain/folder-preview";
import { parentDir } from "$lib/domain/path";
import pdfFixtureUrl from "./fixtures/preview-landmarks.pdf?url";
import videoFixtureUrl from "./fixtures/video-preview.webm?url";
import type { ImageCropSave } from "./image-crop";
import { getMockControl } from "./mock-control";
import { mockFiles, nextTimestamp } from "./mock-fixtures";
import { createMockImageCrop } from "./mock-image-crop";
import { invokeMockCommand, type CommandHandler } from "./mock-dispatch";

const mockVideoCapabilities = new Set<string>();
const mockImageCrop = createMockImageCrop(mockFiles, nextTimestamp);


const MOCK_MEDIA_DURATIONS: Record<string, number> = {
  "/home/user/Videos/recording.mp4": 754.4,
  "/home/user/Videos/tutorial.mkv": 3725.2,
};

if (typeof window !== "undefined") {
  const control = getMockControl();
  control.previewRevision = (path) => {
    const parent = parentDir(path);
    const entries = mockFiles[parent];
    const current = entries?.find((entry) => entry.path === path);
    if (!entries || !current) return;
    mockFiles[parent] = entries.map((entry) =>
      entry === current
        ? { ...entry, modified: new Date(Date.parse(entry.modified) + 1000).toISOString(), size: entry.size + 1 }
        : entry,
    );
  };
  control.videoRevision = () => {
    const videos = mockFiles["/home/user/Videos"];
    const recording = videos.find((entry) => entry.path.endsWith("recording.mp4"));
    if (!recording) return;
    mockFiles["/home/user/Videos"] = videos.map((entry) =>
      entry === recording
        ? { ...entry, modified: new Date(Date.parse(entry.modified) + 1000).toISOString(), size: entry.size + 1 }
        : entry,
    );
  };
}

// Realistic per-path mock thumbnails (#593). A single hardcoded JPEG for
// every request let the browser satisfy N tiles from ONE cached decoded
// bitmap — real scroll jank only appears when N tiles each decode a DISTINCT
// image, so that mock was structurally blind to the regression it should
// have caught. Render a small deterministic canvas keyed by (path, size):
// color + shapes derived from a hash of the path, so directories serve
// visibly and byte-wise distinct images. Cached per key so repeated requests
// (micro pre-warm, re-render, remount) don't regenerate. Falls back to the
// static JPEGs at the call sites when canvas is unavailable (e.g. some test
// environments lack a working 2D canvas / toDataURL).
const mockThumbnailCache = new Map<string, string>();
function hashPath(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function generateMockThumbnail(path: string, size: number, quality: number): string | null {
  const key = `${path}:${size}`;
  const cached = mockThumbnailCache.get(key);
  if (cached) return cached;
  try {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const h = hashPath(path);
    const hue = h % 360;
    const hue2 = (h >>> 8) % 360;
    ctx.fillStyle = `hsl(${hue}, 55%, 45%)`;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = `hsl(${hue2}, 65%, 65%)`;
    const shape = size * 0.4;
    ctx.beginPath();
    ctx.arc(size * 0.3, size * 0.3, shape / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 50%, 30%)`;
    ctx.fillRect(size * 0.5, size * 0.5, shape, shape);
    const dataUri = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.1, quality / 100)));
    // A canvas that fails to implement toDataURL (some headless shells)
    // returns "data:," — treat that as unavailable rather than caching junk.
    if (!dataUri || dataUri === "data:,") return null;
    mockThumbnailCache.set(key, dataUri);
    return dataUri;
  } catch {
    return null;
  }
}

export const previewCommands: Record<string, CommandHandler> = {

  // Details Length column (#995): fixed durations so views render stable text;
  // `unreadable.avi` models a video whose container metadata cannot be read.
  get_media_durations: (args) =>
    (args.paths as string[]).map((path) => MOCK_MEDIA_DURATIONS[path] ?? null),

  // Source header fixture is intentionally independent of thumbnail dimensions.
  get_image_resolution: (args) => getMockControl().imageResolution
    ? getMockControl().imageResolution!(String(args.path))
    : /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(args.path))
    ? { width: 1920, height: 1080 } : null,

  get_thumbnail: () => {
    throw new Error("Thumbnails not available in mock mode");
  },

  get_thumbnail_data: (args) => {
    const cropped = mockImageCrop.read((args.path as string) ?? "");
    if (cropped) return cropped;
    // #593 regression guard: a single hardcoded JPEG for every path let the
    // browser satisfy N tiles from ONE cached decoded bitmap, hiding scroll
    // jank that only appears when N distinct images must each be decoded.
    // Render a per-path canvas instead; fall back to the static JPEG below
    // when canvas is unavailable.
    const path = (args.path as string) ?? "";
    const size = (args.size as number) ?? 128;
    const quality = (args.quality as number) ?? 90;
    return (
      generateMockThumbnail(path, size, quality) ??
      // Real 128px thumbnail from beautiful.jpg — fallback when canvas is unavailable.
      "data:image/jpeg;base64,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"
    );
  },

  get_micro_thumbnail: (args) => {
    const path = (args.path as string) ?? "";
    const hook = getMockControl().microThumbnail;
    if (hook) {
      return hook(
        path,
        args.prewarmSize as number | undefined,
        args.prewarmQuality as number | undefined,
      );
    }
    const cropped = mockImageCrop.read(path);
    if (cropped) return cropped;
    const size = (args.prewarmSize as number) ?? 16;
    const quality = (args.prewarmQuality as number) ?? 50;
    return (
      generateMockThumbnail(path, size, quality) ??
      // Real 16px micro thumbnail — fallback when canvas is unavailable.
      "data:image/jpeg;base64,/9j//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABiAAEBAQAAAAAAAAAAAAAAAAAGAwUBAQAAAAAAAAAAAAAAAAAAAAQQAAIBAwQCAwEAAAAAAAAAAAECAxESACExIgRxYRNBUTIRAQACAwEBAAAAAAAAAAAAAAEhADFBAoED/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjOYesy3q4rUW2Vq3o4en70YNEis21Ycq+M3WvdI7ecjm0En+PwA/VddsDTjrpGx+UO9RooLbb8mpp4GN4UJZKn6Zjfl//9k="
    );
  },

  read_pdf_bytes: async (args) => {
    const hook = getMockControl().previewReadPdf;
    if (hook) return hook(String(args.path));
    const response = await fetch(pdfFixtureUrl);
    if (!response.ok) throw new Error(`PDF fixture transport failed: ${response.status}`);
    return response.arrayBuffer();
  },
  begin_video_preview: () => {
    const token = crypto.randomUUID();
    mockVideoCapabilities.add(token);
    return token;
  },
  prepare_video_preview: async (args) => {
    const token = String(args.token);
    if (!mockVideoCapabilities.has(token)) throw new Error("Video preview was released");
    const url = await (getMockControl().videoPreview?.(String(args.path)) ?? videoFixtureUrl);
    if (!mockVideoCapabilities.has(token)) throw new Error("Video preview was released");
    return url;
  },
  prepare_video_audio_preview: async (args) => {
    const token = String(args.token);
    if (!mockVideoCapabilities.has(token)) throw new Error("Video preview was released");
    const url = await (getMockControl().videoAudioPreview?.(String(args.path)) ?? null);
    if (!mockVideoCapabilities.has(token)) throw new Error("Video preview was released");
    if (url === null) mockVideoCapabilities.delete(token);
    return url;
  },
  release_video_preview: (args) => {
    const token = String(args.token);
    if (mockVideoCapabilities.delete(token)) (getMockControl().releasedVideoPreviews ??= []).push(token);
  },
  open_pdf_link: (args) => { getMockControl().openedPdfUrl = String(args.url); },

  get_preview_image: (args) => {
    // Browser/E2E mode has no rendition generator; every image is shown as
    // its own original (through `read_image_data_url`) unless a test says so.
    const hook = getMockControl().previewImageSource;
    if (hook) return hook((args.path as string) ?? "", Number(args.maxEdge));
    return { kind: "original" };
  },

  read_image_data_url: (args) => {
    const hook = getMockControl().previewReadImage;
    if (hook) return hook((args.path as string) ?? "");
    const cropped = mockImageCrop.read((args.path as string) ?? "");
    if (cropped) return cropped;
    // Full-size preview in browser/E2E mode: reuse the realistic thumbnail
    // JPEG so the preview pane (and its fullscreen mode) can be exercised.
    return invokeMockCommand<string>("get_thumbnail_data");
  },

  capture_image_crop: (args) => getMockControl().imageCropCapture?.(args.path as string) ?? mockImageCrop.capture(args.path as string),
  save_image_crop: (args) => getMockControl().imageCropSave?.(args.request as ImageCropSave) ?? mockImageCrop.save(args.request as ImageCropSave),

  get_video_thumbnail_data: (args) => {
    const videoThumbnailMock = getMockControl().videoThumbnail;
    if (videoThumbnailMock) {
      return videoThumbnailMock((args.path as string) ?? "", args.size as number | undefined);
    }
    // Same realistic 128px thumbnail as images — stands in for an extracted
    // video frame so the tiles view can be demoed in browser/E2E mode.
    return invokeMockCommand<string>("get_thumbnail_data");
  },

  get_folder_preview: (args) => {
    // Runs the real domain selection over the mock listing, so browser E2E
    // exercises the actual rules (image filter, hidden skip, sort, cap).
    const path = args.path as string;
    const entries = mockFiles[path];
    if (!entries) throw new Error(`Not a directory: ${path}`);
    const names = entries.filter((e) => e.kind === "file").map((e) => e.name);
    const selected = new Set(selectPreviewImages(names));
    const image_paths = entries.filter((e) => selected.has(e.name)).map((e) => e.path);
    return {
      folder_path: path,
      image_paths,
      fingerprint: `mock:${image_paths.join("|")}`,
    };
  },

  clear_thumbnail_cache: () => 0,

  get_thumbnail_cache_stats: () => ({
    count: 0,
    totalSize: 0,
    path: "/tmp/thumbnails",
  }),
  probe_video_codec: (args) => getMockControl().videoCodecProbe?.(String(args.path)) ?? ({ container: null, videoCodec: null, audioCodec: null }),
  // Theme from Image (#203): deterministic palette; theme CSS goes into the
  // in-memory config store and is injected by the mocked list_user_themes.
  extract_palette: () => ["#1a2233", "#5de5d5", "#31425c", "#d98500", "#88a0c8", "#223044"],
};
