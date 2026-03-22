# Custom ioBroker Repository (Option A)

Diese Datei beschreibt, wie `openclaw-bridge` als eigenes ioBroker-Repository eingebunden wird, damit Updates im Admin angezeigt werden.

## Repository-URL für ioBroker Admin

Verwende diese URL im ioBroker-Admin unter `Einstellungen -> Repositories`:

```text
https://raw.githubusercontent.com/TheRealByteCommander/iobroker.openclaw-bridge/master/repo/sources-dist.json
```

## Wichtiger Hinweis

- `sources-dist.json` enthält aktuell `url` auf den `master`-Tarball.
- Für saubere Release-Pfade empfiehlt sich später ein Wechsel auf Tag-/Release-Tarballs (`refs/tags/vX.Y.Z`).

## Update-Ablauf

1. Adapter-Version in `io-package.json` + `package.json` erhöhen.
2. Änderungen pushen.
3. `repo/sources-dist.json` Version + News aktualisieren.
4. In ioBroker Admin `Repositories aktualisieren`.

Danach erscheint die neue Version als Update im Admin.
