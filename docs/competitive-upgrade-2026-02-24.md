# Competitive Upgrade – 2026-02-24 (ioBroker OpenClaw Bridge)

## Auswahl (Rotation)
- Gewähltes Repo: `ioBroker`
- Grund: Rotationsindex von `4` (`Stundenzettel_web`) auf `5` weitergedreht.

## Wettbewerbs-Research (verifizierbare Quellen)
1. Home Assistant – Automation Troubleshooting / Traces
   - https://www.home-assistant.io/docs/automation/troubleshooting/
   - Relevanz: Starker Fokus auf Testbarkeit, Dry-Run und Schritt-Nachvollziehbarkeit.
2. openHAB – Rules DSL Dokumentation
   - https://www.openhab.org/docs/configuration/rules-dsl
   - Relevanz: Ausgereifte Regel-Engine mit klarer Struktur und Diagnose-/Wartungsfähigkeit.
3. Node-RED – Working with messages
   - https://nodered.org/docs/user-guide/messages
   - Relevanz: Konsequente Message-Traceability (`_msgid`) und Debug-Orientierung.

## Direkter Vergleich (uns vs. Konkurrenz)

| Bereich | Unser Stand vor Upgrade | Konkurrenz-Stärke | Lücke |
|---|---|---|---|
| Plan-Validierung vor Ausführung | Nur echte Ausführung (`executePlan`) | HA: explizite Test-/Trace-Workflows | Kein dedizierter Dry-Run/Preflight |
| Kontext-Historie | Nur `events.context.last` | Node-RED/HA: Verlauf + Diagnose | Keine kurze Event-History für Analyse |
| Diagnostik für kritische Aktionen | Blockiert korrekt per Confirmation | Konkurrenz zeigt Ursachen vorab klarer | Vorab-Transparenz für Operatoren begrenzt |

## Abgeleitete Feature-Upgrades (produktionsreif)

### 1) `validatePlan` Action (Dry-Run/Preflight)
- Prüft Operationsliste ohne Ausführung
- Liefert pro Operation: `critical`, `confirmationRequired`, `executable`, Fehlerstruktur
- `valid`-Flag für Gesamteinschätzung

### 2) Kontext-Event-History + `getContextEvents`
- Neues State-Objekt: `events.context.history`
- Ringbuffer-ähnliche Begrenzung über `contextEventHistoryLimit` (Default 50)
- API-Action `getContextEvents` mit `limit`, sortiert neueste zuerst

## Umsetzungsplan
- Betroffene Dateien:
  - `lib/bridge.js`
  - `test/bridge.test.js`
  - `README.md`
  - `io-package.json`
  - `package.json`
- Akzeptanzkriterien:
  - `validatePlan` liefert strukturierte, deterministische Prüfresultate
  - `emitContextEvent` persistiert Last + History
  - `getContextEvents` liefert korrekt limitierten Verlauf
  - Bestehende Features bleiben rückwärtskompatibel
- Testplan:
  - Unit-Tests für `validatePlan`
  - Unit-Tests für Event-History inkl. Reihenfolge
  - Voller Testlauf `npm test`
  - Lint-Script ausführbar

## Ergebnis
- Alle geplanten Features implementiert.
- Teststatus: grün (`13/13` Tests bestanden).
