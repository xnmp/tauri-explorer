/**
 * Site-demo fixture repositories: conversion of a fixture's `repos` map into
 * the commit graph the mock git backend serves, plus the pure log query
 * (branch reachability, path filter, cursor pagination) that mirrors the
 * native `git_log` contract. Pure and framework-free.
 */
import { parseFixtureDate } from "./demo-fixture-values";

export type DemoRefKind = "LocalBranch" | "RemoteBranch" | "Tag" | "Head";
export interface DemoRef { readonly name: string; readonly kind: DemoRefKind }
export type DemoCommitFileStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface DemoCommitFile {
  readonly path: string;
  readonly status: DemoCommitFileStatus;
  /** Unified diff against the first parent, or null when the fixture has none. */
  readonly diff: string | null;
}

export interface DemoCommit {
  readonly oid: string;
  readonly short_oid: string;
  readonly parents: readonly string[];
  readonly author_name: string;
  readonly author_email: string;
  /** Unix seconds. */
  readonly author_time: number;
  readonly summary: string;
  /** Full message, subject included. */
  readonly message: string;
  readonly files: readonly DemoCommitFile[];
}

export type DemoChangeStatus = "Modified" | "Added" | "Deleted" | "Renamed" | "Untracked" | "Conflicted";
export interface DemoChange { readonly path: string; readonly status: DemoChangeStatus }

export interface DemoRepo {
  readonly root: string;
  readonly branch: string | null;
  readonly head: string | null;
  /** Newest first, as `git log` lists them. */
  readonly commits: readonly DemoCommit[];
  /** OID -> decorations, only for decorated commits. */
  readonly refs: Readonly<Record<string, readonly DemoRef[]>>;
  readonly changes: readonly DemoChange[];
}

export const MAX_DEMO_COMMITS = 5000;
const MAX_FILES_PER_COMMIT = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A stable 40-hex object id for a fixture hash. Hex hashes keep their prefix
 * so the abbreviated id the graph shows is the one the fixture wrote.
 */
export function expandOid(hash: string): string {
  const lower = hash.trim().toLowerCase();
  const prefix = /^[0-9a-f]{4,40}$/.test(lower) ? lower : "";
  let out = prefix;
  for (let seed = 1; out.length < 40; seed++) out += fnv(lower, 2166136261 + seed * 7919).toString(16).padStart(8, "0");
  return out.slice(0, 40);
}

function parseRefs(raw: unknown): DemoRef[] {
  if (!Array.isArray(raw)) return [];
  const refs: DemoRef[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    const text = item.trim();
    const head = /^HEAD(?:\s*->\s*(.+))?$/.exec(text);
    if (head) {
      refs.push({ name: "HEAD", kind: "Head" });
      if (head[1]) refs.push({ name: head[1].trim(), kind: "LocalBranch" });
      continue;
    }
    const tag = /^tag:\s*(.+)$/.exec(text);
    if (tag) refs.push({ name: tag[1].trim(), kind: "Tag" });
    else if (/^(origin|upstream|remote)\//.test(text)) refs.push({ name: text, kind: "RemoteBranch" });
    else if (/^v\d/.test(text)) refs.push({ name: text, kind: "Tag" });
    else refs.push({ name: text, kind: "LocalBranch" });
  }
  return refs;
}

function commitFileStatus(value: unknown): DemoCommitFileStatus {
  const s = typeof value === "string" ? value.trim().toUpperCase()[0] : "";
  return s === "A" || s === "D" || s === "R" || s === "C" || s === "T" ? s : "M";
}

function withGitHeader(path: string, diff: string): string {
  return diff.startsWith("diff --git") ? diff : `diff --git a/${path} b/${path}\n${diff}`;
}

function changeStatus(value: unknown): DemoChangeStatus {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "??" || s === "u" || s.startsWith("untracked")) return "Untracked";
  if (s === "a" || s.startsWith("add")) return "Added";
  if (s === "d" || s.startsWith("del")) return "Deleted";
  if (s === "r" || s.startsWith("ren")) return "Renamed";
  if (s === "uu" || s.startsWith("conf")) return "Conflicted";
  return "Modified";
}

