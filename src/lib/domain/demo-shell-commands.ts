/**
 * Commands of the site demo's in-memory shell (see `demo-shell.ts`). Each
 * command reads the fixture filesystem through the narrow `ShellFs` port and
 * changes it only through that port's mutations, which the demo routes
 * through the mock backend so the panes refresh. Pure and framework-free.
 */
import type { DemoRepo } from "./demo-fixture-git";

export interface ShellEntry {
  readonly name: string;
  readonly path: string;
  readonly dir: boolean;
  readonly size: number;
  /** ISO 8601. */
  readonly modified: string;
}

/** The shell's view of the filesystem. Mutations resolve to an error message, or null on success. */
export interface ShellFs {
  stat(path: string): ShellEntry | null;
  list(dir: string): ShellEntry[] | null;
  read(path: string): string | null;
  mkdir(path: string): Promise<string | null>;
  touch(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<string | null>;
  move(from: string, to: string): Promise<string | null>;
  copy(from: string, to: string): Promise<string | null>;
  trash(path: string): Promise<string | null>;
}

export interface ShellEnv {
  readonly fs: ShellFs;
  readonly home: string;
  readonly user: string;
  readonly host: string;
  readonly columns: number;
  readonly history: readonly string[];
  repoFor(path: string): DemoRepo | null;
}

export interface CommandIo {
  cwd: string;
  previousCwd: string;
  out: string;
  err: string;
  status: number;
  clear: boolean;
}

export const BOLD_BLUE = "\x1b[1;34m";
const RED = "\x1b[1;31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const MAX_LINES = 2000;

/** Absolute path for `input` relative to `cwd`, with `~`, `.` and `..` resolved. */
export function resolveShellPath(input: string, cwd: string, home: string): string {
  let path = input;
  if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
  if (!path.startsWith("/")) path = `${cwd === "/" ? "" : cwd}/${path}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** `~`-abbreviated display form of an absolute path. */
export function displayShellPath(path: string, home: string): string {
  if (home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

const parentOf = (path: string) => (path.lastIndexOf("/") <= 0 ? "/" : path.slice(0, path.lastIndexOf("/")));
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

interface Parsed { flags: Set<string>; values: Map<string, string>; args: string[] }

/** Split short/long flags from operands; `valued` flags take the next word. */
function parseArgs(argv: readonly string[], valued: readonly string[] = []): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--") { args.push(...argv.slice(i + 1)); break; }
    if (valued.includes(word)) { values.set(word, argv[++i] ?? ""); continue; }
    if (word.startsWith("--") && word.length > 2) { flags.add(word); continue; }
    if (/^-\d+$/.test(word)) { values.set("-n", word.slice(1)); continue; }
    if (word.startsWith("-") && word.length > 1) {
      for (const letter of word.slice(1)) flags.add(`-${letter}`);
      continue;
    }
    args.push(word);
  }
  return { flags, values, args };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function lsDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "            ";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function colored(entry: ShellEntry): string {
  return entry.dir ? `${BOLD_BLUE}${entry.name}${RESET}` : entry.name;
}

/** Names laid out in columns across `width` cells, like `ls` on a terminal. */
export function columnize(entries: readonly ShellEntry[], width: number): string {
  if (entries.length === 0) return "";
  const cell = Math.max(...entries.map((e) => e.name.length)) + 2;
  const perRow = Math.max(1, Math.floor(width / cell));
  const rows = Math.ceil(entries.length / perRow);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < perRow; c++) {
      const entry = entries[c * rows + r];
      if (!entry) continue;
      const next = entries[(c + 1) * rows + r];
      line += colored(entry) + (next ? " ".repeat(cell - entry.name.length) : "");
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

const byName = (a: ShellEntry, b: ShellEntry) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());

function ls(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const { flags, args } = parseArgs(argv);
  const all = flags.has("-a");
  const almost = flags.has("-A");
  const long = flags.has("-l");
  const targets = args.length ? args : ["."];
  const files: ShellEntry[] = [];
  const dirs: [string, ShellEntry[]][] = [];
  for (const target of targets) {
    const path = resolveShellPath(target, io.cwd, env.home);
    const entry = env.fs.stat(path);
    if (!entry) { io.err += `ls: cannot access '${target}': No such file or directory\n`; io.status = 2; continue; }
    if (!entry.dir) { files.push({ ...entry, name: target }); continue; }
    const listing = (env.fs.list(path) ?? []).filter((e) => all || almost || !e.name.startsWith(".")).sort(byName);
    if (all) {
      listing.unshift({ ...entry, name: "." }, { ...(env.fs.stat(parentOf(path)) ?? entry), name: ".." });
    }
    dirs.push([target, listing]);
  }
  const render = (entries: ShellEntry[]) => {
    if (!long) return columnize(entries, env.columns);
    return entries.map((e) =>
      `${e.dir ? "drwxr-xr-x" : "-rw-r--r--"} 1 ${env.user} ${env.user} ${String(e.dir ? 4096 : e.size).padStart(9)} ${lsDate(e.modified)} ${colored(e)}\n`,
    ).join("");
  };
  io.out += render(files.sort(byName));
  dirs.forEach(([label, entries], index) => {
    if (targets.length > 1) io.out += `${index > 0 || files.length ? "\n" : ""}${label}:\n`;
    io.out += render(entries);
  });
}

function cd(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const target = argv[0] ?? "~";
  const path = target === "-" ? io.previousCwd : resolveShellPath(target, io.cwd, env.home);
  const entry = env.fs.stat(path);
  if (!entry) { io.err += `cd: no such file or directory: ${target}\n`; io.status = 1; return; }
  if (!entry.dir) { io.err += `cd: not a directory: ${target}\n`; io.status = 1; return; }
  if (target === "-") io.out += `${displayShellPath(path, env.home)}\n`;
  io.previousCwd = io.cwd;
  io.cwd = path;
}

/** Read a file operand, reporting the shell's usual errors. */
function readText(name: string, command: string, io: CommandIo, env: ShellEnv): string | null {
  const path = resolveShellPath(name, io.cwd, env.home);
  const entry = env.fs.stat(path);
  const fail = (why: string) => { io.err += `${command}: ${name}: ${why}\n`; io.status = 1; return null; };
  if (!entry) return fail("No such file or directory");
  if (entry.dir) return fail("Is a directory");
  const text = env.fs.read(path);
  if (text === null) return fail("binary file (no text in this demo)");
  return text;
}

function cat(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const { flags, args } = parseArgs(argv);
  if (!args.length) { io.err += "cat: reading standard input is not supported here\n"; io.status = 1; return; }
  let n = 0;
  for (const name of args) {
    const text = readText(name, "cat", io, env);
    if (text === null) continue;
    if (text === "") continue;
    const body = text.endsWith("\n") ? text : `${text}\n`;
    io.out += flags.has("-n")
      ? `${body.slice(0, -1).split("\n").map((line) => `${String(++n).padStart(6)}\t${line}`).join("\n")}\n`
      : body;
  }
}

function headTail(argv: readonly string[], io: CommandIo, env: ShellEnv, tail: boolean): void {
  const { values, args } = parseArgs(argv, ["-n"]);
  const count = Math.max(0, Number.parseInt(values.get("-n") ?? "10", 10) || 0);
  const name = tail ? "tail" : "head";
  if (!args.length) { io.err += `${name}: reading standard input is not supported here\n`; io.status = 1; return; }
  args.forEach((file, index) => {
    const text = readText(file, name, io, env);
    if (text === null) return;
    const lines = text.replace(/\n$/, "").split("\n");
    const picked = tail ? lines.slice(Math.max(0, lines.length - count)) : lines.slice(0, count);
    if (args.length > 1) io.out += `${index ? "\n" : ""}==> ${file} <==\n`;
    if (picked.length && count) io.out += `${picked.join("\n")}\n`;
  });
}

function tree(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const { flags, args } = parseArgs(argv);
  const root = args[0] ?? ".";
  const path = resolveShellPath(root, io.cwd, env.home);
  const entry = env.fs.stat(path);
  if (!entry?.dir) { io.err += `${root} [error opening dir]\n`; io.status = 2; return; }
  let dirCount = 0;
  let fileCount = 0;
  const lines = [`${BOLD_BLUE}${root}${RESET}`];
  const walk = (dir: string, prefix: string, depth: number) => {
    const kids = (env.fs.list(dir) ?? [])
      .filter((e) => (flags.has("-a") || !e.name.startsWith(".")) && (!flags.has("-d") || e.dir))
      .sort(byName);
    kids.forEach((kid, index) => {
      if (lines.length >= MAX_LINES) return;
      const last = index === kids.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${colored(kid)}`);
      if (kid.dir) {
        dirCount++;
        if (depth < 32) walk(kid.path, `${prefix}${last ? "    " : "│   "}`, depth + 1);
      } else fileCount++;
    });
  };
  walk(path, "", 0);
  if (lines.length >= MAX_LINES) lines.push("…");
  io.out += `${lines.join("\n")}\n\n${dirCount} director${dirCount === 1 ? "y" : "ies"}${flags.has("-d") ? "" : `, ${fileCount} file${fileCount === 1 ? "" : "s"}`}\n`;
}

