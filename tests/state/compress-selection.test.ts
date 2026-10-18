/** Compress receives an Explorer selection that may span a peeked folder and
 * its children. The backend names archive members by basename only, so the
 * selection is reduced to operation roots and same-name roots are refused. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

const compressToZip = vi.hoisted(() => vi.fn(async (paths: string[], _jobId?: number) => ({ ok: true as const, data: `${paths[0]}.zip` })));
vi.mock("$lib/api/archive", async original => ({ ...await original<typeof import("$lib/api/archive")>(), compressToZip }));
vi.mock("$lib/state/file-events", async original => ({ ...await original<typeof import("$lib/state/file-events")>(), broadcastFileChange: vi.fn() }));

import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
import { toastStore } from "$lib/state/toast.svelte";

const entry = (path: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
const alpha = entry("/r/Alpha", "directory"), beta = entry("/r/Beta", "directory");
const alphaSame = entry("/r/Alpha/same.txt"), betaSame = entry("/r/Beta/same.txt"), betaOther = entry("/r/Beta/other.txt");
let pane: ExplorerInstance;
let errors: string[];
beforeEach(() => {
  compressToZip.mockClear(); errors = [];
  vi.spyOn(toastStore, "error").mockImplementation(message => { errors.push(String(message)); return 0 as never; });
  pane = createExplorerState({ currentPath: "/r", entries: [alpha, beta], sortBy: "name", sortAscending: true, viewMode: "details" });
});
afterEach(async () => { await pane.destroy(); vi.restoreAllMocks(); });

it("compresses a selected folder once, not again through its selected children", async () => {
  await pane.compressToZip([alpha, alphaSame, betaOther]);
  expect(compressToZip).toHaveBeenCalledTimes(1);
  expect(compressToZip.mock.calls[0][0]).toEqual([alpha.path, betaOther.path]);
  expect(errors).toEqual([]);
});

it("refuses roots from different folders that would share an archive member name", async () => {
  await pane.compressToZip([alphaSame, betaSame]);
  expect(compressToZip).not.toHaveBeenCalled();
  expect(errors).toEqual(["Selected items have the same name"]);
});

it("allows a same-named child once its folder covers it", async () => {
  await pane.compressToZip([alpha, alphaSame, betaSame]);
  expect(compressToZip.mock.calls[0][0]).toEqual([alpha.path, betaSame.path]);
});
