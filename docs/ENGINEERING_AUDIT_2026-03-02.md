# Engineering Audit (2026-03-02)

## Architecture / Security / Reliability Findings
1. Action routing lacked batch/state-sync primitives (operational overhead for multi-state updates).
2. No first-class telemetry action for external monitoring correlation.
3. Adapter calls lacked retry/backoff under transient iobroker DB/IPC hiccups.
4. Intent routing covered limited comfort paths; missed opposite comfort intent.
5. Queue overload behavior not explicitly protected (risk under burst traffic).

## Implemented high-impact fixes
- Added `batchSetStates` action with max operation limit.
- Added `syncSnapshot` action for source-of-truth state sync snapshots.
- Added `getTelemetry` action with counters/avg duration/queue depth.
- Added retry/backoff wrapper for adapter state reads/writes.
- Added robust queue high-watermark rejection (`EQUEUEFULL`).
- Expanded intent routing for hot/cold comfort handling.
