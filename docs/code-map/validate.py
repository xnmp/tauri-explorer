#!/usr/bin/env python3
"""Validate that every file referenced in the code maps still exists.

Usage: python3 docs/code-map/validate.py [map-file.md ...]   (default: all map-*.md here)
Exit code 1 if any reference is unresolvable. See README.md 'Maintenance'.
"""
import os, re, subprocess, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
ls = subprocess.run(["git", "-C", REPO, "ls-files"], capture_output=True, text=True).stdout.split()
allfiles = set(ls)
basenames = {os.path.basename(p) for p in ls}

TOKEN = re.compile(r"`([^`\s]+?\.(?:ts|svelte|rs|css|md|html))`")
PLACEHOLDER = re.compile(r"[*{<]")  # globs / brace lists / <module> placeholders are not checked

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

targets = sys.argv[1:] or sorted(os.path.basename(p) for p in glob.glob(os.path.join(HERE, "map-*.md")))
total_bad = 0
for name in targets:
    text = open(os.path.join(HERE, name)).read()
    toks = sorted({t for t in TOKEN.findall(text) if not PLACEHOLDER.search(t) and not t.startswith(".")})
    bad = [t for t in toks if not resolves(t)]
    print(f"{name}: ~{len(text)//4} tokens, {len(toks)} file refs, {len(bad)} unresolvable")
    for b in bad:
        print(f"   MISSING: {b}")
    total_bad += len(bad)
sys.exit(1 if total_bad else 0)
