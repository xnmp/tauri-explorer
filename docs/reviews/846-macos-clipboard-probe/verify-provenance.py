#!/usr/bin/env python3
"""Fail closed on dependency or imported-production-source drift."""
import hashlib
from pathlib import Path
import re
import subprocess
import tomllib

PROBE = Path(__file__).resolve().parent
REPO = PROBE.parents[2]
APP_LOCK = REPO / "src-tauri/Cargo.lock"
PROBE_LOCK = PROBE / "Cargo.lock"
CRITICAL = ("clipboard-rs", "objc2", "objc2-foundation", "objc2-app-kit", "serde", "thiserror", "tempfile")


def packages(path):
    return tomllib.loads(path.read_text())["package"]


def identity(package):
    return tuple(package.get(key) for key in ("name", "version", "source", "checksum"))


app = packages(APP_LOCK)
probe = packages(PROBE_LOCK)
app_ids = {identity(package) for package in app}
for package in probe:
    if package["name"] != "native-macos-clipboard-probe":
        assert identity(package) in app_ids, f"Dependency differs from app lock: {identity(package)}"

app_dependencies = next(package for package in app if package["name"] == "tauri-explorer")["dependencies"]
for name in CRITICAL:
    dependency = next(item for item in app_dependencies if item.split()[0] == name)
    explicit_version = dependency.split()[1:2]
    app_versions = {package["version"] for package in app if package["name"] == name and (not explicit_version or package["version"] == explicit_version[0])}
    probe_versions = {package["version"] for package in probe if package["name"] == name}
    assert app_versions == probe_versions and len(app_versions) == 1, f"Critical dependency drift: {name}: app={app_versions}, probe={probe_versions}"
    print(f"dependency {name}={next(iter(app_versions))}")

bindings = {
    PROBE / "src/lib.rs": [REPO / "src-tauri/src/error.rs"],
    PROBE / "src/clipboard/mod.rs": [REPO / "src-tauri/src/clipboard" / name for name in ("backend.rs", "change_counter.rs", "macos.rs")],
}
for wrapper, expected in bindings.items():
    text = wrapper.read_text()
    imported = [(wrapper.parent / value).resolve() for value in re.findall(r'#\[path = "([^"]+)"\]', text)]
    assert imported == expected, f"Production module bindings changed: {wrapper}: {imported}"
    assert "#[test]" not in text, f"Probe must invoke the existing production fixture: {wrapper}"

inputs = [Path(__file__).resolve(), PROBE / "run-probe.sh", REPO / ".github/workflows/macos-clipboard-probe.yml", APP_LOCK, PROBE_LOCK, REPO / "src-tauri/Cargo.toml", PROBE / "Cargo.toml", *bindings, *(path for paths in bindings.values() for path in paths)]
relative_inputs = [str(path.relative_to(REPO)) for path in inputs]
subprocess.run(["git", "ls-files", "--error-unmatch", "--", *relative_inputs], cwd=REPO, check=True, stdout=subprocess.DEVNULL)
subprocess.run(["git", "diff", "--exit-code", "HEAD", "--", *relative_inputs], cwd=REPO, check=True)
print("checkout", subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip())
for path in inputs:
    print("sha256", hashlib.sha256(path.read_bytes()).hexdigest(), path.relative_to(REPO))
