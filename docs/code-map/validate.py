#!/usr/bin/env python3
"""Keep the code maps honest. Two independent guards:

  1. REFERENCES  — every file a map names must still exist (catches moved/deleted files).
  2. COVERAGE    — every source file must appear in map-folder.md (catches new files
                   nobody mapped).  Enable with --coverage.

A map that confidently names a file that moved is worse than no map at all: agents
trust it and search the wrong place.  Both guards run in CI (.github/workflows/ci.yml).

Usage:
  python3 docs/code-map/validate.py [--coverage] [map-file.md ...]

Exit 1 if any guard fails.  See README.md 'Maintenance'.
"""
import os, re, subprocess, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FOLDER_MAP = "map-folder.md"

# Source trees the folder map is expected to cover exhaustively.
SOURCE_ROOTS = ("src/", "src-tauri/src/")
SOURCE_EXTS = (".ts", ".svelte", ".rs", ".css")

ls = subprocess.run(["git", "-C", REPO, "ls-files"], capture_output=True, text=True).stdout.split()
allfiles = set(ls)
basenames = {os.path.basename(p) for p in ls}

TOKEN = re.compile(r"`([^`\s]+?\.(?:ts|svelte|rs|css|md|html))`")
PLACEHOLDER = re.compile(r"[*{<]")  # globs / brace lists / <module> placeholders are not checked
SECTION = re.compile(r"^#{2,3}\s+(\S+/)")  # '## src/lib/state/ — ...' -> 'src/lib/state/'


def resolves(tok):
    t = tok.lstrip("./")
    if t in allfiles or os.path.exists(os.path.join(REPO, t)):
        return True
    if "/" not in t:
        return t in basenames
    for prefix in ("src/lib/", "src/", "src-tauri/src/", "src/routes/", "docs/"):
        if prefix + t in allfiles:
            return True
    return any(p.endswith("/" + t) for p in allfiles)


def mapped_paths(text, sources):
    """Resolve the folder map's entries to real paths.

    Entries appear under a '## <dir>/' section header, either as a bare basename
    (`FileList.svelte`) or with a subpath (`ai-organize/index.ts`). A bare basename
    counts for a file at any depth under that section — the map groups plugin dialogs
    under `## src/lib/plugins/` without repeating the subdirectory.
    """
    covered, section = set(), None
    for line in text.splitlines():
        m = SECTION.match(line)
        if m:
            section = m.group(1)
            continue
        for tok in TOKEN.findall(line):
            if PLACEHOLDER.search(tok) or tok.startswith("."):
                continue
            tok = tok.lstrip("./")
            covered.add(tok)
            if section:
                covered.add(section + tok)
                if "/" not in tok:
                    covered.update(
                        p for p in sources
                        if p.startswith(section) and os.path.basename(p) == tok
                    )
    return covered


def source_files():
    return sorted(
        p for p in allfiles
        if p.startswith(SOURCE_ROOTS) and p.endswith(SOURCE_EXTS)
    )


want_coverage = "--coverage" in sys.argv
argv = [a for a in sys.argv[1:] if not a.startswith("--")]
targets = argv or sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "map-*.md")))

failures = 0

# Guard 1: references resolve.
for name in targets:
    text = open(os.path.join(HERE, name)).read()
    toks = sorted({t for t in TOKEN.findall(text) if not PLACEHOLDER.search(t) and not t.startswith(".")})
    bad = [t for t in toks if not resolves(t)]
    print(f"{name}: ~{len(text) // 4} tokens, {len(toks)} file refs, {len(bad)} unresolvable")
    for b in bad:
        print(f"   MISSING: {b}  (referenced but not in the tree — update the map)")
    failures += len(bad)

# Guard 2: the folder map covers every source file.
if want_coverage:
    fm = os.path.join(HERE, FOLDER_MAP)
    if not os.path.exists(fm):
        print(f"COVERAGE: {FOLDER_MAP} missing — cannot verify coverage")
        sys.exit(1)
    srcs = source_files()
    covered = mapped_paths(open(fm).read(), srcs)
    missing = [p for p in srcs if p not in covered]
    print(f"coverage: {len(srcs) - len(missing)}/{len(srcs)} source files in {FOLDER_MAP}")
    for p in missing:
        print(f"   UNMAPPED: {p}  (new file — add a line to {FOLDER_MAP}, and to map-feature.md if it belongs to a feature)")
    failures += len(missing)

sys.exit(1 if failures else 0)
