# #1810 — macOS Smoke "failed" because no runner picked it up

macOS Smoke at 709dc91 concluded `failure` with its only job `cancelled` after
25 minutes and no steps. The check-run annotation said "The job was not
acquired by Runner of type hosted even after multiple attempts" next to
GitHub's notice about macOS arm64 capacity. The code under test never ran.

- Read the check-run annotations (`/check-runs/<job id>/annotations`) before
  digging into a job without logs: a 404 on the log download plus a
  `cancelled` job with no steps means a runner never took the job.
- `ci-auto-rerun.yml` now also listens to macOS Smoke. `rerunDecision` already
  treats a failed job with no steps as a setup failure, so the job gets one
  re-run, still subject to the dev-push supersession check (#1798).
- #1819: Rust platforms (macos-latest) and macOS Native UI hit the same
  not-acquired failure three times on 2026-11-18 dev pushes, so
  `ci-auto-rerun.yml` listens to them too. Any new workflow with a macOS
  hosted job belongs in that list.
