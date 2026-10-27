// impact-git.mjs — read what impact-select.mjs needs from git (#1368).
// Everything here shells out; the selection itself stays pure.

import { execFileSync } from "node:child_process";
import { parseHunks } from "./impact-regions.mjs";
import { invertHunks, lineTranslator } from "./impact-select.mjs";

/** @param {string[]} args @param {string} root */
const git = (args, root) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
/** @param {string[]} args @param {string} root */
const gitOrNull = (args, root) => { try { return git(args, root); } catch { return null; } };

/**
 * @param {{ base: string, head: string, files: string[], root: string,
 *   read: import("./version-only.mjs").BlobReader, impact: import("./impact-coverage.mjs").ImpactMap,
 *   direct?: boolean }} input
 *   direct: diff `base` itself against `head` (the drift since the map's
 *   commit, in whichever direction), instead of their merge base; `read`
 *   must then read "base" at `base` too.
 * @returns {import("./impact-select.mjs").ChangedFile[]}
 */
export function gatherChanged({ base, head, files, root, read, impact, direct = false }) {
  const mergeBase = direct ? base : git(["merge-base", base, head], root).trim();
  const mapCommit = /^[0-9a-f]{7,40}$/.test(impact.commit) && gitOrNull(["cat-file", "-e", `${impact.commit}^{commit}`], root) !== null
    ? impact.commit : null;
  return files.map((path) => {
    const baseText = read("base", path);
    const headText = read("head", path);
    const status = baseText === null ? "added" : headText === null ? "deleted" : "modified";
    if (status !== "modified") return { path, status, baseText, headText };
    const hunks = parseHunks(git(["diff", "-U0", "--no-renames", "--no-color", mergeBase, head, "--", path], root));
    const baseBlob = gitOrNull(["rev-parse", `${mergeBase}:${path}`], root)?.trim() ?? null;
    const entry = impact.lines?.[path];
    /** @type {((line: number) => number | null) | null} */
    let toMapLine = null;
    if (entry && baseBlob && entry.blob !== baseBlob && mapCommit &&
        gitOrNull(["rev-parse", `${mapCommit}:${path}`], root)?.trim() === entry.blob) {
      // Lines the map's commit and the merge base share keep their data.
      const between = parseHunks(git(["diff", "-U0", "--no-renames", "--no-color", mapCommit, mergeBase, "--", path], root));
      toMapLine = lineTranslator(invertHunks(between));
    }
    return { path, status, baseText, headText, hunks, baseBlob, toMapLine };
  });
}

/**
 * Whether a path is tracked under src/ at `rev`.
 * @param {string} rev
 * @param {string} root
 * @returns {(path: string) => boolean}
 */
export function trackedAt(rev, root) {
  const tracked = new Set((gitOrNull(["ls-tree", "-r", "--name-only", rev, "--", "src"], root) ?? "").split("\n").filter(Boolean));
  return (p) => tracked.has(p);
}

/**
 * Files changed between two commits (renames as delete + add), or null when
 * either commit is unavailable.
 * @param {string} from
 * @param {string} to
 * @param {string} root
 * @returns {string[] | null}
 */
export function changedBetween(from, to, root) {
  const out = gitOrNull(["diff", "--name-only", "--no-renames", from, to], root);
  return out === null ? null : out.split("\n").filter(Boolean);
}

/**
 * A blob reader for "base" at `base` and "head" at `head` exactly (no merge
 * base), returning null for a path absent at that commit.
 * @param {string} base
 * @param {string} head
 * @param {string} root
 * @returns {import("./version-only.mjs").BlobReader}
 */
export function directBlobReader(base, head, root) {
  return (side, path) => gitOrNull(["show", `${side === "base" ? base : head}:${path}`], root);
}
