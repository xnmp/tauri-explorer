#!/usr/bin/env python3
"""Actual SDK2 initialize against independent copies; no host/profile/provider IO.

Builds exact committed legacy sources with only a uniquely named binary target.
This proves that legacy initializer's behavior, not the current host quarantine.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

SOURCE = "cae90fb4344375cf8fc1453df74f50ecdc0b4d55"
BINARY = "te-legacy-sdk2-preflight-fixture"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=")
SCHEMA = """
CREATE TABLE artifacts(id INTEGER PRIMARY KEY,path TEXT NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'fixture',generating_run INTEGER REFERENCES runs(id));
CREATE TABLE runs(id INTEGER PRIMARY KEY,operation TEXT NOT NULL,parameters TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'fixture',status TEXT NOT NULL DEFAULT 'running',finished_at TEXT,error TEXT,prepared_output_path TEXT,prepared_output_digest TEXT,prepared_object_identity TEXT,prepared_anchor_path TEXT,recovered INTEGER NOT NULL DEFAULT 0,result_details TEXT);
CREATE TABLE run_inputs(run_id INTEGER NOT NULL REFERENCES runs(id),artifact_id INTEGER NOT NULL REFERENCES artifacts(id),position INTEGER NOT NULL,PRIMARY KEY(run_id,position));
CREATE TABLE image_saves(artifact_id INTEGER PRIMARY KEY REFERENCES artifacts(id),source_path TEXT NOT NULL,target_path TEXT NOT NULL,digest TEXT NOT NULL,object_identity TEXT NOT NULL,anchor_path TEXT NOT NULL,committed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE artifact_locators(artifact_id INTEGER NOT NULL REFERENCES artifacts(id),path TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(path,digest,artifact_id));
CREATE TABLE image_jobs(operation_id TEXT PRIMARY KEY,job_id INTEGER NOT NULL,request_digest TEXT NOT NULL,run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id));
CREATE TABLE image_discards(artifact_id INTEGER PRIMARY KEY REFERENCES artifacts(id),path TEXT NOT NULL,staged_path TEXT NOT NULL,digest TEXT NOT NULL,object_identity TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE image_batch_members(batch_id TEXT NOT NULL,position INTEGER NOT NULL,signature TEXT NOT NULL,run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),PRIMARY KEY(batch_id,position));
CREATE TABLE image_folder_contexts(folder TEXT NOT NULL,run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),PRIMARY KEY(folder,run_id));
CREATE TABLE image_prompt_titles(digest TEXT PRIMARY KEY,title TEXT NOT NULL);
PRAGMA user_version=8;
"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(root):
    return {str(p.relative_to(root)): {"sha256": sha(p.read_bytes()), "bytes": p.stat().st_size,
            "mode": p.stat().st_mode & 0o777, "inode": p.stat().st_ino}
            for p in sorted(root.rglob("*")) if p.is_file()}


def identity(path):
    st = path.stat()
    return json.dumps({"platform": "linux", "device": st.st_dev, "inode": st.st_ino}, separators=(",", ":"))


def stage(root, name, published=None):
    directory = root / (".tauri-explorer-stage-" + name)
    directory.mkdir()
    payload = directory / "payload"
    payload.write_bytes(PNG)
    anchor = directory / "trace-anchor"
    os.link(payload, anchor)
    if published:
        os.link(payload, published)
    return anchor


def seeded(original, references):
    original.mkdir()
    references.mkdir()
    db = original / "trace.sqlite"
    connection = sqlite3.connect(db)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.executescript(SCHEMA)
    # Keep real WAL + shared memory present without an active writer while copying.
    published = references / "published.png"
    unfinished = stage(references, "unfinished", published)
    terminal = stage(references, "terminal")
    saved = references / "saved.png"
    save_anchor = stage(references, "save", saved)
    generated = original / "generated"
    generated.mkdir()
    source = generated / "save-source.png"
    source.write_bytes(PNG)
    discard_source = generated / "discard-source.png"
    discard_source.write_bytes(PNG)
    discard_directory = generated / "discard-fixture"
    discard_directory.mkdir()
    discard_staged = discard_directory / "payload"
    os.link(discard_source, discard_staged)
    digest = sha(PNG)
    parameters = json.dumps({"output_storage": "temporary", "save_directory_hint": str(references)})
    for rid, status in ((1, "failed"), (2, "running"), (3, "succeeded"), (4, "succeeded")):
        connection.execute("INSERT INTO runs(id,operation,parameters,status) VALUES(?,?,?,?)", (rid, "openai.image.generate", parameters, status))
    for rid, path, anchor in ((1, references / "not-published.png", terminal), (2, published, unfinished)):
        connection.execute("UPDATE runs SET prepared_output_path=?,prepared_output_digest=?,prepared_object_identity=?,prepared_anchor_path=? WHERE id=?", (str(path), digest, identity(anchor), str(anchor), rid))
    for aid, path, rid in ((1, source, 3), (2, discard_source, 4)):
        connection.execute("INSERT INTO artifacts(id,path,digest,generating_run) VALUES(?,?,?,?)", (aid, str(path), digest, rid))
    connection.execute("INSERT INTO image_saves(artifact_id,source_path,target_path,digest,object_identity,anchor_path) VALUES(1,?,?,?,?,?)", (str(source), str(saved), digest, identity(save_anchor), str(save_anchor)))
    connection.execute("INSERT INTO image_discards(artifact_id,path,staged_path,digest,object_identity) VALUES(2,?,?,?,?)", (str(discard_source), str(discard_staged), digest, identity(discard_staged)))
    connection.commit()
    os.chmod(db, 0o600)
    assert db.with_name("trace.sqlite-wal").is_file()
    assert db.with_name("trace.sqlite-shm").is_file()
    return connection


