# ioBroker OpenClaw Bridge

Produktionsnahe Interface-Schicht zwischen OpenClaw (Conversational Agent) und ioBroker.

## 1) Repo-Analyse (Stack & Module)

- **Stack:** Node.js (CommonJS), ioBroker Adapter Core (`@iobroker/adapter-core`), Node Test Runner (`node --test`)
- **Adapter-Typ:** Daemon/Misc-Data
- **Kernmodule:**
  - `main.js` – ioBroker Adapter Lifecycle
  - `lib/bridge.js` – Command Gateway, ACL, Safety, Intent/Context/PV-Logik
  - `test/bridge.test.js` – Unit-/Logiktests

## 2) OpenClaw ↔ ioBroker Interface

### Kommunikationskanäle (States)

- `control.command` *(write)*: JSON-Request von OpenClaw
- `control.lastResult` *(read)*: letzte JSON-Response
- `responses.<requestId>` *(read)*: korrelierte Response pro Request
- `info.*`: Audit/Health Metriken
- `intents.lastPlan`: letzter Intent-Plan
- `events.context.last`: letztes Context/Habit/Event
- `safety.pendingConfirmation`: gepufferte kritische Aktion

### Request-Schema

```json
{
  "requestId": "optional",
  "action": "getState | setState | listStates | getStates | ping | help | handleIntent | executePlan | validatePlan | emitContextEvent | getContextEvents | handlePvSurplus"
}
```

### Sicherheits- und Policy-Prinzipien

1. **Prefix ACL** über `allowedPrefixes`
2. **Action-Whitelist** über `allowedActions`
3. **Kritische Präfixe** über `criticalStatePrefixes`
4. **Bestätigungszwang** für kritische Operationen (`ECONFIRMREQUIRED`)
5. **Ack-Policy** über `setStateAckAllowed`
6. **Timeout + strukturierte Fehler**

## 3) Intent/Context/Habit/PV/Komfort

### `handleIntent`

Parst natürliche Sprache und erzeugt einen ausführbaren Plan (`operations[]`) plus Kontext-Events.

**Beispiel (Komfort):**

```json
{
  "requestId": "intent-1",
  "action": "handleIntent",
  "text": "mir ist kalt",
  "currentTargetTemp": 21,
  "execute": true,
  "confirmation": true
}
```

Ergebnis: Plan mit `setState` auf `comfortTemperatureStateId` (+ `comfortTempStep`) und Context Event `user_feels_cold`.

### `emitContextEvent`

Schreibt strukturierte Kontext-/Habit-Events.

```json
{
  "action": "emitContextEvent",
  "event": {
    "type": "habit",
    "name": "arrived_home",
    "confidence": 0.88
  }
}
```

### `executePlan`

Führt Plan-Operationen aus (`setState`). Kritische IDs benötigen explizite Bestätigung.

### `validatePlan`

Prüft Operationen vor der Ausführung (ACL, kritische IDs, Bestätigungsbedarf) und liefert ein strukturiertes Ergebnis für Dry-Run/Preview.

### `getContextEvents`

Liest die letzten Kontext-Events aus `events.context.history` (neueste zuerst, limitierbar).

```json
{
  "action": "executePlan",
  "confirmation": true,
  "operations": [
    {
      "type": "setState",
      "id": "0_userdata.0.light.livingroom",
      "value": true,
      "ack": false,
      "reason": "intent.turn_on_light"
    }
  ]
}
```

### `handlePvSurplus`

Ermittelt anhand aktueller PV-Leistung, ob ein Überschuss-Modus aktiviert wird.

```json
{
  "action": "handlePvSurplus",
  "watts": 1850,
  "confirmation": true
}
```

Schreibt bool auf `pvSurplusLoadStateId` wenn `watts >= pvSurplusMinWatts`.

## 4) Beispiel-Datenfluss (natürlicher Dialog)

1. User: **„Mir ist kalt.“**
2. OpenClaw → `handleIntent`
3. Bridge erzeugt Plan: Temperatur +1°C, Event `user_feels_cold`
4. Bei `execute=true`: Bridge führt Plan aus (Policy/Safety geprüft)
5. Response unter `responses.<requestId>` + Audit in `info.*`

## 5) Erweiterbarkeit

- Neue Intents im `buildIntentPlan()` ergänzen
- Plan-Operationen (z. B. Dimmwerte, Szenen) via `executePlan` erweitern
- Weitere Safety-Layer: Zeitfenster, MFA-Tokens, Rollenmapping
- Context-Pipeline an externe ML/NLU Komponenten andockbar


## Quickstart: Alexa TTS + lokale STT

### Ziel
In 5 Minuten lauffähiger Operator-Flow: **STT-Text rein → Intent prüfen → sicher ausführen → Alexa spricht Feedback**.

### 1) Basis-Check
```json
{ "action": "ping" }
```

