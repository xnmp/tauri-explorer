/**
 * Media bytes for a mock fixture world: fetches a fixture's image/poster/PDF
 * URLs and answers as the native backend does, with data URIs (thumbnails
 * scaled to the requested edge, previews at full size) or raw bytes.
 * A successful fetch is reused for every later request; a failed one is
 * forgotten, so a transient network error does not break the asset for good.
 */

export interface MockMediaLoader {
  /** JPEG data URI no larger than `size` on its longer edge. */
  thumbnail(src: string, size: number, quality: number): Promise<string>;
  /** The original bytes as a data URI. */
  dataUrl(src: string): Promise<string>;
  bytes(src: string): Promise<ArrayBuffer>;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read media"));
    reader.readAsDataURL(blob);
  });
}

export function createMockMediaLoader(fetcher: typeof fetch = (input, init) => fetch(input, init)): MockMediaLoader {
  const blobs = new Map<string, Promise<Blob>>();
  const thumbs = new Map<string, Promise<string>>();

  function blob(src: string): Promise<Blob> {
    let pending = blobs.get(src);
    if (!pending) {
      pending = fetcher(src).then((response) => {
        if (!response.ok) throw { kind: "not_found", message: `${src}: HTTP ${response.status}` };
        return response.blob();
      });
      blobs.set(src, pending);
      pending.catch(() => { if (blobs.get(src) === pending) blobs.delete(src); });
    }
    return pending;
  }

  async function scale(src: string, size: number, quality: number): Promise<string> {
    const source = await blob(src);
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return readAsDataUrl(source);
    const bitmap = await createImageBitmap(source);
    try {
      const ratio = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const uri = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.1, quality / 100)));
      return uri && uri !== "data:," ? uri : readAsDataUrl(source);
    } finally {
      bitmap.close();
    }
  }

  return {
    thumbnail(src, size, quality) {
      const edge = Math.max(8, Math.min(4096, Math.round(size) || 128));
      const key = `${src}\n${edge}`;
      let pending = thumbs.get(key);
      if (!pending) {
        const scaling = scale(src, edge, quality);
        thumbs.set(key, scaling);
        scaling.catch(() => { if (thumbs.get(key) === scaling) thumbs.delete(key); });
        pending = scaling;
      }
      return pending;
    },
    dataUrl: async (src) => readAsDataUrl(await blob(src)),
    bytes: async (src) => (await blob(src)).arrayBuffer(),
  };
}
