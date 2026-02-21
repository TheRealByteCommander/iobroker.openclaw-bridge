# ioBroker OpenClaw Bridge (MVP)

Dieses Repository enthält ein erstes Adapter-Grundgerüst, um OpenClaw kontrollierten Zugriff auf ioBroker-States zu geben.

## Status

MVP implementiert:
- `getState`
- `setState`
- `listStates` (prefix-begrenzt)

Kommunikations-States:
- `openclaw-bridge.0.control.command` (write JSON command)
- `openclaw-bridge.0.control.lastResult` (read JSON result)

## Command-Format

```json
{
  "action": "getState",
  "id": "0_userdata.0.test"
}
```

```json
{
  "action": "setState",
  "id": "0_userdata.0.test",
  "value": true,
  "ack": false
}
```

```json
{
  "action": "listStates"
}
```

## Sicherheit

- `listStates` ist auf `native.allowedPrefixes` beschränkt (Default: `javascript.0,0_userdata.0`).
- Für produktiven Einsatz sollte ein strikteres ACL-/Token-Konzept ergänzt werden.

## Nächste Schritte

1. Adapter in ioBroker installieren/laden
2. Prefix-Policy finalisieren
3. Optional: HTTP/WebSocket-Endpunkt ergänzen
4. Optional: OpenClaw Skill ergänzen, der JSON-Kommandos automatisch bildet
