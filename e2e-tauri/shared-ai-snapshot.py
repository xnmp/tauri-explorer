#!/usr/bin/env python3
"""Bound a dirty source snapshot without printing file contents or secrets."""
import datetime, hashlib, json, pathlib, subprocess, sys
root = pathlib.Path.cwd()
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split(b'\0')
entries = []
for raw in sorted(set(paths)):
    if not raw:
        continue
    name = raw.decode()
    # Build inputs only; omit unrelated website/evidence and generated outputs.
    if not (name.startswith(('src/', 'src-tauri/', 'crates/', 'vendor/', 'integration/', 'plugins/image-generation/backend/', 'plugins/image-generation/frontend/')) or name in ('package.json', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'plugin.json', 'svelte.config.js', 'tsconfig.json') or name.startswith(('vite.', 'vite.config', 'vite.image-generation.'))):
        continue
    path = root / name
    if path.is_file() and not path.is_symlink():
        entries.append([name, hashlib.sha256(path.read_bytes()).hexdigest()])
record = {'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'root':str(root), 'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'dirty':bool(subprocess.check_output(['git','status','--porcelain=v1'],text=True).strip()), 'buildInputsSha256':hashlib.sha256(json.dumps(entries,separators=(',',':')).encode()).hexdigest(), 'files':entries}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record,indent=2)+'\n')
