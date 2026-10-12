#!/usr/bin/env python3
"""Hosted-runner kernel pipe sink; resolves paths outside WebKit's sandbox.

Retire-when: #1102 has a diagnosed native renderer-loss cause.
"""
import json
import os
from pathlib import Path
import re
import sys


def capture(directory, task, pid, epoch, stream, limit=1024 * 1024 * 1024):
    if task not in ("WebKitWebProces", "tauri-explorer", "tauri-core-test"):
        return
    if not re.fullmatch(r"[0-9]+", pid) or not re.fullmatch(r"[0-9]+", epoch):
        raise ValueError("Invalid kernel crash identity")
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"core-{task}-{pid}-{epoch}"
    # Refuse existing paths, including symlinks; publish only after stdin ends.
    pending = target.with_name(target.name + ".pending")
    descriptor = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    os.fchmod(descriptor, 0o644)
    size = 0
    truncated = False
    with os.fdopen(descriptor, "wb") as output:
        while True:
            chunk = stream.read(min(1024 * 1024, limit - size + 1))
            if not chunk:
                break
            remaining = limit - size
            output.write(chunk[:remaining])
            size += min(len(chunk), remaining)
            if len(chunk) > remaining:
                truncated = True
                break
    # Hard-link publication is exclusive too: never overwrite an earlier core.
    os.link(pending, target)
    metadata = target.with_name(target.name + ".capture.json")
    metadata.write_text(json.dumps({
        "task": task, "pid": pid, "epoch": epoch, "bytes": size, "truncated": truncated,
    }) + "\n")
    metadata.chmod(0o644)
    # The pending marker owns BOTH the core and metadata publication.
    pending.unlink()


if __name__ == "__main__":
    capture(*sys.argv[1:5], sys.stdin.buffer)
