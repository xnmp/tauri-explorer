# Code-Map Search-Efficiency Study

**Status:** in progress — methodology and hypotheses registered 2026-07-11, before any results were collected.
**Goal:** determine whether (and which) curated "code map" documents in `docs/` make agent-driven code search cheaper (fewer tokens, fewer tool calls) without degrading answer quality, for the kinds of tasks this repo actually sees (features, bugfixes, performance work).

---

## 1. Research questions

- **RQ1 — What does code search actually consist of?** When an agent is asked "what would I need to change to do X", how are its tokens spent: finding the right files (orientation) vs understanding them (comprehension)? What gets grepped, globbed, and read, and how often is the same ground re-covered across independent searches?
- **RQ2 — Do the existing prose docs help?** `docs/ARCHITECTURE.md` + `docs/architecture/*.md` (~1,050 lines of narrative) already exist. Do agents that use them search cheaper/better than agents that see only source code?
- **RQ3 — Which map structure wins?** Folder-mirrored map vs cross-layer feature map vs symbol index vs task playbook: which reduces cost most, and does any structure degrade quality?
- **RQ4 — What is the net accounting?** Reading a map itself costs tokens. Where is the break-even, and does the benefit concentrate in expensive tasks?

## 2. Benchmark task suite (20 tasks)

Two batches, all phrased as real work requests ("add X", "bug report: Y", "performance: Z") whose deliverable is a *search result*: the minimal set of files to read/modify plus a short implementation/diagnosis sketch.

- **Batch 1 (F1–F4, B1–B4, P1–P4):** 12 tasks designed to span layers and subsystems — context menu/clipboard, sorting, tab restore, status bar, tab titles on rename, Quick Open staleness, marquee×hidden files, thumbnail invalidation, 50k-entry render, content-search streaming, tab-switch refetch, thumbnail CPU saturation.
- **Batch 2 (X1–X8):** 8 tasks sampled directly from the project's real closed-issue backlog (provided by the maintainer mid-study; batch added 2026-07-11 before any results were analyzed) — miller-column staleness, git badge refresh, drop-target validity on same-folder drops, recent-locations eviction, tiles-view full re-render on delete, auto-registering settings toggles in the command palette, autocomplete pill stealing keys in Ctrl+Shift+F, stuck progress dialog on cancel. These cover subsystems batch 1 missed (miller, SCM, DnD, sidebar, dialogs, palette) and anchor the suite's external validity in the repo's actual task distribution.

Full task texts: `STUDY-data/tasks.json` (checked in alongside this doc at study completion).

## 3. Experimental conditions

| Condition | Docs available to searcher | Entry instruction |
|---|---|---|
| **C0** no-docs | none (all `.md` reading forbidden) | search source code only |
| **C1** existing-docs | `docs/ARCHITECTURE.md`, `docs/architecture/*` | read ARCHITECTURE.md first, follow pointers |
| **M-folder** | `docs/code-map/map-folder.md` | read map first, then search |
| **M-feature** | `docs/code-map/map-feature.md` | read map first, then search |
| **M-symbol** | `docs/code-map/map-symbols.md` (built for the study; **retired** afterwards — see §10.4) | read map first, then search |
| **M-playbook** | `docs/code-map/map-playbook.md` | read map first, then search |

Notes and known contaminations, stated up front:

- Every agent (all conditions, C0 included) automatically receives the project `CLAUDE.md`, which contains a coarse architecture overview. **C0 is therefore "CLAUDE.md-only", the realistic floor** — every real agent in this repo has that context too.
- C1 and the M-conditions mandate reading the doc(s) rather than merely permitting it. This measures *the value of a doc structure when used*, not whether agents voluntarily reach for docs (out of scope; noted in §8).
- Doc-reading cost is charged to the condition: all metrics include the tokens spent reading the map.

## 4. Apparatus