/** Shell-glob match of a whole name (`*`, `?`). */
export function globMatch(pattern: string, name: string, ignoreCase = false): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "").test(name);
}

function find(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const roots: string[] = [];
  let name: { pattern: string; ignoreCase: boolean } | null = null;
  let type: "f" | "d" | null = null;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "-name" || word === "-iname") name = { pattern: argv[++i] ?? "", ignoreCase: word === "-iname" };
    else if (word === "-type") {
      const value = argv[++i];
      if (value !== "f" && value !== "d") { io.err += `find: Unknown argument to -type: ${value ?? ""}\n`; io.status = 1; return; }
      type = value;
    } else if (word.startsWith("-")) { io.err += `find: unknown predicate '${word}'\n`; io.status = 1; return; }
    else roots.push(word);
  }
  let printed = 0;
  for (const root of roots.length ? roots : ["."]) {
    const path = resolveShellPath(root, io.cwd, env.home);
    const start = env.fs.stat(path);
    if (!start) { io.err += `find: '${root}': No such file or directory\n`; io.status = 1; continue; }
    const visit = (entry: ShellEntry, shown: string) => {
      if (printed >= MAX_LINES) return;
      const nameOk = !name || globMatch(name.pattern, entry.name, name.ignoreCase);
      const typeOk = !type || (type === "d") === entry.dir;
      if (nameOk && typeOk) { io.out += `${shown}\n`; printed++; }
      if (entry.dir) for (const kid of (env.fs.list(entry.path) ?? []).sort(byName)) visit(kid, `${shown === "/" ? "" : shown}/${kid.name}`);
    };
    visit(start, root);
  }
}

