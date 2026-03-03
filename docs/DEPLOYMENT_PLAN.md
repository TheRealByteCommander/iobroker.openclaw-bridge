# DEPLOYMENT PLAN

## 1. Pre-deploy
- Update adapter code on host.
- Verify config values:
  - `allowedPrefixes`
  - `allowedActions`
  - `retryAttempts`
  - `retryBackoffMs`
  - `maxBatchOperations`
  - `queueHighWatermark`

## 2. Deploy
```bash
npm ci
npm test
```
Restart ioBroker adapter instance.

## 3. Post-deploy validation
Run representative commands via `control.command`:
1. `ping`
2. `batchSetStates` (small batch)
3. `syncSnapshot`
4. `getTelemetry`
5. negative path: oversize `batchSetStates` (expect `EBATCHLIMIT`)

## 4. Rollback
- Revert to previous git tag/commit.
- Restart adapter instance.

- voiceCommand