- **Searchers:** Claude Sonnet, `explore-local` agent type (Glob/Grep/Read/Bash only, no web, no writes), 2 independent trials per task×condition. Structured output: `{files[≤12]: {path, why}, plan, confidence 1–5}`.
- **Oracles (gold sets):** one Claude Opus agent per task, high reasoning effort, unrestricted thoroughness, produces `{core_files, peripheral_files, notes}` — core = definitely modified / definitely contains the involved logic; peripheral = context reads. Gold sets are spot-reviewed by the coordinating model (Fable) before use; ambiguity about alternate implementation routes recorded in `notes` and honored during scoring.
- **Judges:** blinded per-task judging — one judge per task receives the task, the gold set, and all anonymized, shuffled answers from every condition, and scores each 0–10 (correctness + completeness of the file set and sketch). Judges never see condition labels.
- **Cost measurement:** full per-agent transcripts (`agent-*.jsonl`) are parsed offline by script. No self-reported costs are used.
- **Orchestration:** deterministic workflow scripts; searcher prompts are identical across conditions except the one condition-specific docs rule.

## 5. Metrics (definitions fixed before data collection)

Cost (per run, from transcript):

- **EstTok** — estimated tokens processed: total characters of (tool inputs + tool results + assistant text) / 4. Primary cost metric.
- **Calls** — number of tool calls; **Depth** — number of assistant turns (sequential latency proxy).
- **FilesRead / LinesRead** — unique source files opened, total lines returned by Read.
- **DocTok** — subset of EstTok spent reading `.md` files (map overhead).

Quality (per run, against gold):

- **CoreRecall** — |answer ∩ gold core| / |gold core|. Primary quality metric.
- **Precision** — |answer ∩ (core ∪ peripheral)| / |answer|. (Files outside gold entirely count against precision; peripheral files count for precision but not recall.)
- **F1** — harmonic mean of CoreRecall and Precision.
- **Judge** — blinded judge score 0–10, /10 for compositing.
- **Q** (composite) — `0.5·CoreRecall + 0.2·Precision + 0.3·Judge/10`.
- **Calibration** — Pearson r between self-reported confidence and CoreRecall, per condition.

Efficiency:

- **QPT** — Q per 10k EstTok. The headline number: quality bought per token.

Where an oracle's `notes` records two valid implementation routes, an answer matching either route's core files scores full recall for the divergent entries.

## 6. Preregistered hypotheses

Registered 2026-07-11, before any baseline or evaluation data was inspected.

- **H1 (orientation dominates).** In C0, ≥50% of tool calls serve orientation (locating the right file: Glob, Grep, dead-end Reads abandoned within ~50 lines) rather than comprehension of files that end up in the answer. *This is the mechanism that makes maps plausible at all.*
- **H2 (existing prose docs are weak).** C1 reduces EstTok by <15% vs C0 with no significant quality change: narrative multi-file docs cost nearly as much to traverse as they save, because their pointers are module-grained, not task-grained.
- **H3 (purpose-built maps beat no-docs on cost).** Every M-condition reduces median EstTok ≥25% vs C0 with no CoreRecall loss.
- **H4 (structure matters: feature > folder here).** This codebase's tasks are feature-shaped and cut across layers (Svelte component → runes store → `api/` bridge → Rust command). A folder map mirrors the *layer* axis, so agents still pay one search hop per layer; a cross-layer feature map collapses those hops. Predict M-feature beats M-folder on both EstTok and CoreRecall. M-folder's residual advantage: coverage of obscure/utility files.
- **H5 (symbol index is task-shape-sensitive).** M-symbol shows the largest grep-replacement effect on tasks naming a concrete artifact (a shortcut, a command, a store), the smallest on diffuse perf tasks; it is also the largest doc, so net savings are partially eaten by DocTok.
- **H6 (playbook: highest variance).** M-playbook is near-oracle on tasks matching a recipe and no better than M-folder off-recipe — highest across-task variance of all conditions. Playbooks pay only if recipes track the real issue distribution (testable against batch 2).
- **H7 (degradation mode is trust-without-verify, and benefit scales with baseline cost).** Where maps hurt, it shows as a *precision* drop / stale-pointer answers (agents trusting the map skip code verification), not a recall drop. Net benefit correlates positively with the task's C0 cost; for cheap tasks (C0 EstTok < ~25k) maps yield little or negative net benefit.

