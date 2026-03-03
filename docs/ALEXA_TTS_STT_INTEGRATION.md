# Alexa TTS + Local STT Integration

## Overview
This adapter now supports an end-to-end voice loop:
1. Local speech-to-text (`transcribe`)
2. Intent routing (`handleIntent`)
3. ioBroker state execution (`executePlan` guarded)
4. Alexa output (`speak`) via `alexa2` state

## Required ioBroker setup
- Install/configure `alexa2` adapter.
- Verify writable speak state, e.g.:
  - `alexa2.0.<device>.Commands.speak`

Set in adapter native config:
- `alexaTtsStateId` → exact speak state id
- `sttCommand` → local STT command (default: `faster-whisper`)
- `sttModel` → e.g. `small`
- `sttLanguage` → e.g. `de`

## Actions
### `speak`
```json
{ "action": "speak", "text": "Hallo Matthias" }
```

### `transcribe`
```json
{ "action": "transcribe", "audioPath": "/tmp/cmd.wav" }
```

### `voiceCommand`
```json
{
  "action": "voiceCommand",
  "audioPath": "/tmp/cmd.wav",
  "execute": true,
  "confirmation": true,
  "speak": true,
  "speakText": "Okay, wird erledigt"
}
```

## Security/Guardrails
- Critical actions still require explicit confirmation (`confirmation: true`).
- ACL (`allowedPrefixes`) and action whitelist (`allowedActions`) apply as before.
