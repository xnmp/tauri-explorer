import { describe, expect, it } from "vitest";
import { createDemoShellSession, parseShellLine } from "$lib/domain/demo-shell";
import { resolveShellPath, runCommand, type CommandIo, type ShellEntry, type ShellEnv, type ShellFs } from "$lib/domain/demo-shell-commands";
import { convertDemoRepo } from "$lib/domain/demo-fixture-git";

const NOW = Date.UTC(2026, 9, 18, 12);
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** A small in-memory filesystem behind the shell's port; `gate` holds mutations until released. */
function memoryFs(files: Record<string, string | null>) {
  const nodes = new Map<string, string | null>(Object.entries(files)); // null = directory
  nodes.set("/", null);
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const trashed: string[] = [];
  let gate: Promise<void> | null = null;
  const entry = (path: string): ShellEntry => ({
    name: path.slice(path.lastIndexOf("/") + 1), path, dir: nodes.get(path) === null,
    size: nodes.get(path)?.length ?? 4096, modified: new Date(NOW).toISOString(),
  });
  const mutate = async (run: () => string | null) => { if (gate) await gate; return run(); };
  const fs: ShellFs = {
    stat: (path) => (nodes.has(path) ? entry(path) : null),
    list: (dir) => (nodes.get(dir) === null && nodes.has(dir)
      ? [...nodes.keys()].filter((p) => p !== "/" && parent(p) === dir).map(entry) : null),
    read: (path) => nodes.get(path) ?? null,
    mkdir: (path) => mutate(() => (nodes.has(path) ? "File exists" : (nodes.set(path, null), null))),
    touch: (path) => mutate(() => (nodes.has(path) ? null : (nodes.set(path, ""), null))),
    write: (path, text) => mutate(() => (nodes.set(path, text), null)),
    move: (from, to) => mutate(() => {
      for (const [p, v] of [...nodes]) if (p === from || p.startsWith(`${from}/`)) { nodes.delete(p); nodes.set(to + p.slice(from.length), v); }
      return null;
    }),
    copy: (from, to) => mutate(() => {
      for (const [p, v] of [...nodes]) if (p === from || p.startsWith(`${from}/`)) nodes.set(to + p.slice(from.length), v);
      return null;
    }),
    trash: (path) => mutate(() => {
      for (const p of [...nodes.keys()]) if (p === path || p.startsWith(`${path}/`)) nodes.delete(p);
      trashed.push(path);
      return null;
    }),
  };
  return {
    fs, nodes, trashed,
    hold() { let release!: () => void; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}

const tree = () => memoryFs({
  "/home": null,
  "/home/ines": null,
  "/home/ines/.bashrc": "alias ll='ls -l'",
  "/home/ines/Fieldwork": null,
  "/home/ines/Fieldwork/notes.md": "# Notes\nCount at dawn.\nNobody feeds the birds.",
  "/home/ines/Fieldwork/north pool.txt": "it's food.\ncount it.",
  "/home/ines/Fieldwork/daily": null,
  "/home/ines/Fieldwork/daily/2026-10-01.csv": "date,count\n2026-10-01,12",
  "/home/ines/Projects": null,
});

const repo = convertDemoRepo("/home/ines/Projects", {
  branch: "main",
  changes: [{ path: "notes.md", status: "Modified" }],
  commits: [
    { hash: "bbbbbbb", msg: "Second", author: "Ines", parents: ["aaaaaaa"], refs: ["HEAD -> main"] },
    { hash: "aaaaaaa", msg: "First", author: "Ines", parents: [] },
  ],
}, NOW, () => {})!;

function env(fs: ShellFs): ShellEnv {
  return { fs, home: "/home/ines", user: "ines", host: "marsh", columns: 80, history: [], repoFor: (p) => (p.startsWith("/home/ines/Projects") ? repo : null) };
}

async function run(line: string, fs: ShellFs, cwd = "/home/ines") {
  const argv = parseShellLine(line).segments[0].words.map((w) => w.text.replace(/^\0~/, "~"));
  const io: CommandIo = { cwd, previousCwd: cwd, out: "", err: "", status: 0, clear: false };
  await runCommand(argv, io, env(fs), NOW);
  return { ...io, out: strip(io.out), err: strip(io.err) };
}

describe("parseShellLine", () => {
  it("splits words with quotes, escapes, operators and redirects", () => {
    const { segments, error } = parseShellLine(`echo "a b" 'c d' e\\ f && cat x > out.txt; ls >> log`);
    expect(error).toBeNull();
    expect(segments.map((s) => s.words.map((w) => w.text))).toEqual([["echo", "a b", "c d", "e f"], ["cat", "x"], ["ls"]]);
    expect(segments.map((s) => s.op)).toEqual([null, "&&", ";"]);
    expect(segments[1].redirect).toEqual({ target: "out.txt", append: false });
    expect(segments[2].redirect).toEqual({ target: "log", append: true });
  });

  it("marks globs and a leading tilde", () => {
    const [segment] = parseShellLine("ls ~/F* a~b").segments;
    expect(segment.words[1]).toEqual({ text: "\0~/F*", glob: true });
    expect(segment.words[2].text).toBe("a~b");
  });

  it.each([
    [`echo "open`, /matching/],
    ["ls |", /pipes/],
    ["&& ls", /unexpected token/],
    ["echo >", /newline/],
  ])("rejects %j", (line, message) => {
    expect(parseShellLine(line).error).toMatch(message);
  });

  it("handles an empty or huge line", () => {
    expect(parseShellLine("").segments).toEqual([]);
    expect(parseShellLine("   ").segments).toEqual([]);
    expect(parseShellLine(`echo ${"x".repeat(100_000)}`).segments[0].words[1].text).toHaveLength(100_000);
  });
});

describe("shell commands", () => {
  it("resolves ~, . and .. against the working directory", () => {
    expect(resolveShellPath("~/Fieldwork/../Projects/.", "/", "/home/ines")).toBe("/home/ines/Projects");
    expect(resolveShellPath("../..", "/home/ines", "/home/ines")).toBe("/");
    expect(resolveShellPath("/../../etc", "/", "/home/ines")).toBe("/etc");
  });

  it("ls hides dot entries unless -a, and -l shows sizes", async () => {
    const { fs } = tree();
    expect((await run("ls", fs)).out).not.toContain(".bashrc");
    expect((await run("ls -a", fs)).out).toContain(".bashrc");
    const long = (await run("ls -l Fieldwork", fs)).out;
    expect(long).toMatch(/^d.*daily$/m);
    expect(long).toMatch(/^-.*\s46 .*notes\.md$/m);
    expect((await run("ls nowhere", fs))).toMatchObject({ status: 2, err: expect.stringMatching(/No such file/) });
  });

  it("cd changes directory, supports - and ~, and refuses files", async () => {
    const { fs } = tree();
    expect((await run("cd Fieldwork/daily", fs)).cwd).toBe("/home/ines/Fieldwork/daily");
    expect((await run("cd ~", fs, "/")).cwd).toBe("/home/ines");
    const back = await run("cd -", fs, "/home/ines");
    expect(back.cwd).toBe("/home/ines");
    expect((await run("cd Fieldwork/notes.md", fs))).toMatchObject({ status: 1, err: expect.stringMatching(/not a directory/i) });
  });

  it("cat, head and tail print file text", async () => {
    const { fs } = tree();
    expect((await run("cat Fieldwork/notes.md", fs)).out).toBe("# Notes\nCount at dawn.\nNobody feeds the birds.\n");
    expect((await run("head -n 1 Fieldwork/notes.md", fs)).out).toBe("# Notes\n");
    expect((await run("tail -1 Fieldwork/notes.md", fs)).out).toBe("Nobody feeds the birds.\n");
    expect((await run("cat Fieldwork", fs)).err).toMatch(/Is a directory/);
  });

  it("grep searches recursively, case-insensitively, with line numbers", async () => {
    const { fs } = tree();
    const found = await run("grep -rin nobody Fieldwork", fs);
    expect(found.out).toBe("Fieldwork/notes.md:3:Nobody feeds the birds.\n");
    expect((await run("grep -rl count .", fs)).out.split("\n").filter(Boolean).sort())
      .toEqual(["./Fieldwork/daily/2026-10-01.csv", "./Fieldwork/north pool.txt"]);
    expect((await run("grep -ril count .", fs)).out).toContain("./Fieldwork/notes.md");
    expect((await run("grep absent Fieldwork/notes.md", fs)).status).toBe(1);
    // An invalid pattern is searched literally rather than crashing.
    expect((await run("grep ( Fieldwork/notes.md", fs)).status).toBe(1);
  });

  it("find and tree walk the fixture", async () => {
    const { fs } = tree();
    expect((await run("find . -name *.csv", fs)).out).toBe("./Fieldwork/daily/2026-10-01.csv\n");
    expect((await run("tree -d Fieldwork", fs)).out).toMatch(/daily/);
  });

  it("mkdir, touch, mv, cp and rm change the filesystem through the port", async () => {
    const t = tree();
    await run("mkdir -p a/b", t.fs);
    expect(t.nodes.get("/home/ines/a/b")).toBeNull();
    await run("touch a/new.txt", t.fs);
    expect(t.nodes.get("/home/ines/a/new.txt")).toBe("");
    await run("mv a/new.txt a/b", t.fs);
    expect(t.nodes.has("/home/ines/a/b/new.txt")).toBe(true);
    await run("cp -r a c", t.fs);
    expect(t.nodes.has("/home/ines/c/b/new.txt")).toBe(true);
    expect((await run("rm c", t.fs)).err).toMatch(/Is a directory/);
    await run("rm -r c", t.fs);
    expect(t.trashed).toEqual(["/home/ines/c"]);
    expect((await run("rm -rf /", t.fs)).status).toBe(1);
    expect((await run("rm -rf ~", t.fs)).status).toBe(1);
  });

  it("refuses to overwrite with mv or cp", async () => {
    const t = tree();
    const moved = await run("mv Fieldwork/notes.md 'Fieldwork/north pool.txt'", t.fs);
    expect(moved.status).toBe(1);
    expect(t.nodes.get("/home/ines/Fieldwork/north pool.txt")).toBe("it's food.\ncount it.");
  });

  it("git log and status read the repository owning the directory", async () => {
    const { fs } = tree();
    expect((await run("git log --oneline", fs, "/home/ines/Projects")).out).toBe("bbbbbbb (HEAD -> main) Second\naaaaaaa First\n");
    expect((await run("git status", fs, "/home/ines/Projects")).out).toMatch(/On branch main[\s\S]*modified:\s+notes\.md/);
    expect((await run("git log", fs, "/home/ines")).err).toMatch(/not a git repository/);
  });

  it("reports unknown commands like a shell", async () => {
    const { fs } = tree();
    expect(await run("vim notes.md", fs)).toMatchObject({ status: 127, err: expect.stringMatching(/^vim: command not found/) });
  });
});

function session(fs: ShellFs, cwd = "/home/ines") {
  let output = "";
  const cwds: string[] = [];
  const shell = createDemoShellSession({
    env: { fs, home: "/home/ines", user: "ines", host: "marsh", repoFor: () => null },
    cwd, columns: 80, now: () => NOW,
    write: (text) => { output += text; },
    cwdChanged: (next) => cwds.push(next),
  });
  shell.start();
  return {
    shell, cwds,
    get screen() { return strip(output); },
    take() { const text = strip(output); output = ""; return text; },
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("demo shell session", () => {
  it("prints a prompt with the home-relative cwd and runs a line", async () => {
    const s = session(tree().fs, "/home/ines/Fieldwork");
    expect(s.take()).toBe("ines@marsh:~/Fieldwork$ ");
    s.shell.input("cat notes.md\r");
    await settle();
    expect(s.take()).toContain("Nobody feeds the birds.\r\nines@marsh:~/Fieldwork$ ");
  });

  it("reports cd as a cwd change (what OSC 7 does natively)", async () => {
    const s = session(tree().fs);
    s.shell.input("cd Fieldwork && pwd\r");
    await settle();
    expect(s.cwds).toEqual(["/home/ines/Fieldwork"]);
    expect(s.shell.status()).toEqual({ busy: false, cwd: "/home/ines/Fieldwork" });
    expect(s.screen).toContain("/home/ines/Fieldwork\r\n");
  });

  it("accepts the app's injected cd line (Ctrl+U then a quoted cd)", async () => {
    const s = session(tree().fs);
    s.shell.input("half-typed");
    s.shell.input("\x15cd '/home/ines/Fieldwork/daily'\r");
    await settle();
    expect(s.cwds).toEqual(["/home/ines/Fieldwork/daily"]);
  });

  it("edits the line with arrows, Home/End, word and kill keys", async () => {
    const s = session(tree().fs);
    s.shell.input("echo wrld\x1b[D\x1b[D\x1b[Do\x1b[F!\x01\x1b[3~E");
    s.shell.input("\r");
    await settle();
    // "echo wrld" → insert "o" three left → End "!" → Home, Delete, "E" = "Echo world!".
    expect(s.screen).toContain("Echo world!\r\nEcho: command not found");
    s.take();
    s.shell.input("echo one two\x17three\r");
    await settle();
    expect(s.take()).toContain("one three\r\n");
    s.shell.input("echo gone\x15echo kept\r");
    await settle();
    expect(s.take()).toContain("\r\nkept\r\n");
  });

  it("recalls history with Up/Down and keeps the draft", async () => {
    const s = session(tree().fs);
    s.shell.input("echo first\r");
    await settle();
    s.shell.input("echo second\r");
    await settle();
    s.take();
    s.shell.input("dra\x1b[A\x1b[A\x1b[B\x1b[B\r");
    await settle();
    expect(s.take()).toContain("dra: command not found");
    s.shell.input("\x1b[A\x1b[A\x1b[A\r");
    await settle();
    expect(s.take()).toContain("\r\nfirst\r\n");
  });

  it("completes commands and paths with Tab, escaping spaces", async () => {
    const s = session(tree().fs);
    s.shell.input("gre\t");
    s.shell.input("-i count Fieldwork/no\t");
    s.shell.input("\x15cat Fieldwork/nor\t\r");
    await settle();
    expect(s.screen).toContain("grep ");
    expect(s.screen).toContain("cat Fieldwork/north\\ pool.txt");
    expect(s.screen).toContain("it's food.");
    s.take();
    s.shell.input("ls Fieldwork/n\t");
    await settle();
    expect(s.take()).toContain("ls Fieldwork/no"); // ambiguous: completes the shared prefix
    s.shell.input("\t");
    await settle();
    expect(s.take()).toMatch(/north pool\.txt\s+notes\.md/); // then lists the candidates
  });

  it("buffers typeahead while a command is running", async () => {
    const t = tree();
    const s = session(t.fs);
    const release = t.hold();
    s.shell.input("mkdir slow\r");
    await settle();
    expect(s.shell.status().busy).toBe(true);
    s.shell.input("ls\r");
    await settle();
    expect(s.screen).not.toContain("slow  ");
    release();
    await settle();
    expect(s.shell.status().busy).toBe(false);
    expect(s.screen).toMatch(/\$ ls\r\n.*slow/s);
  });

  it("writes redirected output to files without colour codes", async () => {
    const t = tree();
    const s = session(t.fs);
    s.shell.input("echo hello > out.txt; echo again >> out.txt; ls --color > list.txt\r");
    await settle();
    expect(t.nodes.get("/home/ines/out.txt")).toBe("hello\nagain\n");
    expect(t.nodes.get("/home/ines/list.txt")).not.toMatch(/\x1b/);
  });

  it("expands globs and survives a huge paste", async () => {
    const s = session(tree().fs, "/home/ines/Fieldwork");
    s.shell.input("echo *.md\r");
    await settle();
    expect(s.take()).toContain("\r\nnotes.md\r\n");
    s.shell.input(`echo ${"y".repeat(50_000)}\r`);
    await settle();
    expect(s.shell.status().busy).toBe(false);
  });
});

describe("quoting and escaping (review F)", () => {
  it.each([
    [`echo "a\\"b"`, ["echo", 'a"b']],
    [`echo "back\\\\slash"`, ["echo", "back\\slash"]],
    [`echo "keep \\n literal"`, ["echo", "keep \\n literal"]],
    [`echo 'single \\" stays'`, ["echo", 'single \\" stays']],
    [`echo "mixed"'quotes'and\\ more`, ["echo", "mixedquotesand more"]],
    [`echo ""`, ["echo", ""]],
  ])("%s", (line, words) => {
    const { segments, error } = parseShellLine(line);
    expect(error).toBeNull();
    expect(segments[0].words.map((w) => w.text)).toEqual(words);
  });

  it("still rejects an unterminated double quote that ends in an escape", () => {
    expect(parseShellLine(`echo "open\\"`).error).toMatch(/matching/);
  });
});