function grep(argv: readonly string[], io: CommandIo, env: ShellEnv): void {
  const { flags, args } = parseArgs(argv);
  const [pattern, ...operands] = args;
  if (pattern === undefined) { io.err += "usage: grep [-rinlc] PATTERN [FILE...]\n"; io.status = 2; return; }
  const recursive = flags.has("-r") || flags.has("-R");
  const ignoreCase = flags.has("-i");
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ignoreCase ? "gi" : "g");
  }
  const targets = operands.length ? operands : recursive ? ["."] : [];
  if (!targets.length) { io.err += "grep: reading standard input is not supported here; try grep -r\n"; io.status = 2; return; }
  const files: [string, string][] = [];
  for (const target of targets) {
    const path = resolveShellPath(target, io.cwd, env.home);
    const entry = env.fs.stat(path);
    if (!entry) { io.err += `grep: ${target}: No such file or directory\n`; io.status = 2; continue; }
    if (!entry.dir) { files.push([target, path]); continue; }
    if (!recursive) { io.err += `grep: ${target}: Is a directory\n`; continue; }
    const walk = (dir: string, shown: string) => {
      for (const kid of (env.fs.list(dir) ?? []).sort(byName)) {
        const label = shown === "." && !operands.length ? kid.name : `${shown.replace(/\/$/, "")}/${kid.name}`;
        if (kid.dir) walk(kid.path, label);
        else files.push([label, kid.path]);
      }
    };
    walk(path, target);
  }
  const prefixNames = recursive || files.length > 1;
  let matched = false;
  let printed = 0;
  for (const [label, path] of files) {
    const text = env.fs.read(path);
    if (text === null) continue;
    let count = 0;
    text.split("\n").forEach((line, index) => {
      re.lastIndex = 0;
      if (!re.test(line)) return;
      count++;
      if (flags.has("-l") || flags.has("-c") || printed >= MAX_LINES) return;
      re.lastIndex = 0;
      const highlighted = line.replace(re, (m) => (m ? `${RED}${m}${RESET}` : m));
      io.out += `${prefixNames ? `\x1b[35m${label}${RESET}:` : ""}${flags.has("-n") ? `${GREEN}${index + 1}${RESET}:` : ""}${highlighted}\n`;
      printed++;
    });
    if (count) matched = true;
    if (flags.has("-l") && count) io.out += `${label}\n`;
    else if (flags.has("-c")) io.out += `${prefixNames ? `${label}:` : ""}${count}\n`;
  }
  if (!matched && io.status === 0) io.status = 1;
}

