# Preserve timing artifacts across Bash pipeline failures

GitHub Actions invokes explicit `shell: bash` steps with `-e -o pipefail`.
When a diagnostic command is piped to `tee`, a nonzero command status can end
the step before a following `PIPESTATUS[0]` assignment and timing write run.

Disable errexit only for the pipeline, immediately capture `PIPESTATUS[0]`,
restore errexit, write the log-backed timing artifact, and exit with the
captured command status. Test the parsed production workflow block under the
same Bash flags for both successful and failing commands.
