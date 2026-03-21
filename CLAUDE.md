## General
* Use "Beads" for issue tracking. Key commands:
   * `bd create "Title" --id "feat/my-feature" --force -d "Description" -p P2 -t feature` — create issue (use `--force` if ID doesn't match db prefix)
   * `bd update <id> --status in_progress` — mark as in progress (hook requires this before checkout)
   * `bd update <id> -d "new description"` — update description (e.g. to add screenshot spec)
   * `bd update <id> --append-notes "notes"` — append to notes without replacing
   * `bd show <id>` — view issue details
   * `bd show <id> --json` — machine-readable output
   * `bd close <id> --reason "why"` — close issue (no need to run this - it will be done automatically by a merge hook)
   * `bd list` — list open issues
   * `bd dep add <id> --blocks <other-id>` — add dependency
   * `bd quickstart` — full reference
* Use Beads to create both high level issues (~epics) and low level issues. Be liberal in issue creation and dependency assignment.
* When creating Beads issues, include a `## Screenshots` section listing required screenshots , as a list of markdown checkboxes eg `- [ ] sidebar` (or 'None required' with a reason). Screenshots must be saved to screenshots/<branch>/. The merge hook will verify they exist. Behavioral fixes (e.g. a menu should close, a shortcut should work) still need a screenshot showing the corrected behavior — "None required" is only for pure backend/refactor changes with no user-visible effect.

## Documentation
* **Start at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — slim map with architecture diagram and pointers to deep references.
* Deep references in `docs/architecture/`: [backend](docs/architecture/backend.md), [frontend](docs/architecture/frontend.md), [components](docs/architecture/components.md), [features](docs/architecture/features.md), [cross-cutting](docs/architecture/cross-cutting.md).
* Lessons learnt: [docs/lessons_learnt.md](docs/lessons_learnt.md) — gotchas from closed issues.

## The Project
* This project is building a cross-platform explorer app using Tauri and Svelte. 
* Please create implementation plans before converting into issues in Beads
* At the beginning of each session, convert the tasks in [new_todo](@new_todo.md) into Beads issues (edit the md file to remove issues that have been converted), together with priorities. 
* If unsure how to do something that needs research, use the `research-scout` subagent to research the best ways to proceed.
* All development happens on the `dev` branch. Create feature branches off `dev` and merge back to `dev`. Don't modify files directly on the `dev` branch. 
* Every once in a while, use the `architecture-reviewer` subagent for design review. 
* The explorer app has multiple views (List, Details, Tiles). When adding UI features, ensure that they get included into all three views. 

## For Each Issue
* Create a Beads issue if none exists
* In the issue description you must include a include a `## Screenshots` section listing required screenshots that verify that witness that the issue is resolved, as a list of markdown checkboxes eg `- [ ] sidebar` (or 'None required' with a reason). Note that if the issue results in any change in UI behaviour then this should be documented with screenshots. Screenshots must be saved to screenshots/<branch>/. The merge hook will verify they exist. 
* Create a new branch. Note that the bracnh name must match the Beads issue name, and must be prefixed with feat, fix, or one of a few types (a hook will let you know if you go wrong here)
* After implementation run `bun run test` and fix any failures directly, then commit. 
* Then if screenshots are required, use `agent-browser` (CLI) to visually verify the feature is working as intended, take the required screenshots, and commit again. 
* If necessary, create an e2e playwright test that verifies the feature is working. 
* Update the necessary docs in the `docs` folder, particularly the `Architecture.md` file for feature branches, and `lessons_learnt.md` file for bugfix branches. 
* Finally, merge the feature branch to main. Use a merge commit with a descriptive, human readable commit message. Note that there'll be a hook to run e2e tests to ensure there's no regressions at this point. If there are regressions, fix them. There is no need to manually close the Beads issue. 

## Important Operational Principles

### E2E tests must assert on actual feature behavior
Don't just check that a component renders — assert on the outcome. E.g., a QuickOpen test must verify that results appear for a query, not just that the modal opened. Tests that only check "component mounts" give false confidence and miss real regressions.
