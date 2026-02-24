# Conversational Home Automation Architecture (OpenClaw ↔ ioBroker)

## Zielbild

Diese Bridge bildet eine sichere Übersetzungsschicht zwischen natürlicher Sprache (OpenClaw) und deterministischen ioBroker-Operationen (States/Objekte).

## Komponenten

1. **OpenClaw NLU/Dialogue Layer**
   - erkennt Intents, Follow-up Fragen, Dialogkontext
2. **Bridge Adapter (`openclaw-bridge`)**
   - nimmt JSON-Commands entgegen
   - setzt ACL/Sicherheitsregeln durch
   - mappt Komfort-/Habit-/Energy-Intents auf konkrete Operationen
3. **ioBroker Runtime**
   - führt State-Änderungen aus
   - triggert bestehende Skripte/Adapter (z. B. Szenen, Zigbee, Shelly)

## Datenflüsse

### A) Lesen/Schreiben

- `getState`, `getStates`, `listStates`, `setState`
- harte Präfix-ACL (`allowedPrefixes`) schützt vor Seiteneffekten außerhalb erlaubter Bereiche

### B) Conversational Intent

- `handleIntent` erzeugt **Planobjekt**:
  - `operations[]` (deterministische Aktionen)
  - `contextEvents[]` (Habit-/Kontextsignale)
- optional direkte Ausführung (`execute=true`)

### C) Safety-Gate

- `executePlan` bewertet jede Operation:
  - allowed prefix?
  - critical prefix?
  - confirmation vorhanden?
- bei fehlender Bestätigung:
  - kein Write
  - Eintrag in `safety.pendingConfirmation`
  - Fehlercode `ECONFIRMREQUIRED`

### D) PV-Überschuss

- `handlePvSurplus(watts)`
- vergleicht mit `pvSurplusMinWatts`
- schaltet `pvSurplusLoadStateId` auf true/false
- erzeugt Event `pv_surplus_evaluated`

## Intent-Beispiele als natürlicher Dialog

### Beispiel 1: Komfort

- User: „Mir ist kalt.“
- OpenClaw: sendet `handleIntent`
- Bridge: plant `setState(comfortTemperatureStateId, +1°C)` + Event `user_feels_cold`
- Optional: direkte Ausführung

### Beispiel 2: Kritische Aktion

- User: „Schalte den Adapter admin aus.“
- Plan enthält `system.*` Ziel
- Bridge fordert Bestätigung (`ECONFIRMREQUIRED`)
- OpenClaw fragt nach: „Das ist kritisch. Wirklich ausführen?“

### Beispiel 3: PV-Überschuss

- Sensor meldet 2200 W
- OpenClaw oder Automationslogik ruft `handlePvSurplus`
- Bridge aktiviert Überschuss-Last (z. B. Warmwasser-Boost)

## Fehler- und Response-Modell

Jede Response ist strukturiert:

- `ok`
- `requestId`
- `action`
- `data` oder `error` (`code`, `message`, `details`)
- `durationMs`

## Betriebsreife / Production-Readiness

- korrelierte Antworten pro Request
- Timeouts gegen hängende Operationen
- Audit-Zähler (`info.*`)
- Policy-Driven Runtime über `native` Config
- explizite Erweiterungspunkte (`buildIntentPlan`, `executePlan`)

## Erweiterungen (Roadmap)

- Rollen-/Benutzer-basierte Freigaben
- 2-Faktor Confirmation Tokens
- Zeitfenster-Policies (z. B. nachts keine lauten Geräte)
- Lernende Habit-Profile via externer Event-Sink
