# ADR 0005: GitHub PR conversation data boundary

Status: Accepted

Governs: `src-tauri/src/github.rs`, `src/lib/api/git-log.ts`, `src/lib/components/GitGraphView.svelte`

## Context

The Git Graph decorates branches with data from a repository's public GitHub
remote. Its inline PR conversation adds review-thread authors, bodies, diff
anchors, and resolution state to that data flow. Those fields are untrusted
remote content, while GitHub GraphQL requires an optional local credential and
can reject expensive nested queries.

## Decision

- Only a locally available GitHub token authorizes the GraphQL enrichment. The
  token is sent only to GitHub's API and is never returned over IPC or logged.
- The GraphQL request is bounded: at most 100 open PRs, 50 review threads per
  PR, and 50 comments per thread. The backend defensively applies the same
  thread and comment caps to decoded data so an unexpected response cannot
  expand the IPC payload.
- Missing credentials, network/API failures, and non-GitHub remotes preserve
  the existing best-effort PR badge behavior. The REST fallback omits
  review-thread data rather than failing the Git Graph; the UI explains that
  GitHub sign-in is required for threads.
- Review text is treated as plain text end-to-end. The backend requests
  GitHub's `bodyText`, and the Svelte view renders it with normal text
  interpolation, never `{@html}` or a URL derived from review content.

## Consequences

- Conversation detail remains a bounded, optional enhancement and cannot
  block graph loading.
- Changes to GitHub PR fetching, its IPC contract, or inline conversation
  rendering must preserve these credential, size, degradation, and rendering
  boundaries and cite this ADR.
