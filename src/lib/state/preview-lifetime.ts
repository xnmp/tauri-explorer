/** Owns the revision and blob resources for one mounted preview surface. */
export interface PreviewRequest {
  readonly revision: number;
  readonly key: string;
}

export function createPreviewLifetime(revokeObjectUrl: (url: string) => void) {
  let revision = 0;
  let disposed = false;
  let ownedBlobUrl: string | null = null;

  const revoke = (url: string | null): void => {
    if (url?.startsWith("blob:")) revokeObjectUrl(url);
  };

  return {
    begin(key: string): PreviewRequest {
      return { revision: ++revision, key };
    },
    isCurrent(request: PreviewRequest): boolean {
      return !disposed && request.revision === revision;
    },
    /** Adopt a blob returned by async work, or release it immediately if stale. */
    adoptBlob(request: PreviewRequest, url: string): boolean {
      if (!url.startsWith("blob:")) return !disposed && request.revision === revision;
      if (disposed || request.revision !== revision) {
        // Providers may reuse a blob URL across requests. A stale completion
        // must never revoke the URL already adopted by the current owner.
        if (ownedBlobUrl !== url) revoke(url);
        return false;
      }
      if (ownedBlobUrl !== url) revoke(ownedBlobUrl);
      ownedBlobUrl = url;
      return true;
    },
    /** Release one returned blob without disturbing a newer request's blob. */
    releaseBlob(request: PreviewRequest, url: string): void {
      if (!url.startsWith("blob:")) return;
      if (request.revision !== revision && ownedBlobUrl === url) return;
      if (request.revision === revision && ownedBlobUrl === url) ownedBlobUrl = null;
      revoke(url);
    },
    clearBlob(): void {
      revoke(ownedBlobUrl);
      ownedBlobUrl = null;
    },
    invalidate(): void {
      revision++;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      revision++;
      revoke(ownedBlobUrl);
      ownedBlobUrl = null;
    },
  };
}
