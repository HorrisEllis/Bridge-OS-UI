# Bridge OS — Desktop UI

Electron shell for [Bridge OS](https://github.com/HorrisEllis/Bridge-v2) sovereign node runtime.

## Structure

```
main.js           — Electron main process (IPC, integrity, vault, killswitch)
preload.js        — contextBridge NXAPI surface
bridge-ui.html    — Full UI (identity wizard, heart, CFR field, BrainOS canvas)
bridge-node/      — Bundled node runtime (copy of Bridge-v2)
assets/           — Icons
scripts/          — gen-manifest.js (integrity lock)
```

## Run

```cmd
npm install
START.bat
```

## Build .exe

```cmd
BUILD.bat
```

## Runtime

Requires Node.js 18+. Electron is installed via `npm install`.
Bridge OS node starts automatically when you connect the heart.

## Related

- [Bridge-v2](https://github.com/HorrisEllis/Bridge-v2) — sovereign node runtime
- rheon.world
