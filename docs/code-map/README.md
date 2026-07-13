# Code Maps

Curated maps of this codebase whose sole purpose is to make code search cheap: an agent (or human) given a task reads one map first, then jumps straight to the right files. Which map to read, and when to skip them, was determined empirically — see [STUDY.md](STUDY.md) (240 measured search runs, blinded judging; headline numbers below).

## How to use

**For a bug fix, perf investigation, or any cross-layer change** (the expensive searches — this is where maps earn ~25–30% cost and turn savings):

1. Read **[map-feature.md](map-feature.md)** — 28 feature clusters, each listing the files across component → store → api → Rust in pipeline order, with the connecting events/functions.
2. Jump to the cluster matching your task; verify in code (the map names files and seams, not line numbers).
3. If no cluster matches, use **[map-folder.md](map-folder.md)** — an exhaustive one-line-per-file index of `src/lib/`, `src/routes/`, and `src-tauri/src/`.

**For a task-shaped change** ("add a context-menu action", "add a palette command", "persist a setting", "add a Tauri command end-to-end"): **[map-playbook.md](map-playbook.md)** has 17 ordered recipes with gotchas (all-three-views, mock-invoke for E2E, async-fn commands).

**For a small, obviously-localized task** (one dialog, one label, one component you can already name): **skip the maps** — the study measured a net *loss* on cheap tasks; just grep.

**Do NOT point search agents at `docs/ARCHITECTURE.md` / `docs/architecture/`** for "where do I change X" work: measured net negative (+4.6% cost, −4.8% quality, 2.5× more wrong files in answers). Those docs are for humans reading about design, not for locating change sites.

A fourth variant, a symbol index (stores / Tauri commands / events), was built and tested but **retired** (#347): it was the only map that failed to pay for itself — the largest doc at ~5.5k tokens, +2.0% net search cost versus no docs at all, and the weakest perf-task recall of any map. Grep is the better tool for symbol lookup. The finding generalizes: past roughly 20KB, a map's read cost cancels the orientation it saves, so keep any future map small.

## Headline numbers (from STUDY.md)

| reading first… | cost/search | turns | judge quality (0–10) | wrong files/answer |
|---|---|---|---|---|
| nothing (baseline) | $0.60 | 17.4 | 8.12 | 1.05 |
| prose architecture docs | $0.62 | 18.0 | 8.03 | 2.58 |
| **map-feature.md** | **$0.54** | **14.9** | 8.30 | 1.32 |
| map-folder.md | $0.57 | 15.1 | **8.40** | 1.32 |
| map-playbook.md | $0.58 | 17.2 | 8.28 | 1.25 |

(Sonnet searchers on a 20-task benchmark drawn from this repo's real issue history; savings concentrate in perf/cross-layer tasks: ~25–30% there, ≈0 on small feature tasks.)

Honest framing (STUDY.md §9.3): relative to a *whole* task, search is 10–20% of tokens, so the dollar savings are ~1–2% end-to-end — not the point. What the maps measurably buy is **fewer forward passes** (−14% turns = latency on every task's serial prefix), **better-calibrated answers** (baseline agents were confidently wrong), and the license to **stop feeding prose docs to search agents** (measured net harm).

## Maintenance

Maps decay as code moves. Protocol:

- **Validate** (cheap, mechanical): `python3 docs/code-map/validate.py` checks that every file referenced in every map still exists. Run it when a map feels stale, or after large refactors.
- **Regenerate** (when validation fails badly or a subsystem was restructured): re-run a builder agent with the prompt pattern in STUDY.md §7 step 3 — one agent per map, verify-every-path rule, token budget ≤ ~5K. Budget matters: the study found doc size, not structure, is the main determinant of whether a map pays for itself.
- Keep line numbers out of maps (they go stale immediately); name files, symbols, and events instead.