function emailFor(author: string): string {
  const slug = author.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return `${slug || "someone"}@example.invalid`;
}

/** Convert one fixture repository; null when it has no usable commits. */
export function convertDemoRepo(root: string, raw: unknown, now: number, warn: (message: string) => void): DemoRepo | null {
  if (!isRecord(raw)) {
    warn(`repos[${root}] is not an object`);
    return null;
  }
  const rawCommits = Array.isArray(raw.commits) ? raw.commits.slice(0, MAX_DEMO_COMMITS) : [];
  if (Array.isArray(raw.commits) && raw.commits.length > MAX_DEMO_COMMITS) {
    warn(`repos[${root}] has ${raw.commits.length} commits; kept the newest ${MAX_DEMO_COMMITS}`);
  }
  const idOf = new Map<string, string>();
  const usable = rawCommits.filter((c): c is Record<string, unknown> => {
    if (!isRecord(c) || typeof c.hash !== "string" || !c.hash.trim()) return false;
    if (idOf.has(c.hash)) {
      warn(`repos[${root}]: duplicate commit ${c.hash} ignored`);
      return false;
    }
    idOf.set(c.hash, expandOid(c.hash));
    return true;
  });

  const refs: Record<string, DemoRef[]> = {};
  const commits = usable.map((c, index): DemoCommit => {
    const oid = idOf.get(c.hash as string)!;
    const message = typeof c.msg === "string" ? c.msg : "";
    const parents = (Array.isArray(c.parents) ? c.parents : [])
      .filter((p): p is string => typeof p === "string")
      .flatMap((p) => {
        const parent = idOf.get(p);
        if (!parent) warn(`repos[${root}]: commit ${c.hash} names unknown parent ${p}`);
        return parent ? [parent] : [];
      });
    const author = typeof c.author === "string" && c.author.trim() ? c.author.trim() : "Unknown";
    const time = parseFixtureDate(c.date, now) ?? now - index * 3_600_000;
    const files = (Array.isArray(c.files) ? c.files.slice(0, MAX_FILES_PER_COMMIT) : [])
      .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f.path === "string" && f.path.length > 0)
      .map((f): DemoCommitFile => ({
        path: (f.path as string).replace(/^\/+/, ""),
        status: commitFileStatus(f.status),
        diff: typeof f.diff === "string" ? withGitHeader((f.path as string).replace(/^\/+/, ""), f.diff) : null,
      }));
    const decorations = parseRefs(c.refs);
    if (decorations.length) refs[oid] = decorations;
    return {
      oid,
      short_oid: oid.slice(0, 7),
      parents,
      author_name: author,
      author_email: typeof c.email === "string" ? c.email : emailFor(author),
      author_time: Math.floor(time / 1000),
      summary: message.split("\n")[0] || "(no message)",
      message,
      files,
    };
  });
  if (commits.length === 0) {
    warn(`repos[${root}] has no usable commits`);
    return null;
  }

  const branch = typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : null;
  let head = Object.entries(refs).find(([, list]) => list.some((r) => r.kind === "Head"))?.[0] ?? null;
  if (!head) {
    head = (branch && Object.entries(refs).find(([, list]) =>
      list.some((r) => r.kind === "LocalBranch" && r.name === branch))?.[0]) || commits[0].oid;
    refs[head] = [{ name: "HEAD", kind: "Head" }, ...(refs[head] ?? [])];
  }
  if (branch && !Object.values(refs).some((list) => list.some((r) => r.kind === "LocalBranch" && r.name === branch))) {
    refs[head] = [...refs[head], { name: branch, kind: "LocalBranch" }];
  }
  const headBranch = refs[head].find((r) => r.kind === "LocalBranch")?.name ?? branch;

  const changes = (Array.isArray(raw.changes) ? raw.changes : [])
    .filter((ch): ch is Record<string, unknown> => isRecord(ch) && typeof ch.path === "string" && ch.path.length > 0)
    .map((ch) => ({ path: (ch.path as string).replace(/^\/+/, ""), status: changeStatus(ch.status) }));

  return { root, branch: headBranch, head, commits, refs, changes };
}

