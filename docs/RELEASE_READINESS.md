# RELEASE READINESS

## Status
- Engineering: GREEN
- Test suite: GREEN
- P1 blockers: none

## Checklist
- [x] Secure action whitelist + ACL prefix enforcement
- [x] Queue overload protection
- [x] Retry/backoff for transient adapter operations
- [x] Batched write flow (`batchSetStates`)
- [x] State sync snapshot flow (`syncSnapshot`)
- [x] Rich telemetry endpoint (`getTelemetry`)
- [x] Negative path tests for oversized batches

## Known risks
- Queue/telemetry are in-memory (reset on adapter restart).
- For HA persistence, external metrics export should be added in future sprint.

- Alexa TTS speak action