def probe_lock(path, held):
    import fcntl
    with path.open("rb") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            assert held, "candidate lock survived actual process exit"
        else:
            assert not held, "candidate did not own its validation lock"
            fcntl.flock(lock, fcntl.LOCK_UN)


def initialize(binary, directory, expect_error=False):
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("OPENAI_", "CODEX_", "CLAUDE_", "ANTHROPIC_"))}
    process = subprocess.Popen([str(binary), "--data-dir", str(directory)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
                               start_new_session=True, bufsize=0)
    frames = []
    data = b""
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        def request(rid, method, params):
            nonlocal data
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode() + b"\n")
            process.stdin.flush()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                for _key, _event in selector.select(max(0, deadline - time.monotonic())):
                    chunk = os.read(process.stdout.fileno(), 65536)
                    assert chunk, "legacy candidate exited before initialization result"
                    data += chunk
                    assert len(data) <= 1024 * 1024, "candidate exceeded output bound"
                    while b"\n" in data:
                        line, data = data.split(b"\n", 1)
                        frame = json.loads(line)
                        frames.append(frame)
                        assert "method" not in frame, "candidate attempted a reverse call or user event"
                        if frame.get("id") == rid:
                            return frame
            raise AssertionError("legacy initialization deadline reached")

        response = request(1, "initialize", {"protocolVersion": 1, "activeRunIds": [],
                    "deferRecovery": True, "validationOnly": True, "processService": False})
        if expect_error:
            assert "error" in response, response
        else:
            assert response["result"]["ready"] is False, response
            assert response["result"]["protocolVersion"] == 1
            assert response["result"]["pluginVersion"] == "0.2.3"
            # An ordinary query remains rejected; it cannot implicitly activate.
            rejected = request(2, "folder_has_trace", {"directory": str(directory)})
            assert "error" in rejected, rejected
        probe_lock(directory / "trace-owner.lock", True)
        # Close the reader only after the response: legacy main aborts unfinished
        # handlers on EOF. Join the real process before asserting lock release.
        rest, stderr = process.communicate(timeout=3)
        assert process.returncode == 0, stderr.decode(errors="replace")
        for line in rest.splitlines():
            frame = json.loads(line)
            frames.append(frame)
            assert "method" not in frame, "candidate emitted a late reverse call/event"
        probe_lock(directory / "trace-owner.lock", False)
        return {"frames": frames, "stderrBytes": len(stderr), "exit": process.returncode}
    finally:
        selector.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=3)


