/**
 * The site demo's in-memory shell session: what sits behind the mock PTY so
 * the real terminal panel is usable on the marketing site. It consumes the
 * bytes xterm.js sends (keys, control codes, escape sequences, pastes and the
 * app's injected `cd` lines), edits the line, keeps history, completes with
 * Tab, parses words/quotes/`;`/`&&`/`>`/`>>`, and runs the commands in
 * `demo-shell-commands.ts`. Like an interactive shell it reports busy while a
 * command runs and buffers typeahead until the prompt returns.
 * Pure and framework-free: the filesystem and terminal are injected.
 */
import {
  BOLD_BLUE,
  columnize,
  displayShellPath,
  globMatch,
  resolveShellPath,
  runCommand,
  SHELL_COMMANDS,
  type CommandIo,
  type ShellEntry,
  type ShellEnv,
} from "./demo-shell-commands";

export interface DemoShellOptions {
  env: Omit<ShellEnv, "columns" | "history">;
  cwd: string;
  columns?: number;
  now(): number;
  /** Terminal output (CRLF line endings, ANSI colours). */
  write(text: string): void;
  /** The shell's working directory changed (what OSC 7 reports natively). */
  cwdChanged(cwd: string): void;
}

export interface DemoShellSession {
  start(): void;
  input(data: string): void;
  resize(columns: number): void;
  status(): { busy: boolean; cwd: string };
}

interface Word { text: string; glob: boolean }
interface Segment { words: Word[]; redirect: { target: string; append: boolean } | null; op: ";" | "&&" | "||" | null }

const GREEN = "\x1b[1;32m";
const RESET = "\x1b[0m";
const MAX_HISTORY = 500;

/** POSIX single quotes: everything up to the next `'` is literal. */
function singleQuoted(line: string, open: number): { text: string; end: number } | null {
  const end = line.indexOf("'", open + 1);
  return end < 0 ? null : { text: line.slice(open + 1, end), end };
}

/** POSIX double quotes: a backslash escapes only `"`, `\`, `$` and a backtick; other backslashes stay. */
function doubleQuoted(line: string, open: number): { text: string; end: number } | null {
  let text = "";
  for (let i = open + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') return { text, end: i };
    if (ch === "\\" && i + 1 < line.length && `"\\$\``.includes(line[i + 1])) text += line[++i];
    else text += ch;
  }
  return null;
}

/** Split a command line into segments; null plus a message on a syntax error. */
export function parseShellLine(line: string): { segments: Segment[]; error: string | null } {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let redirect: Segment["redirect"] = null;
  let pendingRedirect: boolean | null = null;
  let op: Segment["op"] = null;
  let current = null as Word | null;
  const finishWord = () => {
    if (!current) return;
    if (pendingRedirect !== null) {
      redirect = { target: current.text, append: pendingRedirect };
      pendingRedirect = null;
    } else words.push(current);
    current = null;
  };
  const finishSegment = (nextOp: Segment["op"]) => {
    finishWord();
    if (pendingRedirect !== null) return "syntax error near unexpected token `newline'";
    if (words.length || redirect) segments.push({ words, redirect, op });
    else if (nextOp) return `syntax error near unexpected token \`${nextOp}'`;
    words = [];
    redirect = null;
    op = nextOp;
    return null;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quoted = ch === "'" ? singleQuoted(line, i) : doubleQuoted(line, i);
      if (!quoted) return { segments: [], error: `unexpected EOF while looking for matching \`${ch}'` };
      current = { text: (current?.text ?? "") + quoted.text, glob: current?.glob ?? false };
      i = quoted.end;
    } else if (ch === "\\" && i + 1 < line.length) {
      current = { text: (current?.text ?? "") + line[++i], glob: current?.glob ?? false };
    } else if (ch === " " || ch === "\t") {
      finishWord();
    } else if (ch === ";" || (ch === "&" && line[i + 1] === "&") || (ch === "|" && line[i + 1] === "|")) {
      const nextOp = ch === ";" ? ";" : ch === "&" ? "&&" : "||";
      if (nextOp !== ";") i++;
      const error = finishSegment(nextOp);
      if (error) return { segments: [], error };
    } else if (ch === "|") {
      return { segments: [], error: "pipes are not supported in this demo shell" };
    } else if (ch === ">") {
      finishWord();
      pendingRedirect = line[i + 1] === ">";
      if (pendingRedirect) i++;
    } else {
      const startsWord: boolean = current === null;
      const tilde: boolean = startsWord && ch === "~" && (i + 1 === line.length || /[\s/;]/.test(line[i + 1]));
      current = { text: (current?.text ?? "") + (tilde ? "\0~" : ch), glob: (current?.glob ?? false) || ch === "*" || ch === "?" };
    }
  }
  const error = finishSegment(null);
  return error ? { segments: [], error } : { segments, error: null };
}

