# Contributing

Thanks for your interest in improving TorrentDrop.

## Development

```bash
npm install
npm run desktop     # run the desktop app
npm start           # or run just the engine + open http://localhost:8080
```

The codebase is intentionally small and dependency-light:

- `server.js` — the engine: WebTorrent client, settings, history/schedule, and the HTTP/JSON API.
- `public/index.html` — the entire UI in one file (vanilla JS, no build step).
- `electron/main.cjs` — desktop wrapper: spawns the engine, owns the window and tray.

There is no transpile or bundle step — edit the files and reload.

## Guidelines

- Keep the UI dependency-free (vanilla JS, no framework).
- Match the surrounding code style; favor small, readable functions.
- Test changes against a well-seeded legal torrent (the in-app Sintel sample works).
- Regenerate tray icons with `npm run icons` if you change them.

## Pull requests

- Keep PRs focused on one change.
- Describe what you changed and how you verified it.
- Don't commit `node_modules/`, `dist/`, or `downloads/` (they're gitignored).

## Reporting issues

Include your OS, how you launched the app (desktop or CLI), and steps to reproduce. For download-speed reports, mention whether port 6881 is forwarded.
