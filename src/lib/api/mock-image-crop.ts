/** Browser interaction fixtures. Native format/recovery correctness is tested
 * separately against Rust and real files; this implements PNG/JPEG UI outcomes. */
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";
import { basename, parentDir } from "$lib/domain/path";
import { validImageCrop } from "$lib/domain/image-crop";
import type { ImageCropCapture, ImageCropSave } from "./image-crop";

export function createMockImageCrop(files: Record<string, FileEntry[]>, timestamp: () => string) {
  const images = new Map<string, string>();
  const entry = (path: string) => (files[parentDir(path)] ?? []).find((item) => item.path === path);
  const format = (path: string) => /\.png$/i.test(path) ? "PNG" : /\.jpe?g$/i.test(path) ? "JPEG" : null;
  function source(path: string): string {
    const previous = images.get(path);
    if (previous) return previous;
    if (!entry(path)) throw new Error("Image not found");
    const type = format(path);
    if (!type) throw new Error("Browser crop fixtures support PNG and JPEG; native codecs cover the remaining formats");
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 384;
    const context = canvas.getContext("2d")!;
    for (const [color, x, y] of [["#e74c3c", 0, 0], ["#2ecc71", 256, 0], ["#3498db", 0, 192], ["#f1c40f", 256, 192]] as const) {
      context.fillStyle = color; context.fillRect(x, y, 256, 192);
    }
    context.clearRect(208, 152, 96, 80);
    context.strokeStyle = "#ffffff"; context.lineWidth = 4;
    context.strokeRect(32, 24, 448, 336);
    const dataUrl = canvas.toDataURL(type === "PNG" ? "image/png" : "image/jpeg", 0.95);
    images.set(path, dataUrl);
    return dataUrl;
  }
  async function capture(path: string): Promise<ImageCropCapture> {
    const original = entry(path);
    if (!original) throw new Error("Image not found");
    const dataUrl = source(path);
    const modified = new Date(original.modified).getTime();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataUrl)));
    return { path, dataUrl, format: format(path)!, revision: {
      digest: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""), size: original.size,
      modifiedSeconds: Math.floor(modified / 1000), modifiedNanos: modified % 1000 * 1_000_000,
      identity: path, readonly: false,
    } };
  }
  async function save(request: ImageCropSave): Promise<FileMutationReceipt> {
    const current = await capture(request.path);
    if (JSON.stringify(current.revision) !== JSON.stringify(request.revision)) throw new Error("The original image changed. Close the crop editor and open it again.");
    if (!validImageCrop(request.rect, request.viewport)) throw new Error("Choose a nonempty crop inside the image");
    const name = request.destination.kind === "replace" ? basename(request.path) : request.destination.name;
    if (!name || /[/\\]/.test(name) || name === "." || name === ".." || format(name) !== current.format) throw new Error("Keep a valid separate filename and the original image extension");
    const target = `${parentDir(request.path)}/${name}`;
    if (request.destination.kind === "copy" && entry(target)) throw new Error("Copy already exists; choose a different filename");
    const image = new Image(); image.src = current.dataUrl; await image.decode();
    if (image.naturalWidth !== request.viewport.width || image.naturalHeight !== request.viewport.height) throw new Error("Image dimensions changed");
    const canvas = document.createElement("canvas");
    canvas.width = request.rect.right - request.rect.left; canvas.height = request.rect.bottom - request.rect.top;
    canvas.getContext("2d")!.drawImage(image, request.rect.left, request.rect.top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const saved = canvas.toDataURL(current.format === "PNG" ? "image/png" : "image/jpeg", 0.95);
    const original = entry(request.path)!;
    const result: FileEntry = { ...original, path: target, name, size: atob(saved.split(",")[1]).length, modified: timestamp() };
    images.set(target, saved);
    const listing = files[parentDir(target)];
    const index = listing.findIndex((item) => item.path === target);
    if (index >= 0) listing[index] = result; else listing.push(result);
    return { path: target, entry: result };
  }
  return { capture, save, read: (path: string) => images.get(path) };
}