def execute_cases(binary, evidence):
    cases = []
    with tempfile.TemporaryDirectory(prefix="te-sdk2-validation-") as temporary:
        root = Path(temporary)
        for schema in (8, 7):
            original, references, validation = root / f"original-v{schema}", root / f"references-v{schema}", root / f"validation-v{schema}"
            connection = seeded(original, references)
            if schema == 7:
                for table in ("image_batch_members", "image_folder_contexts", "image_prompt_titles", "image_discards"):
                    connection.execute(f"DROP TABLE {table}")
                connection.execute("PRAGMA user_version=7")
                connection.commit()
            try:
                before = {"original": snapshot(original), "references": snapshot(references)}
                validation.mkdir()
                for name in ("trace.sqlite", "trace.sqlite-wal", "trace.sqlite-shm"):
                    shutil.copyfile(original / name, validation / name)
                    assert (original / name).stat().st_ino != (validation / name).stat().st_ino
                result = initialize(binary, validation)
                assert snapshot(original) == before["original"], "original DB/sidecars or output changed"
                assert snapshot(references) == before["references"], "absolute referenced evidence changed"
                with sqlite3.connect(validation / "trace.sqlite") as copied:
                    assert copied.execute("PRAGMA user_version").fetchone()[0] == 8
                    assert copied.execute("SELECT status FROM runs WHERE id=2").fetchone()[0] == "running"
                    assert copied.execute("SELECT count(*) FROM image_saves").fetchone()[0] == 1
                    if schema == 8:
                        assert copied.execute("SELECT completed FROM image_discards WHERE artifact_id=2").fetchone()[0] == 0
                    else:
                        assert copied.execute("SELECT count(*) FROM image_discards").fetchone()[0] == 0
                    assert copied.execute("SELECT prepared_anchor_path FROM runs WHERE id=1").fetchone()[0]
                cases.append({"case": f"v{schema}-wal-copy-and-absolute-publication-save-discard-references", "originalAndReferencesBefore": before, "validationSchema": 8, **result})
            finally:
                connection.close()
        for malformed in (False, True):
            original = root / ("corrupt-original" if malformed else "absent-original")
            validation = root / ("corrupt-validation" if malformed else "empty-validation")
            original.mkdir(); validation.mkdir()
            if malformed:
                (original / "trace.sqlite").write_bytes(b"private malformed SQLite fixture")
                shutil.copyfile(original / "trace.sqlite", validation / "trace.sqlite")
            before = snapshot(original)
            result = initialize(binary, validation, expect_error=malformed)
            assert snapshot(original) == before
            assert (validation / "trace.sqlite").is_file()
            cases.append({"case": "corrupt-copy-rejected" if malformed else "absent-real-db-private-create-only", "originalBefore": before, **result})
    (evidence / "outcomes.json").write_text(json.dumps(cases, indent=2) + "\n")
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace-checkout", type=Path, required=True)
    parser.add_argument("--target-dir", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    assert sys.platform == "linux", "this exact native evidence fixture is Linux-only"
    assert args.target_dir.is_dir(), "reuse the existing Trace Cargo cache"
    args.evidence.mkdir(parents=True, exist_ok=False)
    archive = subprocess.check_output(["git", "-C", str(args.trace_checkout), "archive", SOURCE, "src-tauri"])
    (args.evidence / "legacy-source.tar").write_bytes(archive)
    source_manifest = json.loads(subprocess.check_output(["git", "-C", str(args.trace_checkout), "show", f"{SOURCE}:plugin.json"]))
    assert source_manifest["sdkVersion"] == 2 and source_manifest["version"] == "0.2.3"
    current_binary = args.target_dir / "debug/trace-explorer-backend"
    current_sha = sha(current_binary.read_bytes()) if current_binary.exists() else None
    with tempfile.TemporaryDirectory(prefix="te-sdk2-source-") as temporary:
        source_root = Path(temporary)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            for member in source.getmembers():
                assert not Path(member.name).is_absolute() and ".." not in Path(member.name).parts
                assert member.isfile() or member.isdir(), "legacy source archive contains a link/special file"
            source.extractall(source_root, filter="data")
        manifest = source_root / "src-tauri/Cargo.toml"
        lock = source_root / "src-tauri/Cargo.lock"
        original_manifest = manifest.read_bytes()
        original_lock = lock.read_bytes()
        altered = original_manifest.decode().replace('[package]\n', '[package]\nautobins = false\n', 1)
        altered += f'\n[lib]\nname = "trace_explorer_backend"\npath = "src/lib.rs"\n\n[[bin]]\nname = "{BINARY}"\npath = "src/main.rs"\n'
        manifest.write_text(altered)
        command = ["cargo", "build", "--offline", "--locked", "--manifest-path", str(manifest), "--bin", BINARY]
        environment = dict(os.environ, CARGO_TARGET_DIR=str(args.target_dir))
        with (args.evidence / "build.log").open("wb") as log:
            subprocess.run(command, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
        assert lock.read_bytes() == original_lock, "legacy frozen lock changed"
        if current_sha:
            assert sha(current_binary.read_bytes()) == current_sha, "current Trace executable was replaced"
        # Keep one uniquely named executable in the already-owned Cargo cache;
        # duplicate debug binaries can exceed the private filesystem quota.
        binary = args.target_dir / "debug" / BINARY
        source_hashes = {str(p.relative_to(source_root)): sha(p.read_bytes()) for p in sorted(source_root.rglob("*")) if p.is_file()}
        provenance = {"sourceCommit": SOURCE, "sdkVersion": 2, "pluginVersion": "0.2.3", "sourceArchiveSha256": sha(archive), "originalManifestSha256": sha(original_manifest), "buildManifestSha256": sha(manifest.read_bytes()), "lockSha256": sha(original_lock), "buildCommand": command, "cargoTargetDir": str(args.target_dir), "binaryPath": str(binary), "binarySha256": sha(binary.read_bytes()), "currentTraceBinaryBeforeAndAfterSha256": current_sha, "sourceFileSha256": source_hashes, "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(), "scope": "legacy initializer on Linux; current host quarantine/lifecycle integration not exercised"}
        (args.evidence / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        cases = execute_cases(binary, args.evidence)
        print(json.dumps({"passed": len(cases), "cases": [case["case"] for case in cases], "binarySha256": provenance["binarySha256"], "evidence": str(args.evidence)}, indent=2))


if __name__ == "__main__":
    main()
