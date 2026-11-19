# Documentation rules

Code-map and lesson conventions are in root `CLAUDE.md` § Documentation.

## Architecture passes (`architecture-pressure.md`)

- Architecture passes resume from the ledger's `Covered through` commit, not
  the previous pass's merge date. Read PR review findings and residual limits;
  a landed intervention expires its active entry. Rename-aware per-file churn
  needs `git log --follow -- <file>`; aggregate counts can differ (#1219).
- Keep architecture recurrence counts separate from corrections made inside a
  feature PR. Link existing qualification owners (for example DnD #1225) for
  platform-evidence gaps; those gaps alone do not establish a new ownership
  defect or justify a duplicate debt filing (#1251).
- PR bodies are mutable evidence: attribute post-merge integration results to
  the commit/PR that actually changed the code. A test readiness/locator fix
  is not a production ownership recurrence; inspect the producing boundary
  before counting it against an architecture trigger (#1262).
- Audit feature completion at the tested interaction: a native folder-hover
  spring probe plus a successful folder transfer does not prove a drop inside
  the temporary peek. Check linked follow-up issue state/comments too; a
  test-only coverage PR can leave its promised perf medians pending (#1277).
- Recheck closed follow-ups for explicit residuals: #1269 closed while #1283
  retained late-drop layout changes, and #1272's later comment supplied its
  missing medians. Destination capture by path set does not grant internal
  Move authority; inspect that gate before counting a provenance recurrence
  (#1288).
- A closed destination follow-up can remove its old revision policy entirely:
  #1287 routes every ended drop to its capture and excludes external path-set
  borrowing. Check the source-authority gate separately. Likewise #1296 removes
  mini-tile sizing, so earlier Tiles perf medians do not measure its larger
  panels; shared sizing is an intervention already made, not a new extraction
  to file (#1301).
- Closed-tab peek restoration keeps only bounded membership in memory, not
  listing/watch resources or persisted expansion. Pending lazy sessions must
  apply collapse/prune through the same membership policies before activation.
  Count deployed fixes per the ledger's exact paths: explorer at six fixes is
  below its **more than six** trigger, while Tiles contrast/List chrome changes
  outside those paths remain evidence without altering that count (#1319).
