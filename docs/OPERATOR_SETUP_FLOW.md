# Operator Setup Flow (ioBroker OpenClaw Bridge)

## Ziel
Schneller, sicherer Start ohne trial-and-error.

## 1) 5-Minuten-Setup
1. Adapter starten (`openclaw-bridge.0`).
2. In `native` nur die wirklich benötigten Prefixe in `allowedPrefixes` setzen.
3. Kritische Präfixe in `criticalStatePrefixes` prüfen.
4. Smoke-Command senden:
   - `{ "action": "ping" }`
5. Hilfe abrufen:
   - `{ "action": "help" }`

## 2) Safe Operation Reihenfolge
1. Erst `validatePlan`
2. Dann (wenn nötig) `executePlan`
3. Bei kritischer Aktion immer `confirmation: true`

## 3) Fehlerszenario-Entscheidung
- `EACTIONFORBIDDEN` → Action korrigieren oder `allowedActions` anpassen
- `EIDFORBIDDEN` → State-ID/Prefix korrigieren
- `ECONFIRMREQUIRED` → Kommando mit `confirmation: true` erneut senden
- `ETIMEOUT` → Last/Timeout prüfen

## 4) Operator-Kurzbefehle
- Readiness: `ping`
- Schema-Hilfe: `help`
- Dry-run Sicherheit: `validatePlan`

