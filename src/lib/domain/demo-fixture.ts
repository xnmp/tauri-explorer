/**
 * Site-demo fixture conversion (marketing site, #1789 follow-up).
 *
 * The site's fictional filesystems (`overhaul/content/fs-*.js`, documented in
 * `overhaul/engine/README.md` "Filesystem format") are converted here into
 * the world the browser mock backend serves: directory listings in the native
 * listing contract, text contents, per-file media, drives, bookmarks, Recycle
 * Bin items and git repositories. Input is untrusted page data, so every
 * field is validated and a malformed node is skipped with a warning rather
 * than failing the whole world. Pure and framework-free.
 */
import type { FileEntry } from "./file";
import { convertDemoRepo, type DemoRepo } from "./demo-fixture-git";
import {
  parseFixtureDate,
  parseFixtureDuration,
  parseFixturePixels,
  parseFixtureSize,
  resolveFixtureUrl,
  utf8Length,
} from "./demo-fixture-values";

export type DemoPixels = { width: number; height: number } | null;

export type DemoMedia =
  | { readonly kind: "image"; readonly src: string; readonly pixels: DemoPixels }
  | { readonly kind: "video"; readonly src: string | null; readonly poster: string | null; readonly duration: number | null; readonly pixels: DemoPixels }
  | { readonly kind: "pdf"; readonly src: string };

/** Listings, text and media of one subtree, keyed by absolute path. */
export interface DemoTree {
  readonly listings: Record<string, FileEntry[]>;
  readonly texts: Record<string, string>;
  readonly media: Record<string, DemoMedia>;
  /** Explicit fixture `type` hints (`md`, `audio`, …) by path. */
  readonly types: Record<string, string>;
}

export interface DemoTrashItem extends DemoTree {
  /** The entry as it will be restored, at `originalPath`. */
  readonly entry: FileEntry;
  readonly originalPath: string;
  readonly deletedAt: string;
}

export interface DemoUser {
  readonly id: string;
  readonly name: string;
  readonly home: string;
}

export interface DemoDrive {
  readonly name: string;
  readonly path: string;
  readonly kind: "fixed" | "removable";
}

export interface DemoWorld extends DemoTree {
  readonly title: string;
  /** The user the world is presented as (`users[0]` unless one was chosen). */
  readonly user: DemoUser;
  readonly users: readonly DemoUser[];
  readonly drives: readonly DemoDrive[];
  readonly bookmarks: readonly { readonly name: string; readonly path: string }[];
  readonly trash: readonly DemoTrashItem[];
  readonly repos: readonly DemoRepo[];
  /** Everything skipped or repaired, for the host's console. */
  readonly warnings: readonly string[];
}

export interface DemoFixtureOptions {
  /** Base URL that page-relative `src`/`poster` URLs resolve against. */
  assetBase?: string;
  /** Reference time for relative and year-less dates (epoch ms). */
  now: number;
  /** Present the world as this user id instead of the first one. */
  userId?: string;
  /** Node budget; larger fixtures are truncated with a warning. */
  maxNodes?: number;
}

export const DEFAULT_MAX_DEMO_NODES = 100_000;
const MAX_DEPTH = 64;
const VIDEO_SRC = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function joinDemoPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function isValidName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 255
    && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

function isAbsolutePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
}

/** Trim a trailing slash so "/home/ines/" and "/home/ines" are one path. */
function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

interface Walk {
  readonly options: DemoFixtureOptions;
  readonly repoRoots: ReadonlySet<string>;
  readonly warn: (message: string) => void;
  nodes: number;
  truncated: boolean;
}

