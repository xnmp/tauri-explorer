## General
* Use "Beads" for issue tracking - run `bd quickstart` for details - please do this before anything else. Do not modify or create files unless they have an associated Beads issue.
* Use beads to create both high level issues (~epics) and low level issues. Be liberal in issue creation and dependency assignment.
* When working on an issue, mark it as "in_progress"
* Code with TDD in mind - where possible use a test suite and write tests before implementation.

## Multi-Worktree Setup
* Multiple agents may be working on this repo concurrently via separate git worktrees (e.g. `worktree-2`, `worktree-3`).
* Each worktree has a default branch matching its suffix (e.g. `worktree-2` uses `main-2`).
* **If you are on a secondary worktree (not the primary repo), rebase your default branch onto `main` before doing anything else** — e.g. `git rebase main` from `main-2`. This ensures you pick up changes merged by other agents.
* After rebasing, continue with the normal workflow (check beads, convert todos, etc.).

## The Project
* This project is building a cross-platform explorer app using Tauri and Svelte. 
* Please create implementation plans before converting into issues in Beads
* At the beginning of each session, convert the tasks in [new_todo](@new_todo.md) into beads issues (edit the md file to remove issues that have been converted), together with priorities. 
* Read the specs to implement features
* If unsure how to do something that needs research, use the `research-scout` subagent to research the best ways to proceed.
* Create a new branch for each feature.
* After implementing features, commit once before running any tests. Then run `bun run test` and fix any failures directly, then commit again. Then use `agent-browser` (CLI) directly to visually verify the feature is working (open the dev server URL, snapshot, screenshot, interact as needed), and commit again. The agent-browser docs are [here](https://github.com/vercel-labs/agent-browser). Then, if necessary, create an e2e playwright test that verifies the feature is working. Finally, run the e2e playwright tests to verify that there's no regressions.
* For each feature, after doing all of this in the previous point, merge the feature branch to main - just do this if the tests are passing and ui is working, don't ask for confirmation. Always use a merge commit. Don't delete the feature branch.
* Fix bugs directly — do not delegate implementation to subagents.
* Every once in a while, use the `frontend-aesthetic-enhancer` subagent to improve visual design, the `architecture-reviewer` subagent for design review, and the `change-reviewer` subagent for post-change review. These are read-only scouts that report back — the main agent implements any suggested changes.

## Subagent Policy
Subagents are **scouts, not workers**. Rules:
* **Never delegate implementation** (code writing, test fixing, bug fixing) to subagents. The main agent already has full context.
* **Use subagents only for read-only information gathering**: research, architecture review, change review.
* **Use CLI tools directly** instead of subagents for: running tests (`bun run test`), visual verification (`agent-browser`), linting, building.
* Ensure that closed issues are well documented with all the findings and changes with enough detail to bring a new developer up to speed relatively quickly.
* After closing each issue, append any important lessons learnt (gotchas, non-obvious behaviors, workarounds, debugging insights) to [lessons_learnt](docs/lessons_learnt.md). Include the issue ID, a brief summary, and the key takeaways. Skip if the issue was trivial with nothing noteworthy.

## Performance Testing Workflow
After completing any performance-related issue (EPIC: Performance Optimization or its children):

1. **Run relevant benchmarks before AND after the change:**
   - Backend changes: `pytest tests/benchmarks/ --benchmark-compare`
   - Frontend changes: `npm run bench:render`
   - Full stack: `npm run test:perf`

2. **Document the improvement:**
   - Add before/after metrics to the issue close comment
   - Example: "Directory scan 10k files: 450ms -> 180ms (2.5x improvement)"

3. **Run regression detection:**
   - `npm run perf:check` to compare against baseline
   - Update baseline if improvement is intentional: `npm run perf:baseline`

4. **For significant changes, run Playwright perf tests:**
   - `npm run test:playwright:perf`
   - Ensure cold start <2s, large dir render <500ms, scroll FPS >30

5. **Update baseline after verified improvements:**
   - Commit new baseline files so future regressions are caught

   
## Misc
* Use `bun` as the package manager.