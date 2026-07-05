/**
 * Zip compression progress flow (pane-mutations.compressToZip):
 * progress events drive the operations store, completion/cancellation/error
 * all settle the operation — observable via operationsManager state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

let zipEventHandler: ((event: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (event: { payload: unknown }) => void) => {
    zipEventHandler = cb;
    return () => {
      zipEventHandler = null;
    };
  }),
}));

type CompressResult = { ok: true; data: string } | { ok: false; error: string };

const apiMocks = vi.hoisted(() => {
  const state = {
    resolveCompress: null as ((r: CompressResult) => void) | null,
    resolveExtract: null as ((r: CompressResult) => void) | null,
    capturedJobId: undefined as number | undefined,
    capturedExtractJobId: undefined as number | undefined,
  };
  return {
    state,
    cancelCompress: vi.fn(async () => {}),
    cancelExtract: vi.fn(async () => {}),
    compressToZip: vi.fn((_paths: string[], jobId?: number) => {
      state.capturedJobId = jobId;
      return new Promise<CompressResult>((resolve) => {
        state.resolveCompress = resolve;
      });
    }),
    extractArchive: vi.fn((_path: string, _here?: boolean, jobId?: number) => {
      state.capturedExtractJobId = jobId;
      return new Promise<CompressResult>((resolve) => {
        state.resolveExtract = resolve;
      });
    }),
  };
});

vi.mock(import("../../src/lib/api/files"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    compressToZip: apiMocks.compressToZip,
    cancelCompress: apiMocks.cancelCompress,
    extractArchive: apiMocks.extractArchive,
    cancelExtract: apiMocks.cancelExtract,
  };
});

vi.mock("../../src/lib/state/file-events", () => ({ broadcastFileChange: vi.fn() }));

import { createPaneMutations } from "../../src/lib/state/pane-mutations";
import { operationsManager } from "../../src/lib/state/operations.svelte";
import type { ExplorerCoreState } from "../../src/lib/state/types";

function makeMutations() {
  const coreState = { currentPath: "/home/user" } as ExplorerCoreState;
  return createPaneMutations({
    coreState,
    setSelection: vi.fn(),
    displayEntries: () => [],
    markLocalMutation: vi.fn(),
    getParentPath: () => "/home",
    navigateTo: vi.fn(async () => {}),
    refreshSilent: vi.fn(),
  });
}

function compressOp() {
  return operationsManager.operations.find((op) => op.type === "compress");
}

beforeEach(() => {
  zipEventHandler = null;
  apiMocks.state.resolveCompress = null;
  apiMocks.state.resolveExtract = null;
  apiMocks.state.capturedJobId = undefined;
  apiMocks.state.capturedExtractJobId = undefined;
  apiMocks.cancelCompress.mockClear();
  apiMocks.cancelExtract.mockClear();
});

afterEach(() => {
  for (const op of [...operationsManager.operations]) {
    operationsManager.clearOperation(op.id);
  }
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("compressToZip progress", () => {
  it("tracks streamed byte progress and completes the operation", async () => {
    const mutations = makeMutations();
    const done = mutations.compressToZip(["/home/user/big-folder"]);

    await vi.waitFor(() => expect(zipEventHandler).not.toBeNull());
    expect(apiMocks.state.capturedJobId).toBeTypeOf("number");

    const op = compressOp();
    expect(op).toBeDefined();
    expect(op!.status).toBe("running");
    expect(op!.fileName).toBe("big-folder");

    zipEventHandler!({
      payload: { jobId: apiMocks.state.capturedJobId, bytesDone: 250, bytesTotal: 1000, currentFile: "a" },
    });
    expect(compressOp()!.progress).toBe(25);
    expect(compressOp()!.bytesProcessed).toBe(250);
    expect(compressOp()!.totalBytes).toBe(1000);

    // Events for other jobs are ignored.
    zipEventHandler!({
      payload: { jobId: (apiMocks.state.capturedJobId as number) + 1, bytesDone: 999, bytesTotal: 1000, currentFile: "x" },
    });
    expect(compressOp()!.progress).toBe(25);

    apiMocks.state.resolveCompress!({ ok: true, data: "/home/user/big-folder.zip" });
    await done;
    expect(compressOp()!.status).toBe("completed");
  });

  it("relays dialog cancellation to the backend and clears the operation", async () => {
    const mutations = makeMutations();
    const done = mutations.compressToZip(["/home/user/big-folder"]);
    await vi.waitFor(() => expect(zipEventHandler).not.toBeNull());

    const op = compressOp()!;
    operationsManager.cancelOperation(op.id);

    // Next progress event observes the cancellation and calls the backend.
    zipEventHandler!({
      payload: { jobId: apiMocks.state.capturedJobId, bytesDone: 500, bytesTotal: 1000, currentFile: "a" },
    });
    expect(apiMocks.cancelCompress).toHaveBeenCalledWith(apiMocks.state.capturedJobId);

    apiMocks.state.resolveCompress!({ ok: false, error: "Compression cancelled" });
    await done;
    expect(compressOp()).toBeUndefined();
  });

  it("marks the operation failed on backend error", async () => {
    const mutations = makeMutations();
    const done = mutations.compressToZip(["/home/user/big-folder"]);
    await vi.waitFor(() => expect(zipEventHandler).not.toBeNull());

    apiMocks.state.resolveCompress!({ ok: false, error: "disk full" });
    await done;

    expect(compressOp()!.status).toBe("error");
    expect(compressOp()!.error).toBe("disk full");
  });
});

function extractOp() {
  return operationsManager.operations.find((op) => op.type === "extract");
}

describe("extractArchive progress", () => {
  it("tracks streamed byte progress and completes the operation", async () => {
    const mutations = makeMutations();
    const done = mutations.extractArchive("/home/user/big.zip", false);

    await vi.waitFor(() => expect(zipEventHandler).not.toBeNull());
    expect(apiMocks.state.capturedExtractJobId).toBeTypeOf("number");

    const op = extractOp();
    expect(op).toBeDefined();
    expect(op!.status).toBe("running");
    expect(op!.fileName).toBe("big.zip");

    zipEventHandler!({
      payload: { jobId: apiMocks.state.capturedExtractJobId, bytesDone: 750, bytesTotal: 1000, currentFile: "a" },
    });
    expect(extractOp()!.progress).toBe(75);
    expect(extractOp()!.totalBytes).toBe(1000);

    apiMocks.state.resolveExtract!({ ok: true, data: "/home/user/big" });
    await done;
    expect(extractOp()!.status).toBe("completed");
  });

  it("relays dialog cancellation to the backend and clears the operation", async () => {
    const mutations = makeMutations();
    const done = mutations.extractArchive("/home/user/big.zip", true);
    await vi.waitFor(() => expect(zipEventHandler).not.toBeNull());

    const op = extractOp()!;
    operationsManager.cancelOperation(op.id);

    zipEventHandler!({
      payload: { jobId: apiMocks.state.capturedExtractJobId, bytesDone: 500, bytesTotal: 1000, currentFile: "a" },
    });
    expect(apiMocks.cancelExtract).toHaveBeenCalledWith(apiMocks.state.capturedExtractJobId);

    apiMocks.state.resolveExtract!({ ok: false, error: "Extraction cancelled" });
    await done;
    expect(extractOp()).toBeUndefined();
  });
});