function mediaFor(node: Record<string, unknown>, name: string, base: string | undefined): DemoMedia | null {
  const src = typeof node.src === "string" && node.src ? resolveFixtureUrl(node.src, base) : null;
  const poster = typeof node.poster === "string" && node.poster ? resolveFixtureUrl(node.poster, base) : null;
  const pixels = parseFixturePixels(node.px);
  const rawSrc = typeof node.src === "string" ? node.src : "";
  if (node.type === "video" || VIDEO_SRC.test(rawSrc)) {
    if (!src && !poster) return null;
    return { kind: "video", src, poster, duration: parseFixtureDuration(node.duration), pixels };
  }
  if (!src) return null;
  if (/\.pdf$/i.test(name)) return { kind: "pdf", src };
  return { kind: "image", src, pixels };
}

/**
 * Add one node (and its subtree) under `dir`. Returns its listing entry, or
 * null when the node is unusable. `fallbackTime` dates nodes without a date.
 */
function addNode(walk: Walk, tree: DemoTree, raw: unknown, dir: string, depth: number, fallbackTime: number): FileEntry | null {
  if (walk.nodes >= (walk.options.maxNodes ?? DEFAULT_MAX_DEMO_NODES)) {
    if (!walk.truncated) walk.warn(`fixture exceeds ${walk.options.maxNodes ?? DEFAULT_MAX_DEMO_NODES} nodes; the rest is omitted`);
    walk.truncated = true;
    return null;
  }
  if (!isRecord(raw)) {
    walk.warn(`${dir}: skipped a node that is not an object`);
    return null;
  }
  if (!isValidName(raw.name)) {
    walk.warn(`${dir}: skipped a node with an invalid name (${JSON.stringify(raw.name)})`);
    return null;
  }
  walk.nodes += 1;
  const name = raw.name;
  const path = joinDemoPath(dir, name);
  const time = parseFixtureDate(raw.date, walk.options.now) ?? fallbackTime;
  const modified = new Date(time).toISOString();
  const isDir = Array.isArray(raw.kids) || raw.kind === "dir" || raw.kind === "directory";
  if (isDir) {
    if (depth >= MAX_DEPTH) {
      walk.warn(`${path}: deeper than ${MAX_DEPTH} levels; its contents are omitted`);
      tree.listings[path] = [];
    } else {
      addChildren(walk, tree, raw.kids, path, depth + 1, time);
    }
    return {
      name, path, kind: "directory", size: 0, modified,
      ...(walk.repoRoots.has(path) ? { is_git_repo: true } : {}),
    };
  }
  const text = typeof raw.text === "string" ? raw.text : null;
  if (text !== null) tree.texts[path] = text;
  if (typeof raw.type === "string" && raw.type) tree.types[path] = raw.type;
  const media = mediaFor(raw, name, walk.options.assetBase);
  if (media) tree.media[path] = media;
  const size = parseFixtureSize(raw.size) ?? (text !== null ? utf8Length(text) : 0);
  return { name, path, kind: "file", size, modified };
}

function addChildren(walk: Walk, tree: DemoTree, kids: unknown, dir: string, depth: number, fallbackTime: number): void {
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  tree.listings[dir] = entries;
  if (kids === undefined) return;
  if (!Array.isArray(kids)) {
    walk.warn(`${dir}: "kids" is not an array`);
    return;
  }
  for (const kid of kids) {
    const name = isRecord(kid) ? kid.name : undefined;
    if (typeof name === "string" && seen.has(name)) {
      walk.warn(`${joinDemoPath(dir, name)}: duplicate name ignored`);
      continue;
    }
    const entry = addNode(walk, tree, kid, dir, depth, fallbackTime);
    if (!entry) continue;
    seen.add(entry.name);
    entries.push(entry);
  }
}

function emptyTree(): DemoTree {
  return { listings: {}, texts: {}, media: {}, types: {} };
}

interface UserRecord { readonly user: DemoUser; readonly bookmarks: unknown }

function convertUsers(raw: unknown, warn: (message: string) => void): UserRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((user, index): UserRecord[] => {
    if (!isRecord(user) || !isAbsolutePath(user.home)) {
      warn(`users[${index}] needs an absolute "home"`);
      return [];
    }
    const id = typeof user.id === "string" && user.id ? user.id : `user${index + 1}`;
    const name = typeof user.name === "string" && user.name ? user.name : id;
    return [{ user: { id, name, home: normalizePath(user.home) }, bookmarks: user.bookmarks }];
  });
}

