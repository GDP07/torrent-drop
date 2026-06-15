# TorrentDrop — Desktop builds

Cross-platform Electron app. The browser UI is the front-end; a local `server.js`
WebTorrent engine (full TCP / uTP / DHT / PEX / WebRTC swarm) runs in the
background on `127.0.0.1`. Nothing is hosted; everything stays on the device.

## Build commands

```bash
npm install
npm run dist:mac     # macOS  -> .dmg + .zip  (arm64 + x64)
npm run dist:win     # Windows -> NSIS installer + portable .exe (x64)
npm run dist:all     # both (Windows part needs wine on macOS — auto-downloaded)
npm run desktop      # run the app locally without packaging
```

Output lands in `dist/`.

## Artifacts produced

| Platform | File | Notes |
|---|---|---|
| macOS Apple Silicon | `TorrentDrop-1.0.0-arm64.dmg` / `-arm64-mac.zip` | ad-hoc signed, runs locally |
| macOS Intel | `TorrentDrop-1.0.0.dmg` / `-mac.zip` | ad-hoc signed |
| Windows | `TorrentDrop Setup 1.0.0.exe` | NSIS installer, choose folder |
| Windows | `TorrentDrop 1.0.0.exe` | portable, no install |

## First run

On first launch the app shows a small **setup wizard**: pick a language, choose
whether to keep seeding after downloads (with an optional seed-ratio limit), then
done. Settings persist in the OS user-data folder and can be changed any time via
the settings button. Active torrents are restored on the next launch.

## Signing caveats (important)

These builds are **not** signed with a paid Apple/Microsoft certificate, so:

- **macOS:** ad-hoc signed so it runs on Apple Silicon, but not *notarized*.
  First open: right-click the app → **Open** → **Open** (or
  `xattr -cr /Applications/TorrentDrop.app` to clear the quarantine flag).
- **Windows:** unsigned, so SmartScreen shows "Windows protected your PC" →
  **More info** → **Run anyway**.

To ship without these prompts you need a Developer ID (Apple) and an EV/OV code
signing certificate (Windows), then wire them into electron-builder.

## Notes / known limitations

- The Windows binaries are built on macOS via electron-builder's bundled wine and
  were **not** test-launched on real Windows here — verify on a Windows machine.
- Native optional modules (`utp-native`, `bufferutil`) are not rebuilt
  (`npmRebuild: false`), so the engine uses its pure-JS / TCP fallbacks. Fine for
  downloading; uTP just isn't used.
- `asar: false` is intentional — the engine is launched with `child_process.fork`,
  which can't execute a script packed inside an asar archive.
- No custom app icon yet (uses the default Electron icon). Add `build/icon.icns`
  (mac) and `build/icon.ico` (win) and electron-builder will pick them up.
