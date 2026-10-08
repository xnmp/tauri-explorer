# #846 macOS clipboard qualification

The temporary provider probe imported the application's actual `error.rs`,
`clipboard/backend.rs`, `clipboard/change_counter.rs` and `clipboard/macos.rs`
with `#[path]`; it contained no copied provider logic or error shim. The guard
required tracked, clean measured inputs and matched all 65 probe dependency
identities (version, source and checksum) against the application's lock.
Every run executed exactly the existing ignored native ownership fixture on a
disposable hosted macOS runner. Dependency compilation could be cached; test
execution and proof were never cached. This qualified provider ownership;
full-app CI remains required for application admission.

Each directory retains the four complete, unmodified uploaded logs:
`native.log`, `list.log`, `provenance.log` and `toolchain.log`. Source, dependency,
checkout and harness hashes are in each `provenance.log`; artifact hashes are
in `SHA256SUMS`. Published heads differ from GitHub's synthetic PR checkout
commits. The source hashes below identify the actual tested provider.

| Evidence | Hosted run / job | Published head / actual checkout | Result |
| --- | --- | --- | --- |
| [Diagnostic control](diagnostic-control/native.log) | [37052207825](https://github.com/xnmp/tauri-explorer/actions/runs/37052207825) / 110988103400 | `4dd5a41d` / `8eee05afd28e1b8d6b71b3ae060e80be54911ea8` | Failed original-path proof: `fileURLWithPath` changed NFC to NFD; token and counter correct. |
| [Constructor control](constructor-control/native.log) | [37053219226](https://github.com/xnmp/tauri-explorer/actions/runs/37053219226) / 110991453879 | `522add92` / `f7bfad5a4745b4a5cbf9b9cd061ac88ee4e33d2b` | Unchanged producer remained red. Components preserved NFC through native URL parsing; explicit directory flag did not. |
| [Expanded components control](expanded-component-control/native.log) | [37055196443](https://github.com/xnmp/tauri-explorer/actions/runs/37055196443) / 110998056934 | `da10103c` / `63a15ffed8b4d498cd5984760e3896190e8f2aeb` | All five original paths proved ownership. Failed only required semicolon escaping for older NSURL compatibility. |
| [Escaped expanded positive](escaped-expanded-positive/native.log) | [37057326706](https://github.com/xnmp/tauri-explorer/actions/runs/37057326706) / 111005117884 | `779c3863` / `1d4fc8cea22372728604533c00ca608c60e4efb7` | Exact fixture: **1 passed, 0 failed, 0 ignored**. |

Provider SHA-256, in the same order:

- `4642e2693f73df707b59ede1cf08561c6df9ec17d808ccaa44ef9da906082275`
- `2e2a776f94508b3121529805958bada0a374c1e3d20dc69d952536fe4b1f9643`
- `61d1797528d5387d41e534078d4167a0d483e488420cf558d12e56eddcf0173e`
- `bf3767d10fc6714e90707898f7993a52db61c4e1443f78f10c604ee78d38debd`

All four runs used application lock SHA-256
`cf543493aa48b063218d8daa993137092fc464c8cea858f098757d4ddcf7b3f8`:
clipboard-rs 0.3.5, objc2 0.6.4, objc2-foundation/app-kit 0.3.2, serde 1.0.229,
thiserror 2.0.21 and tempfile 3.27.0. Complete uncached positive job log was
85,556 bytes, SHA-256
`29ba5bccbec24b2cc6bcfd29b687faae6a82dd3acd716b1106a6558cc486490d`.

The positive fixture completed all five paths (NFC, NFD, `%#?`, semicolon and a
real directory), native URL/order/private-token assertions, malformed-input
preservation and successive write assertions. Matching nonce A proved stable
count 1; nonce B proved count 2. An independent clipboard-rs write of identical
filesystem files advanced count to 3 and revoked ownership before and after
reading. Its normalized URL paths still resolved to the same ordered
filesystem device/inode identities. No production path-comparison or ownership
rule was relaxed. An independent reviewer separately fetched the complete job
log and confirmed these outcomes.

After this positive run, test-only diagnostics and constructor comparisons
were removed. The writer and expanded fixture were retained. Uninstrumented
provider SHA-256:
`57a53b5cdd961b3291d7b5a22df2c2c8471c0da9b56978a009259a5a021c2733`. The temporary
probe is retired separately; final full-app macOS CI must run the same ignored
fixture against the uninstrumented provider. This record does not claim runtime
coverage on macOS 10.13: semicolon encoding follows
[Apple's legacy NSURL compatibility requirement](https://developer.apple.com/documentation/foundation/nsurlcomponents/percentencodedpath).
