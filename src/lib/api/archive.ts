/**
 * API client for ZIP archive compression, extraction, and preview listing.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import type { FileEntry } from "$lib/domain/file";
import { invoke, extractError, virtualPathGuard, type ApiResult } from "./common";

/** Payload of `zip-progress` events emitted while a compression job runs. */
export interface ZipProgressEvent {
  jobId: number;
  bytesDone: number;
  bytesTotal: number;
  currentFile: string;
}

/**
 * Compress files/directories into a ZIP archive.
 *
 * @param paths - List of file/directory paths to compress
 * @param jobId - Client-generated id keying `zip-progress` events and
 *                cancellation via cancelCompress
 * @returns Result with path to created ZIP file or error
 */
export async function compressToZip(paths: string[], jobId?: number): Promise<ApiResult<string>> {
  const guard = virtualPathGuard(...paths);
  if (guard) return guard;
  try {
    const zipPath = await invoke<string>("compress_to_zip", { paths, jobId });
    return { ok: true, data: zipPath };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Cancel a running compression job. The pending compressToZip call fails
 *  with "Compression cancelled" and the partial archive is removed. */
export async function cancelCompress(jobId: number): Promise<void> {
  try {
    await invoke("cancel_compress", { jobId });
  } catch {
    // Cancellation is best-effort; the job may already have finished.
  }
}

/**
 * Extract a ZIP archive.
 *
 * @param archivePath - Path to the archive file
 * @param extractHere - If true, extract to archive's directory; if false, extract to new folder
 * @param jobId - Client-generated id keying `unzip-progress` events and
 *                cancellation via cancelExtract
 * @returns Result with extraction destination path or error
 */
export async function extractArchive(
  archivePath: string,
  extractHere: boolean = false,
  jobId?: number,
): Promise<ApiResult<string>> {
  const guard = virtualPathGuard(archivePath);
  if (guard) return guard;
  try {
    const destPath = await invoke<string>("extract_archive", { archivePath, extractHere, jobId });
    return { ok: true, data: destPath };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Preview listing of a ZIP archive. `rootFolder` is set when the archive's
 *  sole top-level item is a directory we descended into — its name, for a
 *  "contains one folder: X" indicator. */
export interface ArchiveListing {
  entries: FileEntry[];
  rootFolder: string | null;
}

/**
 * List the contents of a ZIP archive (one level deep), for the preview pane.
 * Returns FileEntry rows with synthetic `archive.zip!/name` paths,
 * directories first. If the only top-level item is a folder, descends into
 * it and reports its name as `rootFolder`.
 */
export async function listArchiveContents(archivePath: string): Promise<ApiResult<ArchiveListing>> {
  try {
    const listing = await invoke<ArchiveListing>("list_archive_contents", { archivePath });
    return { ok: true, data: listing };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/** Cancel a running extraction job. The pending extractArchive call fails
 *  with "Extraction cancelled" and the partial output is removed. */
export async function cancelExtract(jobId: number): Promise<void> {
  try {
    await invoke("cancel_extract", { jobId });
  } catch {
    // Cancellation is best-effort; the job may already have finished.
  }
}
