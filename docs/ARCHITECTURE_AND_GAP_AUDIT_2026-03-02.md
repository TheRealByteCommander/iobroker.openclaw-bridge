# Architecture & Gap Audit (Engineering-first)

## Security
- ACL prefix enforcement: present.
- Action whitelist: present.
- Gap closed: bounded batch writes now protected (`maxBatchOperations`, `EBATCHLIMIT`).

## Reliability
- Gap closed: retry/backoff wrapper for adapter read/write operations.
- Gap closed: queue overload guard (`queueHighWatermark`, `EQUEUEFULL`).
- Gap closed: richer telemetry to observe failures and latency trends.

## Adapter capabilities
- Gap closed: lacked bulk state write action -> `batchSetStates`.
- Gap closed: lacked source-of-truth snapshot -> `syncSnapshot`.
- Gap closed: lacked telemetry read action -> `getTelemetry`.
- Gap closed: limited intent routing -> hot/cold comfort mapping.

## Remaining non-blocking items
- Persist telemetry window across adapter restart (currently in-memory only).
- Optional external metrics exporter (Prometheus/Influx) for long-term observability.