/** A mutation's error, reported with the command's name. */
function report(io: CommandIo, command: string, error: string | null): boolean {
  if (error === null) return true;
  io.err += `${command}: ${error}\n`;
  io.status = 1;
  return false;
}

async function mkdir(argv: readonly string[], io: CommandIo, env: ShellEnv): Promise<void> {
  const { flags, args } = parseArgs(argv);
  if (!args.length) { io.err += "mkdir: missing operand\n"; io.status = 1; return; }
  for (const arg of args) {
    const path = resolveShellPath(arg, io.cwd, env.home);
    const chain = flags.has("-p") ? path.split("/").slice(1).map((_, i, parts) => `/${parts.slice(0, i + 1).join("/")}`) : [path];
    for (const step of chain) {
      const existing = env.fs.stat(step);
      if (existing) {
        if (!flags.has("-p")) report(io, "mkdir", `cannot create directory '${arg}': File exists`);
        continue;
      }
      if (!env.fs.stat(parentOf(step))?.dir) { report(io, "mkdir", `cannot create directory '${arg}': No such file or directory`); break; }
      if (!report(io, "mkdir", await env.fs.mkdir(step))) break;
      if (flags.has("-v")) io.out += `mkdir: created directory '${step === path ? arg : step}'\n`;
    }
  }
}

async function touch(argv: readonly string[], io: CommandIo, env: ShellEnv): Promise<void> {
  if (!argv.length) { io.err += "touch: missing file operand\n"; io.status = 1; return; }
  for (const arg of argv) {
    const path = resolveShellPath(arg, io.cwd, env.home);
    if (env.fs.stat(path)) continue;
    if (!env.fs.stat(parentOf(path))?.dir) { report(io, "touch", `cannot touch '${arg}': No such file or directory`); continue; }
    report(io, "touch", await env.fs.touch(path));
  }
}

async function moveOrCopy(argv: readonly string[], io: CommandIo, env: ShellEnv, copy: boolean): Promise<void> {
  const name = copy ? "cp" : "mv";
  const { flags, args } = parseArgs(argv);
  if (args.length < 2) { io.err += `${name}: missing destination file operand\n`; io.status = 1; return; }
  const sources = args.slice(0, -1);
  const destArg = args[args.length - 1];
  const dest = resolveShellPath(destArg, io.cwd, env.home);
  const destEntry = env.fs.stat(dest);
  if (sources.length > 1 && !destEntry?.dir) { report(io, name, `target '${destArg}' is not a directory`); return; }
  for (const sourceArg of sources) {
    const source = resolveShellPath(sourceArg, io.cwd, env.home);
    const entry = env.fs.stat(source);
    if (!entry) { report(io, name, `cannot stat '${sourceArg}': No such file or directory`); continue; }
    if (copy && entry.dir && !flags.has("-r") && !flags.has("-R")) { report(io, name, `-r not specified; omitting directory '${sourceArg}'`); continue; }
    const target = destEntry?.dir ? join(dest, entry.name) : dest;
    if (target === source || target.startsWith(`${source}/`)) { report(io, name, `cannot ${name} '${sourceArg}' into itself`); continue; }
    if (!env.fs.stat(parentOf(target))?.dir) { report(io, name, `cannot ${name} to '${destArg}': No such file or directory`); continue; }
    if (env.fs.stat(target)) { report(io, name, `'${displayShellPath(target, env.home)}' already exists (this demo shell never overwrites)`); continue; }
    if (report(io, name, await (copy ? env.fs.copy(source, target) : env.fs.move(source, target))) && flags.has("-v")) {
      io.out += `'${sourceArg}' -> '${destEntry?.dir ? `${destArg.replace(/\/$/, "")}/${entry.name}` : destArg}'\n`;
    }
  }
}