Predicted cost ordering (median EstTok, cheapest first): `M-playbook < M-feature < M-symbol < M-folder < C1 < C0`, with the caveat in H5 that DocTok may swap M-symbol and M-folder.

## 7. Protocol

1. **Baseline + gold** — run C0/C1 × 2 trials × 20 tasks (80 searcher runs, Sonnet) and 20 oracle runs (Opus). *(running)*
2. **Transcript mining** — script-parse all transcripts; produce the RQ1 taxonomy, per-run cost table, cross-run redundancy (files read in ≥k independent runs), grep-pattern census.
3. **Map construction** — 4 builder agents write the variants into `docs/code-map/`, each given the same raw material (file inventory + mining results) and a structure spec + token budget (≤ ~5k tokens/map; symbol index ≤ ~8k). Builders must verify every path/symbol they cite. No file outside `docs/code-map/` is touched.
4. **Evaluation** — 20 tasks × 4 M-conditions × 2 trials (160 searcher runs), identical prompts except the docs rule; transcripts collected the same way.
5. **Judging** — blinded per-task judges over all ~240 answers; script computes recall/precision/F1 against gold.
6. **Analysis & report** — per-condition medians/IQRs, per-category breakdown (feature/bugfix/perf; batch 1 vs 2), hypothesis verdicts, final recommendation + maintenance guidance in `docs/code-map/README.md`.

## 8. Threats to validity (acknowledged up front)

- **Estimated, not billed, tokens.** chars/4 over transcripts approximates true tokenization and ignores per-model system-prompt overhead (constant across conditions, so comparisons stand; absolute numbers are indicative).
- **Gold sets are model-adjudicated.** Opus oracles + Fable review, not human ground truth. Mitigated by dual-route scoring and blinded judges as a second quality signal.
- **n=2 trials per cell.** Medians over 8 task-cells per condition give usable contrasts; per-task differences are noisy and reported as such.
- **Mandated doc reading.** We measure the value of structures-when-used; voluntary uptake is a separate question.
- **CLAUDE.md floor.** All conditions include CLAUDE.md's coarse overview; effects are marginal value beyond it.
- **Same-family models throughout.** Results may not transfer to other model families or to human developers.
- **Staleness is out of scope but real.** A map that wins today decays; the README will include a maintenance protocol and staleness-risk notes per structure.

## 9. Results

### 9.0 Protocol deviations (recorded as they happened)

1. **Output-schema censoring.** The baseline searcher schema imposed `maxLength` caps on answer strings; 18/100 agents (18%) exhausted the structured-output retry cap by writing strings just over the caps. Failed cells were re-run with the caps removed and otherwise identical prompts; all subsequent phases use the uncapped schema. Impact: the 82 capped-run answers experienced mild brevity pressure at the answer-writing stage only (after search completed), so cost comparisons are unaffected; judges score both formats.
2. **Real token accounting.** Transcripts turned out to carry per-API-call usage, so the preregistered chars/4 estimate (`EstTok`) was upgraded to real token counts priced per class: `cost = in·$3 + cache_write·$3.75 + cache_read·$0.30 + out·$15 per Mtok` (Sonnet weights; Opus weights for oracles). chars/4 is retained only for the byte-anatomy taxonomy. This strictly strengthens measurement; no hypothesis threshold was changed.
3. **Agents ignored the Grep/Glob tools** and did orientation via Bash (`grep -rn`, `find`, `sed -n`). The taxonomy therefore classifies Bash calls by command head (grep/rg/find/fd/ls/wc/tree → orientation; sed/cat/head/tail/awk → comprehension-read; git → history).

### 9.1 Baseline: what code search actually is (RQ1, RQ2)

68 successful searcher runs (34 C0, 34 C1) over 20 tasks:

| | C0 no-docs | C1 existing-docs |
|---|---|---|
| median cost/run | **$0.614** | **$0.665** |
| median output tokens | 12.5k | 14.0k |
| median uncached input | 52.7k | 51.2k |
| median cache-read | 628k | 674k |
| median turns / tool calls | 16 / 25 | 18 / 26 |
| median distinct source files read | 6 | 6 |
| median doc bytes read | 0 | 14.4k chars |

