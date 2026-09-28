# Local publication-object audit — 2026-09-28

This read-only audit covers the exact local Git objects beyond `origin/dev`
`e8050938d3e602eed4700fe005b04dcc0f524a47`, whose remote ref was checked
on 2026-09-28. It includes intermediate commit blobs, not only final tree diffs.

| Draft PR | Local head | Hosted head | Commits beyond dev | Final changed paths |
| --- | --- | --- | ---: | ---: |
| [#812](https://github.com/xnmp/tauri-explorer/pull/812) | `83c27a1f` | `74596540` | 7 | 7 |
| [#815](https://github.com/xnmp/tauri-explorer/pull/815) | `af096190` | `23dab02a` | 14 | 10 |
| [#816](https://github.com/xnmp/tauri-explorer/pull/816) | `69777b6e` | `c87e3b14` | 16 | 37 |

An independent Sol reviewer enumerated all 133 blob objects in the union of
the three ranges, across 60 paths. The scan covered credential markers and
formats, environment assignments, email addresses, network URLs, home and
Windows user paths, and high-entropy strings. Hits were synthetic test paths,
example addresses, generated operation tokens, CI paths, public links,
checksums and fixture image data. No credential or private user data was found.

The sole binary blob is #812's 52,158-byte `completed-cycle.png`. Visual
inspection showed only the synthetic `qualification.md` preview, workspace
fixtures and a CI temporary path. Its PNG has no metadata chunks. The two
qualification JSON files contain the CI build path, binary hash, platform,
seed, resource measurements and scenario outcomes; no private user path was
found. This audit does not cover uncommitted files or future commits, and a
static scan cannot prove that arbitrary encoded secrets are absent.

The audit improves the review basis but does not authorize publication.
Automatic approval review previously rejected the #812 push as possible
sensitive-data egress. No GitHub write followed that rejection; publication
still requires explicit approval.
