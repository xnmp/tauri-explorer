## General 
* Use "Beads" for issue tracking - run `bd quickstart` for details - please do this before anything else. Do not modify or create files unless they have an associated Beads issue. 
* Use beads to create both high level issues (~epics) and low level issues. Be liberal in issue creation and dependency assignment.
* When working on an issue, mark it as "in_progress"
* Code with TDD in mind - where possible use a test suite and write tests before implementation. 

## The Project
* This project is building a cross-platform explorer app using Tauri and Svelte. 
* Please create implementation plans before converting into issues in Beads
* At the beginning of each session, convert the tasks in [new_todo](@new_todo.md) into beads issues (edit the md file to remove issues that have been converted), together with priorities. 
* Read the specs to implement features
* If unsure how to do something that needs research, use the research-scout subagent to research the best ways to proceed. 
* creature a new branch for each feature. 
* After implementing features, commit once. Then use the `test-fixer` subagent to get the tests passing then commit again. Then use the `code-simplifier` subagent to condense the code and commit again. Finally, use the `ui-tester` to test that the feature is working, and commit again. 
* For each feature, after running the `code-simplifier`, a verifying that the tests are all passing, and that the ui works as expected, merge back into the main branch.
* Use the `bug-fixer` subagent to fix bugs. 
* Every once in a while, use the `frontend-aesthetic-enhancer` to make it look nicer and the `architecture-reviewer` to structure the code better.
* Ensure that closed issues are well documented with all the findings and changes with enough detail to bring a new developer up to speed relatively quickly.

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