async function rm(argv: readonly string[], io: CommandIo, env: ShellEnv): Promise<void> {
  const { flags, args } = parseArgs(argv);
  const force = flags.has("-f");
  const recursive = flags.has("-r") || flags.has("-R");
  if (!args.length && !force) { io.err += "rm: missing operand\n"; io.status = 1; return; }
  for (const arg of args) {
    const path = resolveShellPath(arg, io.cwd, env.home);
    const entry = env.fs.stat(path);
    if (!entry) { if (!force) report(io, "rm", `cannot remove '${arg}': No such file or directory`); continue; }
    if (path === "/" || path === env.home) { report(io, "rm", `refusing to remove '${arg}'`); continue; }
    if (entry.dir && !recursive && !(flags.has("-d") && (env.fs.list(path) ?? []).length === 0)) {
      report(io, "rm", `cannot remove '${arg}': Is a directory`);
      continue;
    }
    if (report(io, "rm", await env.fs.trash(path)) && flags.has("-v")) io.out += `removed '${arg}' (to the Recycle Bin)\n`;
  }
}

function relativeTime(seconds: number, now: number): string {
  const delta = Math.max(0, Math.round(now / 1000 - seconds));
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [size, unit] of units) {
    const n = Math.floor(delta / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function git(argv: readonly string[], io: CommandIo, env: ShellEnv, now: number): void {
  const repo = env.repoFor(io.cwd);
  if (!repo) { io.err += "fatal: not a git repository (or any of the parent directories): .git\n"; io.status = 128; return; }
  const [sub, ...rest] = argv;
  const decorate = (oid: string) => {
    const refs = repo.refs[oid];
    if (!refs?.length) return "";
    const head = refs.some((r) => r.kind === "Head");
    const names = refs.filter((r) => r.kind !== "Head").map((r) =>
      r.kind === "Tag" ? `${YELLOW}tag: ${r.name}` : r.kind === "RemoteBranch" ? `\x1b[31m${r.name}` : `${GREEN}${head && r.name === repo.branch ? `\x1b[1;36mHEAD -> ${GREEN}` : ""}${r.name}`);
    if (head && !refs.some((r) => r.name === repo.branch)) names.unshift("\x1b[1;36mHEAD");
    return ` ${YELLOW}(${names.join(`${YELLOW}, `)}${YELLOW})${RESET}`;
  };
  if (sub === "log") {
    const { flags, values } = parseArgs(rest, ["-n"]);
    const limit = Number.parseInt(values.get("-n") ?? "", 10);
    const commits = repo.commits.slice(0, Number.isFinite(limit) && limit > 0 ? limit : repo.commits.length);
    for (const c of commits) {
      if (flags.has("--oneline")) { io.out += `${YELLOW}${c.short_oid}${RESET}${decorate(c.oid)} ${c.summary}\n`; continue; }
      io.out += `${YELLOW}commit ${c.oid}${RESET}${decorate(c.oid)}\n`;
      if (c.parents.length > 1) io.out += `Merge: ${c.parents.map((p) => p.slice(0, 7)).join(" ")}\n`;
      io.out += `Author: ${c.author_name} <${c.author_email}>\nDate:   ${new Date(c.author_time * 1000).toString().slice(0, 24)} (${relativeTime(c.author_time, now)})\n\n`;
      io.out += `${c.message.replace(/\n+$/, "").split("\n").map((l) => `    ${l}`).join("\n")}\n\n`;
    }
    return;
  }
  if (sub === "status") {
    io.out += `On branch ${repo.branch ?? "(no branch)"}\n`;
    if (!repo.changes.length) { io.out += "nothing to commit, working tree clean\n"; return; }
    const tracked = repo.changes.filter((c) => c.status !== "Untracked");
    const untracked = repo.changes.filter((c) => c.status === "Untracked");
    if (tracked.length) {
      io.out += "Changes not staged for commit:\n";
      for (const c of tracked) io.out += `\t\x1b[31m${c.status.toLowerCase()}:   ${c.path}${RESET}\n`;
      io.out += "\n";
    }
    if (untracked.length) {
      io.out += "Untracked files:\n";
      for (const c of untracked) io.out += `\t\x1b[31m${c.path}${RESET}\n`;
      io.out += "\n";
    }
    return;
  }
  if (sub === "branch") {
    const names = [...new Set(Object.values(repo.refs).flat().filter((r) => r.kind === "LocalBranch").map((r) => r.name))].sort();
    for (const name of names) io.out += name === repo.branch ? `* ${GREEN}${name}${RESET}\n` : `  ${name}\n`;
    return;
  }
  io.err += sub ? `git: '${sub}' is not available in this demo (try log, status, branch)\n` : "usage: git (log [--oneline] [-n N] | status | branch)\n";
  io.status = 1;
}

export const SHELL_COMMANDS = [
  "cat", "cd", "clear", "cp", "echo", "exit", "find", "git", "grep", "head", "help", "history", "ls", "mkdir", "mv", "pwd", "rm", "tail", "touch", "tree", "whoami",
] as const;

const HELP = `Built-in commands (an in-memory demo shell over the fixture filesystem):
  ls [-a] [-A] [-l] [path…]    cd [dir|-|~]       pwd        whoami
  cat [-n] file…               head/tail [-n N] file…        tree [-a] [-d] [dir]
  find [path] [-name|-iname pattern] [-type f|d]
  grep [-r] [-i] [-n] [-l] [-c] pattern [path…]
  mkdir [-p] dir…   touch file…   mv src… dest   cp [-r] src… dest   rm [-r] [-f] path… (to the Recycle Bin)
  echo text [> file | >> file]  history   clear   git log [--oneline] [-n N] | status | branch
Separate commands with ; or &&. Tab completes, Up/Down recall history.
`;

/** Run one simple command (redirections already split off). */
export async function runCommand(argv: readonly string[], io: CommandIo, env: ShellEnv, now: number): Promise<void> {
  const [name, ...args] = argv;
  switch (name) {
    case "ls": return ls(args, io, env);
    case "cd": return cd(args, io, env);
    case "pwd": io.out += `${io.cwd}\n`; return;
    case "whoami": io.out += `${env.user}\n`; return;
    case "echo": {
      const newline = args[0] !== "-n";
      io.out += (newline ? args : args.slice(1)).join(" ") + (newline ? "\n" : "");
      return;
    }
    case "cat": return cat(args, io, env);
    case "head": return headTail(args, io, env, false);
    case "tail": return headTail(args, io, env, true);
    case "tree": return tree(args, io, env);
    case "find": return find(args, io, env);
    case "grep": return grep(args, io, env);
    case "mkdir": return mkdir(args, io, env);
    case "touch": return touch(args, io, env);
    case "mv": return moveOrCopy(args, io, env, false);
    case "cp": return moveOrCopy(args, io, env, true);
    case "rm": return rm(args, io, env);
    case "git": return git(args, io, env, now);
    case "clear": io.clear = true; return;
    case "help": io.out += HELP; return;
    case "history":
      env.history.forEach((line, index) => { io.out += `${String(index + 1).padStart(5)}  ${line}\n`; });
      return;
    case "exit": io.out += "This shell stays open; hide the panel with the terminal toggle.\n"; return;
    default:
      io.err += `${name}: command not found (type help)\n`;
      io.status = 127;
  }
}

export { baseOf as shellBasename, parentOf as shellParent };