/** Longest common prefix of `names`. */
function commonPrefix(names: readonly string[]): string {
  if (!names.length) return "";
  let prefix = names[0];
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

export function createDemoShellSession(options: DemoShellOptions): DemoShellSession {
  const { env } = options;
  let cwd = options.cwd;
  let previousCwd = options.cwd;
  let columns = options.columns && options.columns > 0 ? options.columns : 80;
  let buffer = "";
  let cursor = 0;
  const history: string[] = [];
  let historyIndex: number | null = null;
  let draft = "";
  let busy = false;
  let pending = "";

  const write = (text: string) => options.write(text.replace(/\r?\n/g, "\r\n"));
  const prompt = () => `${GREEN}${env.user}@${env.host}${RESET}:${BOLD_BLUE}${displayShellPath(cwd, env.home)}${RESET}$ `;
  const redraw = () => {
    const back = buffer.length - cursor;
    options.write(`\r\x1b[K${prompt()}${buffer}${back > 0 ? `\x1b[${back}D` : ""}`);
  };
  const setLine = (text: string, at = text.length) => { buffer = text; cursor = at; redraw(); };
  const insert = (text: string) => setLine(buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor + text.length);

  const wordStart = (from: number) => {
    let i = from;
    while (i > 0 && buffer[i - 1] === " ") i--;
    while (i > 0 && buffer[i - 1] !== " ") i--;
    return i;
  };
  const wordEnd = (from: number) => {
    let i = from;
    while (i < buffer.length && buffer[i] === " ") i++;
    while (i < buffer.length && buffer[i] !== " ") i++;
    return i;
  };

  function expandWord(word: Word): string[] {
    const text = word.text.startsWith("\0~") ? env.home + word.text.slice(2) : word.text;
    if (!word.glob) return [text];
    const slash = text.lastIndexOf("/");
    const dirPart = slash >= 0 ? text.slice(0, slash + 1) : "";
    const pattern = text.slice(slash + 1);
    const dir = resolveShellPath(dirPart || ".", cwd, env.home);
    const matches = (env.fs.list(dir) ?? [])
      .filter((e) => (pattern.startsWith(".") || !e.name.startsWith(".")) && globMatch(pattern, e.name))
      .map((e) => dirPart + e.name)
      .sort();
    return matches.length ? matches : [text];
  }

  async function runLine(line: string): Promise<void> {
    const parsed = parseShellLine(line);
    if (parsed.error) { write(`shell: ${parsed.error}\n`); return; }
    let status = 0;
    for (const segment of parsed.segments) {
      if ((segment.op === "&&" && status !== 0) || (segment.op === "||" && status === 0)) continue;
      const argv = segment.words.flatMap(expandWord);
      const io: CommandIo = { cwd, previousCwd, out: "", err: "", status: 0, clear: false };
      if (argv.length) await runCommand(argv, io, { ...env, columns, history }, options.now());
      if (io.clear) options.write("\x1b[2J\x1b[3J\x1b[H");
      if (segment.redirect) {
        const target = resolveShellPath(segment.redirect.target.replace(/^\0~/, "~"), io.cwd, env.home);
        const existing = segment.redirect.append ? env.fs.read(target) ?? "" : "";
        const plain = io.out.replace(/\x1b\[[0-9;]*m/g, "");
        const targetEntry = env.fs.stat(target);
        const error = targetEntry?.dir ? "Is a directory" : await env.fs.write(target, existing + plain);
        if (error) { io.err += `shell: ${segment.redirect.target}: ${error}\n`; io.status = 1; }
      } else if (io.out) write(io.out);
      if (io.err) write(io.err);
      status = io.status;
      previousCwd = io.previousCwd;
      if (io.cwd !== cwd) {
        cwd = io.cwd;
        options.cwdChanged(cwd);
      }
    }
  }

  function complete(): void {
    const start = wordStart(cursor);
    const word = buffer.slice(start, cursor);
    const before = buffer.slice(0, start).trimEnd();
    const commandPosition = before === "" || /(;|&&|\|\|)$/.test(before);
    if (commandPosition && !word.includes("/")) {
      const names = SHELL_COMMANDS.filter((c) => c.startsWith(word));
      if (names.length === 1) insert(`${names[0].slice(word.length)} `);
      else if (names.length > 1) offer(names.map((name) => ({ name, path: name, dir: false, size: 0, modified: "" })), word);
      return;
    }
    const raw = word.replace(/\\ /g, " ");
    const slash = raw.lastIndexOf("/");
    const dirPart = slash >= 0 ? raw.slice(0, slash + 1) : "";
    const prefix = raw.slice(slash + 1);
    const candidates = (env.fs.list(resolveShellPath(dirPart || ".", cwd, env.home)) ?? [])
      .filter((e) => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (candidates.length === 1) {
      const only = candidates[0];
      insert(only.name.slice(prefix.length).replace(/ /g, "\\ ") + (only.dir ? "/" : " "));
    } else if (candidates.length > 1) {
      offer(candidates, prefix);
    }
  }

  function offer(candidates: ShellEntry[], prefix: string): void {
    const shared = commonPrefix(candidates.map((c) => c.name));
    if (shared.length > prefix.length) { insert(shared.slice(prefix.length).replace(/ /g, "\\ ")); return; }
    write(`\n${columnize(candidates, columns)}`);
    redraw();
  }

  function recall(step: -1 | 1): void {
    if (!history.length) return;
    if (historyIndex === null) {
      if (step > 0) return;
      draft = buffer;
      historyIndex = history.length - 1;
    } else {
      historyIndex += step;
      if (historyIndex < 0) historyIndex = 0;
      if (historyIndex >= history.length) {
        historyIndex = null;
        setLine(draft);
        return;
      }
    }
    setLine(history[historyIndex]);
  }

  async function submit(): Promise<void> {
    const line = buffer;
    options.write("\r\n");
    buffer = "";
    cursor = 0;
    historyIndex = null;
    if (line.trim()) {
      if (history.at(-1) !== line) history.push(line);
      if (history.length > MAX_HISTORY) history.shift();
      busy = true;
      try {
        await runLine(line);
      } catch (error) {
        write(`shell: ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        busy = false;
      }
    }
    options.write(prompt());
  }

  /** Length of the escape sequence at `data[i]` (an ESC), and its action. */
  function escape(data: string, i: number): number {
    const next = data[i + 1];
    if (next === "[" || next === "O") {
      let end = i + 2;
      while (end < data.length && !/[@-~]/.test(data[end])) end++;
      const seq = data.slice(i + 2, end + 1);
      switch (seq) {
        case "A": recall(-1); break;
        case "B": recall(1); break;
        case "C": if (cursor < buffer.length) { cursor++; options.write("\x1b[C"); } break;
        case "D": if (cursor > 0) { cursor--; options.write("\x1b[D"); } break;
        case "H": case "1~": case "7~": setLine(buffer, 0); break;
        case "F": case "4~": case "8~": setLine(buffer, buffer.length); break;
        case "3~": if (cursor < buffer.length) setLine(buffer.slice(0, cursor) + buffer.slice(cursor + 1), cursor); break;
        case "1;5D": case "1;3D": setLine(buffer, wordStart(cursor)); break;
        case "1;5C": case "1;3C": setLine(buffer, wordEnd(cursor)); break;
        default: break; // bracketed paste markers and other sequences carry no line edit
      }
      return end - i + 1;
    }
    if (next === "b") { setLine(buffer, wordStart(cursor)); return 2; }
    if (next === "f") { setLine(buffer, wordEnd(cursor)); return 2; }
    if (next === "\x7f" || next === "\b") {
      const start = wordStart(cursor);
      setLine(buffer.slice(0, start) + buffer.slice(cursor), start);
      return 2;
    }
    if (next === "d") {
      const end = wordEnd(cursor);
      setLine(buffer.slice(0, cursor) + buffer.slice(end), cursor);
      return 2;
    }
    return next === undefined ? 1 : 2;
  }

  async function process(data: string): Promise<void> {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && data[i + 1] === "\n") i++;
        i++;
        await submit();
        continue;
      }
      switch (ch) {
        case "\x1b": i += escape(data, i); continue;
        case "\x7f": case "\b":
          if (cursor > 0) setLine(buffer.slice(0, cursor - 1) + buffer.slice(cursor), cursor - 1);
          break;
        case "\t": complete(); break;
        case "\x03":
          options.write("^C\r\n");
          buffer = ""; cursor = 0; historyIndex = null;
          options.write(prompt());
          break;
        case "\x0c": options.write("\x1b[2J\x1b[3J\x1b[H"); redraw(); break;
        case "\x15": setLine(buffer.slice(cursor), 0); break;
        case "\x0b": setLine(buffer.slice(0, cursor), cursor); break;
        case "\x01": setLine(buffer, 0); break;
        case "\x05": setLine(buffer, buffer.length); break;
        case "\x02": if (cursor > 0) setLine(buffer, cursor - 1); break;
        case "\x06": if (cursor < buffer.length) setLine(buffer, cursor + 1); break;
        case "\x04": if (cursor < buffer.length) setLine(buffer.slice(0, cursor) + buffer.slice(cursor + 1), cursor); break;
        case "\x17": {
          const start = wordStart(cursor);
          setLine(buffer.slice(0, start) + buffer.slice(cursor), start);
          break;
        }
        case "\x10": recall(-1); break;
        case "\x0e": recall(1); break;
        default: {
          let end = i;
          while (end < data.length && data[end] >= " " && data[end] !== "\x7f") end++;
          if (end > i) { insert(data.slice(i, end)); i = end; continue; }
        }
      }
      i++;
    }
  }

  // Input arriving while a command runs is typeahead for the next prompt.
  let drain: Promise<void> = Promise.resolve();
  function input(data: string): void {
    pending += data;
    if (busy) return;
    drain = drain.then(async () => {
      while (pending) {
        const chunk = pending;
        pending = "";
        await process(chunk);
      }
    });
  }

  return {
    start() { options.write(prompt()); },
    input,
    resize(next) { if (next > 0) columns = next; },
    status: () => ({ busy, cwd }),
  };
}
