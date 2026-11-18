# Vitest suite rules

The default home for every fix's regression test (root `CLAUDE.md`, three test
tiers). Browser-test rules: `e2e/CLAUDE.md`; native: `e2e-tauri/CLAUDE.md`.

## Workers and deadlines

The unit suite defaults to four workers to bound concurrent cold transforms;
explicit Vitest worker overrides remain available, and perf tests stay serial.
Behavioral test files keep their five-second deadlines (#993 PR repair). The
native suite's `bun run check:e2e:tauri` is a CI step of its own, not a Vitest
test (#1123).

The graph-lineage unit file includes a wall-clock hover budget, and the
5,001-activation registry churn file a deadline that competing transforms can
exhaust. Both run one file at a time in `vitest.perf.config.ts`, after the
parallel unit suite (`tests/serial-unit-files.ts`, #1123), with their budgets
unchanged; scheduler contention is not graph execution time.

## Teardown

`createWindowTabsManager().dispose()` is asynchronous: await it in test teardown so
explorer directory-listener cleanup settles before Vitest closes the worker (#611).

## Compiler and typecheck probes

The native suite's public TypeScript command uses incremental compiler metadata
under node_modules/.cache. Repeated typechecks must still validate changed imported
contracts and recover after errors; do not alter the existing five-second test
deadline to compensate for host load. Metadata is disposable, not acceptance proof.

Compiler regression probes resolve TypeScript's CLI through Node package
resolution from the test module. Review checkouts may inherit dependencies from
an ancestor; a checkout-relative node_modules/typescript path is not portable.
Keep the real compiler and every cold/warm/error/recovery assertion intact.

`tests/child-env-compile.test.ts` (Windows metadata check for the child-env
compiler regression, #1179): see `src-tauri/CLAUDE.md` § Portable tests.

## Website relay imports

The root Vitest suite imports the report relay from `website/`; keep its
`@vercel/blob` runtime and compatible Undici major in the root test-harness
dev dependencies as well as the independently deployed website package.