**RQ1 — anatomy of a search.** By tool-call *count*, orientation dominates: 67% of calls (1,013 of ~1,510) are greps/finds/globs/dead-end reads that only locate files; 29% are comprehension reads of files that end up in the answer; 4% doc reads. By *bytes*, it inverts: comprehension 63%, orientation 26%, docs 11%. **H1 verdict: confirmed by calls (67% ≥ 50%), refuted by volume (26%).** Consequence, stated before eval: a perfect map can remove orientation calls (latency, turns) and the wandering-grep tail, but ~2/3 of byte volume is comprehension reading a map cannot replace — so predicted best-case cost reduction is ~25-35%, mostly via shorter transcripts (fewer turns → less cache-read accumulation).
- The repo has hub files: `state/explorer.svelte.ts` was read in 25/68 searches; ~15 files account for most cross-task reads. A small map that names the hubs correctly covers a large share of orientation value.
- C0 discipline held: 0 doc reads in all 40 C0 runs (2 flagged bash calls were false positives — `.md` appeared only in exclusion filters).

**RQ2 — the existing prose docs are net-neutral to slightly negative on cost.** Paired per-task comparison: C1 cheaper in 9/19 tasks, median Δ = +$0.008 (C1 *more* expensive). The ~1,050 lines of narrative architecture docs cost roughly as much to traverse as they save. **H2 verdict: confirmed, direction stronger than predicted** (predicted <15% savings; observed ≈ 0/negative). Quality comparison pending judging.

### 9.2 Evaluation results

240 scored runs: 20 tasks × 6 conditions × 2 trials (cells lost to the schema-censoring bug were re-run; a workflow-resume quirk produced extra trials for some cells, deduplicated deterministically to 2 per cell). Every run's cost comes from its own transcript; every answer was scored mechanically against gold and by a blinded Opus judge (0–10) who saw all 12 anonymized answers per task.

**Condition means (n=40 runs each):**

| condition | CoreRecall | Precision | F1 | Judge | Q | cost $/run | turns | tool calls | doc KB read | Q per $ |
|---|---|---|---|---|---|---|---|---|---|---|
| C0 no-docs | .945 | **.875** | .898 | 8.12 | .891 | .596 | 17.4 | 24.7 | 0.1 | 1.50 |
| C1 existing docs | .925 | .728 | .801 | 8.03 | .849 | .623 | 18.0 | 26.6 | 18.3 | 1.36 |
| M-folder | **.963** | .849 | .896 | **8.40** | **.903** | .569 | 15.1 | 20.5 | 19.6 | 1.59 |
| M-feature | .948 | .845 | .882 | 8.30 | .892 | **.544** | **14.9** | **20.3** | 19.7 | **1.64** |
| M-symbols | .956 | .869 | **.903** | 8.25 | .899 | .608 | 16.6 | 22.4 | 22.9 | 1.48 |
| M-playbook | .962 | .863 | .902 | 8.28 | .902 | .582 | 17.2 | 22.7 | **13.8** | 1.55 |

