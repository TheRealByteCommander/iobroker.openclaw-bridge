# Troubleshooting (Operator-first)

## 1) Command rejected
### Symptom
`ok: false` + `EACTIONFORBIDDEN`

### Ursache
Action nicht in `allowedActions`.

### Fix
- Request korrigieren **oder** whitelist in Adapter-Config ergänzen.

---

## 2) State blocked
### Symptom
`ok: false` + `EIDFORBIDDEN`

### Ursache
State außerhalb `allowedPrefixes`.

### Fix
- State-ID auf erlaubten Prefix umstellen.

---

## 3) Critical action pending
### Symptom
`ECONFIRMREQUIRED` + Eintrag in `safety.pendingConfirmation`.

### Fix
- Kommando mit `confirmation: true` erneut senden.

---

## 4) Timeout
### Symptom
`ETIMEOUT`

### Fix
- ioBroker Last / Fremdadapter-Verfügbarkeit prüfen
- `commandTimeoutMs` moderat erhöhen