export interface DemoLogOptions {
  skip?: number;
  limit?: number;
  cursor?: string;
  branches?: string[];
  exclude_branches?: string[];
  file_path?: string;
}

export interface DemoLogPage {
  commits: Omit<DemoCommit, "message" | "files">[];
  has_more: boolean;
  next_cursor: string | null;
  /** True when `cursor` is not in the filtered history (the native stale-cursor error). */
  staleCursor: boolean;
}

/** One `git_log` page: seeded reachability, path filter, then cursor/skip paging. */
export function queryDemoLog(repo: DemoRepo, options: DemoLogOptions): DemoLogPage {
  let all = repo.commits;
  const excluded = new Set(options.exclude_branches ?? []);
  if (options.branches || excluded.size > 0) {
    const tips = new Map<string, string>();
    for (const [oid, list] of Object.entries(repo.refs)) {
      for (const r of list) if (r.kind === "LocalBranch" || r.kind === "RemoteBranch") tips.set(r.name, oid);
    }
    const seeds = (options.branches ?? [...tips.keys()]).filter((n) => !excluded.has(n))
      .map((n) => tips.get(n)).filter((oid): oid is string => oid !== undefined);
    if (!options.branches && repo.head) seeds.push(repo.head);
    const byOid = new Map(all.map((c) => [c.oid, c]));
    const reachable = new Set<string>();
    while (seeds.length) {
      const oid = seeds.pop()!;
      if (reachable.has(oid)) continue;
      reachable.add(oid);
      seeds.push(...(byOid.get(oid)?.parents ?? []));
    }
    all = all.filter((c) => reachable.has(c.oid));
  }
  const filePath = options.file_path?.trim();
  if (filePath) all = all.filter((c) => c.files.some((f) => f.path === filePath));
  let start = Math.max(0, options.skip ?? 0);
  if (options.cursor) {
    const index = all.findIndex((c) => c.oid === options.cursor);
    if (index < 0) return { commits: [], has_more: false, next_cursor: null, staleCursor: true };
    start = index + 1;
  }
  const limit = Math.max(1, options.limit ?? 500);
  const page = all.slice(start, start + limit);
  return {
    commits: page.map(({ message: _m, files: _f, ...commit }) => commit),
    has_more: start + limit < all.length,
    next_cursor: page.at(-1)?.oid ?? null,
    staleCursor: false,
  };
}

/** Every commit reachable from `tip`, itself included. */
function ancestorsOf(repo: DemoRepo, tip: string): Set<string> {
  const byOid = new Map(repo.commits.map((c) => [c.oid, c]));
  const seen = new Set<string>();
  const pending = [tip];
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    pending.push(...(byOid.get(oid)?.parents ?? []));
  }
  return seen;
}

/** Files changed between two commits: the union of the commits on the way. */
export function compareDemoCommits(repo: DemoRepo, baseOid: string, targetOid: string): DemoCommitFile[] {
  const byOid = new Map(repo.commits.map((c) => [c.oid, c]));
  const base = ancestorsOf(repo, baseOid);
  const files = new Map<string, DemoCommitFile>();
  for (const oid of ancestorsOf(repo, targetOid)) {
    if (base.has(oid)) continue;
    for (const file of byOid.get(oid)?.files ?? []) if (!files.has(file.path)) files.set(file.path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The nearest common ancestor of two commits, newest first. */
export function demoMergeBase(repo: DemoRepo, first: string, second: string): string | null {
  const left = ancestorsOf(repo, first);
  const right = ancestorsOf(repo, second);
  return repo.commits.find((c) => left.has(c.oid) && right.has(c.oid))?.oid ?? null;
}