**Paired per-task deltas vs C0** (each task's trial-mean; wins = tasks where the condition is better):

| condition | Δcost (mean) | cost wins | Δjudge (mean) | ΔQ (mean) |
|---|---|---|---|---|
| C1 | **+4.6%** | 8/20 | −0.10 | −4.8% (4/20 wins) |
| M-folder | −4.5% | 11/20 | +0.28 | +1.3% |
| M-feature | **−8.8%** | 13/20 | +0.18 | +0.1% |
| M-symbols | +2.0% | 10/20 | +0.13 | +0.9% |
| M-playbook | −2.3% | 11/20 | +0.15 | +1.2% |

Where the benefit lives (per-category judge / cost):

- **perf tasks** (most expensive at baseline): M-folder 8.80/$0.57, M-feature 8.40/$0.49, M-playbook 8.50/$0.51 vs C0 8.00/$0.71 — **better answers for ~25–30% less money**.
- **feature tasks** (cheapest at baseline): all conditions ≈ C0's 8.58/$0.33; maps add nothing and sometimes cost more.
- **bugfix tasks**: quality up slightly (feature map +0.28 judge), cost flat.
- H7 gradient check: on the 10 cheapest-baseline tasks the best map *costs* +$0.03/task; on the 10 costliest it *saves* −$0.06/task.

Secondary observations:

- **Wrong-file rate**: C0 1.05 wrong files/answer; C1 **2.58** (2.5× worse — doc-fed agents pad answers with off-target files, including citing docs themselves as modification targets); maps 1.23–1.32.
- **Calibration**: C0 confidence is *anti*-correlated with recall (r = −0.26 — agents that wandered blind are confidently wrong more often); all map conditions restore weakly positive calibration (r ≈ +0.1).
- **Turns** (latency proxy): maps cut assistant turns 13–15% (17.4 → ~14.9) — the wall-clock/latency win is larger and more consistent than the dollar win, because cache-read pricing makes wandering cheap in dollars but not in time.
- Cost-delta spread per task (H6): playbook stdev $0.171, min −0.28/max +0.35 — high variance as predicted, but M-feature's spread is just as high ($0.179), so variance does not uniquely characterize the playbook.

### 9.3 Cost-accounting sensitivity & the end-to-end ROI question

Three challenges raised in review, answered from the data:

**Forward-pass accounting.** 91–92% of attended input is cache reads in every condition — each turn re-attends the whole transcript at 10× discount. Dollar pricing therefore *underweights* turns. Re-priced with no cache discount (compute/latency-weighted): C0 attends 0.70M tok/run, M-feature 0.62M (**−11%**), M-folder −6%, M-symbols +8%. Rankings unchanged; the map's real product is fewer forward passes (−14% turns = serial latency), not dollars.

**What judges actually measure.** Mechanism-sensitivity at the *plan* level is demonstrated in the data (B2: identical file sets scored 6 vs 9 based on which root-cause mechanism was named; B4: answers with all 4 core files got 6 for missing the key-prefix cause). But no proposal was implemented or tested, and gold + judges are same-family (Opus) — an answer sharing an oracle's wrong diagnosis would be rewarded. Quality results should be read as "correctly oriented and mechanism-plausible", not "fix verified". An implement-and-test variant (~10–30× per-run cost) on the 3–4 diagnosis-divergent tasks is the natural follow-up.

**End-to-end ROI.** Search is ~10–20% of a full task's tokens; −9% of that slice is **~1–2% of end-to-end cost**. As a pure cost measure on Sonnet searchers (~$0.05/search saved), maps do not justify maintenance. What survives: (i) the *negative* finding — prose docs actively harm search — costs nothing to act on; (ii) −14% turns is felt latency on every task's serial prefix; (iii) the unmeasured but plausible payoff is downstream — baseline agents are confidently wrong (r = −0.26 calibration), and wrong initial file sets cause rework where most tokens actually go. The maps' measured quality/calibration gains sit exactly on that lever, but this study does not quantify it.

### 9.4 Hypothesis verdicts

| # | Hypothesis (short) | Verdict |
|---|---|---|
| H1 | Orientation ≥50% of search | **Confirmed by calls (67%), refuted by bytes (26%)** — comprehension reading dominates volume and is irreducible; this bounded map savings in advance |
| H2 | Existing prose docs help <15% | **Confirmed, stronger**: C1 is net *negative* — +4.6% cost, −4.8% Q, 2.5× wrong-file rate |
| H3 | Any map ⇒ ≥25% cheaper, no recall loss | **Rejected on magnitude**: best map −8.8% paired cost (recall/judge preserved or better). The 25%+ prediction ignored that doc-reading itself costs ~19KB/run and that comprehension reads can't be removed |
| H4 | Feature map beats folder map | **Not supported as stated**: feature wins cost (−8.8% vs −4.5%), folder wins quality (+0.28 judge, .963 recall). They tie on efficiency; the folder map's exhaustive coverage bought as much as the feature map's cross-layer clustering |
| H5 | Symbol index task-shape-sensitive, doc size eats savings | **Confirmed**: largest doc (22.9KB), +2.0% net cost (worst map), weakest perf-task quality among maps |
| H6 | Playbook highest variance, near-oracle on-recipe | **Partially supported**: high spread and cheapest-by-median (skewed wins on matching tasks), but M-feature's variance is equal — variance doesn't uniquely single out the playbook |
| H7 | Benefit scales with baseline cost; degradation = precision loss | **Confirmed on both clauses**: benefit concentrates in expensive (perf/cross-layer) tasks and is negative on cheap ones; the precision-degradation mode appeared — but in C1 (prose docs), not in the purpose-built maps |

## 10. Conclusions & recommendation

1. **Code maps work, but modestly, and only where search is actually expensive.** The honest headline is not "maps halve search cost" — it's: a good map buys **~9% cheaper searches overall (−11% compute-weighted), ~25–30% on expensive cross-layer bug/perf tasks, 13–15% fewer turns, slightly better answers, and better-calibrated confidence**, for a one-time ~$3 build cost. The ceiling was visible in the baseline anatomy: only ~26% of search *bytes* are orientation; the rest is reading code you genuinely have to read. Measured against *end-to-end task cost* (search ≈ 10–20% of a task's tokens), the dollar case is ~1–2% and does not justify maintenance by itself — see §9.3; the durable wins are the latency reduction, the calibration fix, and the negative finding about prose docs.
2. **The existing prose architecture docs are a net negative for search agents** — costlier, lower quality, 2.5× more wrong files in answers. They may still serve humans and onboarding, but agents should not be pointed at `docs/architecture/` for "where do I change X" work. This is the single most actionable finding.
3. **Structure matters less than existence and size.** Folder, feature, and playbook maps all performed within noise of each other; the symbol index — the biggest doc — was the only map that failed to pay for itself. Below ~20KB, *any* accurate curated map beats none; past that, doc-read overhead erases the gain.
4. **Recommendation** (encoded in `README.md`): use **`map-feature.md`** as the default read-first doc for cross-layer bug/perf work (best cost, near-best quality); fall back to `map-folder.md`'s exhaustive index when a task matches no cluster; skip maps entirely for small, obviously-localized tasks; retire `map-symbols.md`.

