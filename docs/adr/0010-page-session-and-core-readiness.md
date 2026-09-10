# ADR 0010: Page-session ownership and foreground readiness

Status: Accepted

Governs: `src/routes/+page.svelte`, `src/lib/state/window-session.ts`,
`src/lib/state/window-startup.ts`, `src/lib/domain/window-launch-plan.ts`,
`src/test-support/window-session-probe.ts`

## Decision

The page owns rendering and its reactive appearance/readiness observations.
`startWindowSession` composes its subscriptions, command-registration microtask,
optional warm-prime timer, and settings/theme/plugin startup. It returns a
synchronous, idempotent disposer for Svelte's `onMount` contract. Each acquired
cleanup is recorded separately; failure during later setup rolls back earlier
resources, and a cleanup failure cannot prevent remaining cleanup.

`planWindowLaunch` computes validated query/cwd/home precedence, child restoration
policy, and inherited view mode without reading browser state or starting work.
The session starts tab navigation synchronously. Configuration and optional plugin
activation never become a prerequisite for that navigation.

Core readiness means configured settings, registered commands, a completed
initial listing, and the page's existing two-frame paint opportunity. This remains
an application signal, not proof of OS presentation. Only after that signal may
the session schedule its delayed automatic warm prime. Parked/measure/picker
sessions do not prime another window. Disposal revokes both queued registration
and the pending prime.

Window-scoped stores retain their own data and operation lifetimes. Page teardown
does not destroy the tab manager or cancel accepted file operations. Plugin startup
and retirement retain `startWindowStartup` and the registry's existing contracts.
Do not introduce another refresh policy owner: filesystem refresh still follows
refresh-manager / pane-watch / pane-refresh.

Native E2E dispatch lives in an opt-in module with a literal compile-time import
guard, so ordinary builds do not emit its assets. An aborted session cannot install
hooks, publish late readiness/results, or dispatch operations after a lazy import.
Already accepted navigation, mutation, launch and transfer work remains with its
existing domain owner; cancellation must not strand an accepted transfer halfway.

## Evidence and limits

The previous page starts optional warm priming before readiness when settings
reads are slow. The same browser test fails on the actual previous page and passes
with the session owner in Chromium and WebKit. Unit contracts cover immediate
navigation, queued-work retirement, rollback, picker/parked behavior, launch input
policy, and late probe dispatch. Native acceptance covers transfer, warm activation/
fallback/claim expiry, real watcher timing and config reload.

The small composition overhead is subject to the existing startup payload budget.
This change does not establish macOS launch latency or replace native platform
acceptance. See `docs/review-completion.md` for current results.

Reference: [Svelte lifecycle hooks](https://svelte.dev/docs/svelte/lifecycle-hooks)
requires a synchronous mount callback to return unmount cleanup; asynchronous
resources must retain their own explicit teardown contracts.
