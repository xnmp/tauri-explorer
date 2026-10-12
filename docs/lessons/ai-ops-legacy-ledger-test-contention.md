# Legacy ledger convergence must exclude unrelated test contention

`model_legacy_terminal_and_released_ledger_shapes_converge` uses private ledgers
and unique package identities, but automatic reconciliation shares the
process-wide AI action mutex with other lifecycle tests. Each candidate starts
its ten-second native deadline before acquiring that mutex. Contending tests
can therefore consume a fixture's entire budget without touching its ledger.

Two expired sweeps followed by a successful third sweep reproduce the reported
Terminal/absent/verified-acquisition/already-Completed failure exactly: admission
repair commits Released/acquired and releases both artifacts, but their rows and
files remain. GC runs before candidate repair; an already Completed job needs no
presentation update, and the next periodic sweep collects the released bytes.
Production deliberately defers bounded work and retains its custody evidence.

Acquire `ai_operations::action_guard()` in this fixture before its reconciliation
sequence starts the bounded clocks, as the service recovery fixture already
does. Keep the assertions and sweep counts unchanged. The guard is reentrant on
the same thread, and this fixture's transport calls are synchronous. Verify with
real action-lock contention; isolated repetition alone does not exercise this
process-wide interference.