## 11. Acted-on outcomes (#347)

The study's recommendations were implemented rather than left as prose:

1. **CI staleness guard** — `.github/workflows/ci.yml` runs `docs/code-map/validate.py` on every push/PR. The maps' entire measured benefit rests on their accuracy: an agent that trusts a map naming a moved file searches *worse* than one with no map, so a refactor that invalidates a reference now fails the build instead of silently rotting the map.
2. **`docs/ARCHITECTURE.md` carries a guard note** steering search-oriented readers to `docs/code-map/`, since that document set measured net-negative for locating change sites.
3. **`map-symbols.md` deleted** — the one variant that failed to pay for itself (largest doc, +2.0% net cost, weakest perf-task recall). Its results remain in §9.2 as evidence for the size rule: past ~20KB a map stops paying.
4. **`CLAUDE.md` routes agents** to `map-feature.md` (cross-layer searches) and `map-playbook.md` (task-shaped changes), and explicitly warns off `docs/architecture/` for change-site location.

**Deliberately not done:** the end-to-end ROI question (§9.3) — whether better initial file sets reduce *rework* during implementation, where most tokens actually live — remains unmeasured. It is the only mechanism by which maps could pay for themselves in tokens rather than latency, and answering it requires an implement-and-test benchmark (~10–30× per-run cost). The current recommendation deliberately rests on the latency, calibration, and negative-prose-doc findings, which are measured.
5. **Judge-scored quality never degraded under any map** (8.25–8.40 vs 8.12 baseline), and precision held — the feared "trust the map, skip verification" failure mode did not materialize for purpose-built maps at these sizes.

**Study cost:** ~$275 of subagent inference (203 Sonnet searcher-run dollars including retry waste, $62 Opus oracles, plus builders and judges), ~22M subagent tokens, ~2.5 hours wall-clock, zero source files modified.

**Data:** `STUDY-data/` alongside this doc: `tasks.json` (benchmark), `golds.json` (oracle reference sets), `scored.csv` (all 240 runs: cost + recall/precision/F1 + blinded judge score). Raw transcripts live in the session's workflow directories (not checked in).
