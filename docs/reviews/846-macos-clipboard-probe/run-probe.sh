#!/usr/bin/env bash
# Only run this on a disposable hosted Mac: it replaces the general pasteboard.
set -euo pipefail
probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$probe_dir/logs"
python3 "$probe_dir/verify-provenance.py" 2>&1 | tee "$probe_dir/logs/provenance.log"
rustc --version --verbose 2>&1 | tee "$probe_dir/logs/toolchain.log"
fixture="clipboard::macos::native_clipboard_tests::native_clipboard_ownership_round_trip"
cargo test --locked --manifest-path "$probe_dir/Cargo.toml" --lib "$fixture" -- --exact --ignored --list 2>&1 | tee "$probe_dir/logs/list.log"
python3 - "$probe_dir/logs/list.log" "$fixture" <<'PYGUARD'
from pathlib import Path
import sys
lines = Path(sys.argv[1]).read_text().splitlines()
assert [line for line in lines if line.endswith(": test")] == [sys.argv[2] + ": test"], "Expected exactly the production native ownership fixture"
assert "1 test, 0 benchmarks" in lines, "Native fixture was not selected exactly once"
PYGUARD
set +e
cargo test --locked --manifest-path "$probe_dir/Cargo.toml" --lib "$fixture" -- --exact --ignored --nocapture 2>&1 | tee "$probe_dir/logs/native.log"
test_status=${PIPESTATUS[0]}
set -e
python3 - "$probe_dir/logs/native.log" <<'PYGUARD'
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text()
assert text.splitlines().count("running 1 test") == 1, "Native fixture did not execute exactly once"
assert re.search(r"test result: (?:ok|FAILED)\. (?:1 passed; 0 failed|0 passed; 1 failed); 0 ignored;", text), "Missing exact native outcome"
PYGUARD
exit "$test_status"