/** Convert a fixture into the mock world. Never throws for posted (structured-clone) data. */
export function convertDemoFixture(raw: unknown, options: DemoFixtureOptions): DemoWorld {
  const warnings: string[] = [];
  const warn = (message: string) => { if (warnings.length < 200) warnings.push(message); };
  const fixture = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) warn("fixture is not an object; serving an empty filesystem");

  const repoInput = isRecord(fixture.repos) ? fixture.repos : {};
  const repoRoots = new Set(Object.keys(repoInput).filter(isAbsolutePath).map(normalizePath));

  const tree = emptyTree();
  const walk: Walk = { options, repoRoots, warn, nodes: 0, truncated: false };
  const root = isRecord(fixture.tree) ? fixture.tree : {};
  addChildren(walk, tree, root.kids, "/", 0, options.now);

  const records = convertUsers(fixture.users, warn);
  const chosen = records.find((r) => r.user.id === options.userId) ?? records[0];
  let user: DemoUser = chosen?.user ?? { id: "user", name: "User", home: "/" };
  if (!(user.home in tree.listings)) {
    warn(`home ${user.home} is not a folder in the tree; using /`);
    user = { ...user, home: "/" };
  }

  const drives: DemoDrive[] = [
    { name: typeof fixture.title === "string" && fixture.title ? fixture.title : "File System", path: "/", kind: "fixed" },
    ...(tree.listings["/media"] ?? [])
      .filter((e) => e.kind === "directory")
      .map((e): DemoDrive => ({ name: e.name, path: e.path, kind: "removable" })),
  ];

  // Absent bookmarks default to the folders that exist in the user's home
  // (never the desktop's system folders, which a fixture need not have).
  const rawBookmarks = chosen?.bookmarks;
  const bookmarkPaths = Array.isArray(rawBookmarks)
    ? rawBookmarks
    : (tree.listings[user.home] ?? []).filter((e) => e.kind === "directory" && !e.name.startsWith(".")).map((e) => e.path);
  const bookmarks = bookmarkPaths
    .filter(isAbsolutePath)
    .map(normalizePath)
    .filter((path, index, all) => {
      if (all.indexOf(path) !== index) return false;
      if (path in tree.listings) return true;
      warn(`bookmark ${path} is not a folder in the tree`);
      return false;
    })
    .map((path) => ({ name: path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1), path }));

  const trash = (Array.isArray(fixture.trash) ? fixture.trash : []).flatMap((item, index): DemoTrashItem[] => {
    if (!isRecord(item) || !isAbsolutePath(item.from)) {
      warn(`trash[${index}] needs an absolute "from"`);
      return [];
    }
    const from = normalizePath(item.from);
    const subtree = emptyTree();
    const entry = addNode(walk, subtree, item.node, from, 0, options.now);
    if (!entry) return [];
    const deleted = parseFixtureDate(item.deleted, options.now) ?? options.now;
    return [{ ...subtree, entry, originalPath: entry.path, deletedAt: new Date(deleted).toISOString() }];
  });

  const repos = [...repoRoots].flatMap((rootPath): DemoRepo[] => {
    const key = Object.keys(repoInput).find((k) => normalizePath(k) === rootPath)!;
    if (!(rootPath in tree.listings)) {
      warn(`repos[${rootPath}] is not a folder in the tree`);
      return [];
    }
    const repo = convertDemoRepo(rootPath, repoInput[key], options.now, warn);
    return repo ? [repo] : [];
  });

  return {
    ...tree,
    title: typeof fixture.title === "string" ? fixture.title : "",
    user,
    users: records.map((r) => r.user),
    drives,
    bookmarks,
    trash,
    repos,
    warnings,
  };
}