```json
{ "action": "help" }
```

### 2) STT Text in Bridge geben (Dry-Run)
```json
{
  "action": "handleIntent",
  "text": "mir ist kalt",
  "execute": false
}
```

### 3) Plan validieren
```json
{
  "action": "validatePlan",
  "confirmation": false,
  "operations": [
    { "type": "setState", "id": "0_userdata.0.hvac.livingRoom.targetTemperature", "value": 22 }
  ]
}
```

### 4) Sicher ausführen
```json
{
  "action": "executePlan",
  "confirmation": true,
  "operations": [
    { "type": "setState", "id": "0_userdata.0.hvac.livingRoom.targetTemperature", "value": 22 }
  ]
}
```

### 5) Alexa TTS Feedback
```json
{
  "action": "setState",
  "id": "alexa2.0.Echo_Living.speak",
  "value": "Die Temperatur wurde angepasst.",
  "ack": false
}
```

Für vollständige Operator-Flows und Troubleshooting siehe:
- `docs/ALEXA_TTS_STT_INTEGRATION.md`
- `docs/TROUBLESHOOTING.md`

## 6) Setup

1. Adapter installieren/klonen
2. Instanz `openclaw-bridge.0` starten
3. Native-Config setzen:
   - `allowedPrefixes`
   - `allowedActions`
   - `criticalStatePrefixes`
   - `comfortTemperatureStateId`
   - `pvSurplusLoadStateId`
4. OpenClaw sendet Requests als JSON in `control.command`

## 7) Native-Konfiguration

- `allowedPrefixes` (CSV, default `javascript.0,0_userdata.0`)
- `allowedActions` (CSV)
- `commandTimeoutMs` (default `5000`)
- `setStateAckAllowed` (default `true`)
- `criticalStatePrefixes` (default `system.,admin.0`)
- `requireConfirmationActions` (default `executePlan`)
- `comfortTemperatureStateId` (default `0_userdata.0.hvac.livingRoom.targetTemperature`)
- `comfortTempStep` (default `1`)
- `contextEventHistoryLimit` (default `50`)
- `pvSurplusMinWatts` (default `1500`)
- `pvSurplusLoadStateId` (default `0_userdata.0.energy.pvSurplusMode`)


## 8) UX-orientierte Verbesserungen (2026-03-02)

1. **Command-Semantik klarer (`help`)**
   - Neue Action `help` liefert erlaubte Actions, Safety-Kontext und QuickStart-Beispiele.

2. **Sicherere Confirmation-Flows**
   - Bei kritischen Aktionen enthält `safety.pendingConfirmation` nun `nextAction`, damit Operatoren nicht raten müssen.

3. **Fehler besser bedienbar**
   - Strukturierte Fehler enthalten jetzt `nextAction` (operator-guided recovery).

4. **Dokumentation für Setup/Troubleshooting**
   - `docs/OPERATOR_SETUP_FLOW.md`
   - `docs/TROUBLESHOOTING.md`

## 9) Tests

```bash
npm test
```

Abgedeckt:

- ACL/Action-Whitelist
- Timeout/Fehlerstruktur
- Request-Korrelation
- Intent-Mapping („mir ist kalt“)
- Safety-Confirmation für kritische Aktionen
- PV-Überschuss-Trigger

## 10) Referenz-API für OpenClaw-Integration

Empfohlenes OpenClaw Tooling-Schema:

```json
{
  "tool": "iobroker_bridge_command",
  "input": {
    "requestId": "uuid",
    "action": "handleIntent",
    "text": "mir ist kalt",
    "execute": true,
    "confirmation": true
  }
}
```

Polling/Antwort:

- primär `responses.<requestId>`
- fallback `control.lastResult`


## New Engineering Capabilities (2026-03-02)

- `batchSetStates`: execute bounded batched set-state operations.
- `syncSnapshot`: fetch current allowed-prefix state snapshot.
- `getTelemetry`: runtime metrics (`counts`, `queueDepth`, `avgDurationMs`, `uptimeMs`).
- Retry/backoff for adapter read/write operations.
- Queue high-watermark guard with explicit `EQUEUEFULL` error.
- Extended comfort intent routing (`mir ist heiß` / `mir ist kalt`).

### Example: batch set
```json
{
  "action": "batchSetStates",
  "confirmation": true,
  "operations": [
    { "type": "setState", "id": "0_userdata.0.light.a", "value": true },
    { "type": "setState", "id": "0_userdata.0.light.b", "value": false }
  ]
}
```


## Voice I/O (Alexa + local STT)

New actions:
- `speak` – writes TTS text to configured Alexa speak state
- `transcribe` – local STT command wrapper for an audio file
- `voiceCommand` – end-to-end: transcribe -> intent -> optional execution -> optional speak

See: `docs/ALEXA_TTS_STT_INTEGRATION.md`
