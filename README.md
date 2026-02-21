# ioBroker OpenClaw Bridge

Bridge-Adapter, um OpenClaw kontrolliert mit ioBroker-States interagieren zu lassen.

## Version 0.2.0 – neue Features

1. **Request/Response-Correlation** via `requestId` + per-request State unter `responses.<requestId>`
2. **Action-Whitelist** (`native.allowedActions`) gegen unerwünschte Befehle
3. **Timeout-Handling** (`native.commandTimeoutMs`) mit strukturiertem `ETIMEOUT`
4. **Strukturierte Fehlerobjekte** (`error.code`, `error.message`, `error.details`)
5. **Audit-/Metrik-States** unter `info.*` (Counts, letzte Action, Dauer, Fehler)
6. **Ping/Health-Action** (`ping`) für schnelle Erreichbarkeitsprüfung
7. **Batch Read** via `getStates` für mehrere State-IDs in einem Request
8. **Prefix-ACL + Ack-Policy** für `getState`/`setState`/`getStates`

## Kommunikations-States

- `openclaw-bridge.0.control.command` (write JSON command)
- `openclaw-bridge.0.control.lastResult` (last JSON response)
- `openclaw-bridge.0.responses.<requestId>` (response pro Request)
- `openclaw-bridge.0.info.*` (Audit- und Health-Metriken)

## Native-Konfiguration

- `allowedPrefixes` (CSV, default: `javascript.0,0_userdata.0`)
- `allowedActions` (CSV, default: `getState,setState,listStates,getStates,ping`)
- `commandTimeoutMs` (default: `5000`)
- `setStateAckAllowed` (default: `true`)

## Command-Schema

```json
{
  "requestId": "optional-client-id",
  "action": "getState | setState | listStates | getStates | ping",
  "id": "state-id (für getState/setState)",
  "ids": ["state-id-1", "state-id-2"],
  "value": "any (für setState)",
  "ack": false
}
```

## Response-Schema

```json
{
  "ok": true,
  "requestId": "req-123",
  "action": "getState",
  "data": {},
  "durationMs": 3
}
```

Fehlerfall:

```json
{
  "ok": false,
  "requestId": "req-123",
  "action": "setState",
  "error": {
    "code": "EIDFORBIDDEN",
    "message": "state id is not allowed: system.adapter.admin.0.alive",
    "details": null
  },
  "durationMs": 2
}
```

## Beispiele

### getState

```json
{
  "requestId": "r1",
  "action": "getState",
  "id": "0_userdata.0.test"
}
```

### getStates (Batch)

```json
{
  "requestId": "r2",
  "action": "getStates",
  "ids": ["0_userdata.0.a", "0_userdata.0.b"]
}
```

### setState

```json
{
  "requestId": "r3",
  "action": "setState",
  "id": "0_userdata.0.switch",
  "value": true,
  "ack": false
}
```

### listStates

```json
{
  "requestId": "r4",
  "action": "listStates"
}
```

### ping

```json
{
  "requestId": "r5",
  "action": "ping"
}
```

## Tests

- Unit-/Logiktests mit Node Test Runner (`node --test`)
- Enthalten: ACL-Checks, Action-Whitelist, Ack-Policy, Request-Korrelation, Batch-Read, Timeout-Handling

## Kurz-Recherche (Grundlage)

- ioBroker Dev Docs – State Roles (`common.role`) und saubere Objektmodellierung:  
  https://iobroker.github.io/dev-docs/concepts/02-state-roles/
- ioBroker Create-Adapter (offizielles Tooling/Struktur):  
  https://github.com/ioBroker/create-adapter
- ioBroker Testing Utilities (Teststrategien, Integration/Unit-Mocks):  
  https://github.com/ioBroker/testing
