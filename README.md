# Bridge OS — Desktop UI

> **v4.3** · Electron · Windows · Sovereign node with a face

**Author:** James Brooks (Erosmancer) · [rheon.world](https://rheon.world)  
**License:** Proprietary — All rights reserved.  
**Runtime:** [Bridge-v2](https://github.com/HorrisEllis/Bridge-v2) — sovereign node runtime  
**Editor:** [Meteditor](https://github.com/HorrisEllis/Meteditor) — real-time causal editor

---

## What It Is

The Bridge OS Desktop UI is the Electron shell for the [Bridge OS sovereign node runtime](https://github.com/HorrisEllis/Bridge-v2). It wraps the headless node in a desktop application with a full visual interface — identity management, real-time physics visualization, a network canvas, and a boot sequence that makes the system feel alive.

This is not just a wrapper. The UI implements its own security layer independent of the node: file integrity verification at boot, a cryptographic vault system, a hardware killswitch that can permanently destroy the node's identity, and a contextBridge API surface that gives the renderer process carefully scoped access to the node without ever exposing raw IPC.

---

## Quick Start

```cmd
npm install
START.bat
```

For development with DevTools open:

```cmd
DEV.bat
```

To build a portable `.exe`:

```cmd
BUILD.bat
```

---

## Architecture

```
Bridge-OS-UI/
├── main.js           — Electron main process
├── preload.js        — contextBridge (NXAPI surface)
├── bridge-ui.html    — Full UI (all screens, all panels)
├── bridge-node/      — Bundled Bridge OS node runtime
├── assets/           — Icons, images
├── scripts/          — gen-manifest.js (integrity lock builder)
├── BUILD.bat         — electron-packager → portable .exe
├── DEV.bat           — dev mode with DevTools
└── START.bat         — direct launch
```

---

## The Main Process (`main.js`)

The Electron main process has five responsibilities:

### 1. Window Lifecycle

Creates the BrowserWindow with the correct size, frameless mode, and background colour. Handles single-instance lock — a second launch focuses the existing window rather than opening a duplicate. Persists window position and size across sessions via `bridge-os-config.json` in the Electron userData directory.

### 2. contextBridge IPC (NXAPI)

All communication between the renderer process and the outside world goes through `preload.js`'s `NXAPI` surface — a carefully scoped API that gives the UI exactly what it needs and nothing more. The renderer cannot access Node.js APIs directly. It cannot access the filesystem. It cannot make arbitrary network requests. Everything is proxied through named IPC handlers that validate input before acting.

The NXAPI surface covers:
- Node process management (start, stop, status, port)
- HTTP proxy to the Bridge OS REST API (all endpoints)
- Vault operations (create, unlock, lock, killswitch)
- File integrity verification
- Dialog (open, save, message boxes)
- Theme and display settings
- System info (platform, memory, uptime)

### 3. File Integrity Guardian

At boot, `main.js` reads `manifest.lock` — a JSON file built at package time by `scripts/gen-manifest.js` — and re-hashes every file listed in it using SHA-256. If any hash mismatches, a tamper event fires.

Three response modes (set by the vault at creation time):
- `warn` — log and notify the UI, continue normally
- `refuse` — block startup, show the tamper screen
- `kill` — trigger the killswitch immediately

### 4. Cryptographic Vault

The vault stores the node's most sensitive configuration — its data directory path, integrity mode, and killswitch arm state — encrypted with AES-256-GCM derived from a password the user sets at first run. PBKDF2-SHA256 with 310,000 iterations, 32-byte random salt.

The vault is unlocked at login. Once unlocked, it hands the data directory path to the Bridge OS node process so it can load the Ed25519 identity. The vault itself never touches the identity — it only knows where to look.

### 5. Killswitch

A hardware killswitch that, when triggered, permanently destroys the node's cryptographic identity. It cannot be undone.

**Sequence:**
1. Read the vault file path from config
2. Stat the file to get its byte length
3. Write `crypto.randomBytes(length)` over the vault (overwrite with random)
4. Write `Buffer.alloc(length, 0)` over the result (zero over the random)
5. `fs.unlinkSync` — delete the file
6. Delete `identity.key` and `identity.json` from the data directory
7. Log the destruction event with timestamp
8. `app.exit(0)`

The private key is gone. The UUID is gone. The node does not exist. No forensic recovery is possible because the file has been written to twice with different data before deletion.

The killswitch can be armed automatically on tamper detection, or triggered manually from the UI's identity management screen.

---

## The preload (`preload.js`)

The preload script runs in an isolated context with access to both Node.js and the browser DOM. It uses Electron's `contextBridge.exposeInMainWorld` to expose the `NXAPI` object to the renderer process.

`NXAPI` includes 70+ named methods covering every operation the UI needs. Methods are grouped into namespaces:

```js
NXAPI.node.*          // Node process: start, stop, status, port, dataDir
NXAPI.bridge.*        // HTTP proxy: GET, POST, fetch to any Bridge OS endpoint
NXAPI.vault.*         // Vault: create, unlock, lock, arm, killswitch
NXAPI.integrity.*     // File integrity: verify, getReport
NXAPI.dialog.*        // Dialogs: open, save, message
NXAPI.system.*        // System: platform, memory, uptime, theme
NXAPI.config.*        // Config: read, write, reset
NXAPI.on(event, fn)   // Event subscriptions: node-started, node-stopped, tamper
```

Every method is validated before the IPC call. The renderer cannot pass arbitrary shell commands, arbitrary file paths outside the configured data directory, or arbitrary network addresses outside the node's localhost port.

---

## The UI (`bridge-ui.html`)

A single 113KB HTML file containing the entire application UI — all screens, all panels, all JavaScript, all CSS. No build step. No bundler. No framework dependencies. The file is self-contained by design: it runs directly in Electron's renderer process and can be opened in a standard browser for development (with NXAPI mocked).

### Identity Wizard

The first-run experience. A Mastermind-style two-column layout that walks the user through creating their sovereign identity:

- **Name and group** — human-readable label and optional group hint for mesh clustering
- **Key generation** — P-384 ECDH keypair generated in the browser's Web Crypto API, displayed as a hex fingerprint for verification
- **Vault password** — sets the AES-256-GCM vault encryption password (PBKDF2-SHA256, 310,000 iterations)
- **Data directory** — where identity files are stored (defaults to `AppData/Roaming/Bridge OS`)
- **Integrity mode** — warn / refuse / kill (determines killswitch response to tamper detection)
- **Review** — summary of all choices before commit

On completion, the vault is created, the node is started, and the UI transitions to the live view.

### Heart Boot Sequence

A parametric heart curve used as a particle attractor, with a QRS cardiac ECG animation overlaid. The heart pulses as the node boots through 10 phases:

1. identity — Ed25519 keypair loaded
2. core + appid — SISO bus, node registry, AppID system
3. IME — behavioral memory, probationary ramp
4. sngate — enforcement gate
5. data — universal intake pipeline
6. heartbeat — BPM tracker, UDP broadcast
7. plugin — WebSocket gateway
8. causal — 1M event ring buffer, CQL engine
9. DHT — Kademlia peer discovery
10. HTTP — server live at port 3747

Each phase lights up in sequence. The heart attractor's field intensity increases as more phases complete. Boot typically takes under 100ms.

### CFR Physics Field

After boot, the live interface shows a real-time particle field rendered on a WebGL canvas. 1,200 particles in a **Van Gogh palette** (deep blues, ochres, chrome yellows) respond to the node's live operational state:

- **Structure** parameter derived from mean mesh trust score — high trust = tight, coherent clusters
- **Entropy** derived from sngate deny rate — high denial rate = turbulent, scattered motion
- **Attention** derived from active WebSocket sessions — more clients = stronger attractor pull
- **Damping** derived from heartbeat miss rate — node instability = reduced damping = more chaotic motion

The heart shape is encoded as an attractor using the parametric equation `16sin³(t)` for x and `13cos(t) - 5cos(2t) - 2cos(3t) - cos(4t)` for y. Particles orbit and breathe around this attractor, their motion encoding the system's health.

**Stress events** fire as visual shockwaves — radial repulsion bursts that scatter particles — whenever security events, node failures, or anomalies occur. The field tells you the system's emotional state before you read the log.

### BrainOS v5 Canvas

An infinite pan/zoom canvas for building node networks. Full interaction model:

- **Pan** — middle mouse drag or space + left drag
- **Zoom** — scroll wheel with smooth easing
- **Node creation** — right-click anywhere to add a node
- **Connections** — enter link mode (L key), click source, click target
- **Context menu** — right-click a node for inspect, connect, delete, highlight
- **Connection requests** — incoming peer connections appear as animated cards that can be accepted or declined

Canvas state persists via `bridge-canvas` module — positions, connections, and labels survive restarts.

**DHT peer integration**: the canvas can pull live peer data from the Bridge OS node (`GET /nodes`) and render each registered peer as a canvas node, with trust scores visualised as connection line thickness and node glow intensity.

### Network Panel

Live view of the mesh:
- All registered nodes with UUID, short ID, LAN address, trust score, and lifecycle state
- LAN subnet scanner (probes full `/24` in parallel batches of 25)
- DHT routing table viewer
- Heartbeat BPM graph per node
- Trust score history per peer

### Event Feed

Scrolling real-time log of all bus events. Each event shows: timestamp, type, classification (ok/warn/err/cfr), and a short summary. Events classified as errors trigger a subtle red flash on the feed border. CFR events trigger a field parameter update. The feed auto-scrolls but pauses on hover.

### Sigma Regime Display

The current causal health regime — **STABLE**, **DEGRADED**, **COLLAPSING**, or **OSCILLATORY** — shown as a colour-coded badge that updates every 500ms. Colour mapping: green (stable), amber (degraded), red (collapsing), purple (oscillatory).

### Identity Management

- Current UUID and short ID
- Public key fingerprint (hex)
- Vault lock/unlock
- Killswitch arm/trigger (guarded by confirmation dialog)
- AppID management — create trust codes, list active sessions
- Export public record (for sharing with trusted peers)

---

## Build System

### `START.bat` — Direct Launch

```bat
node_modules\.bin\electron.cmd . %*
```

Uses the locally installed Electron binary. Validates `main.js` is present before launching. Pauses on exit so errors are visible.

### `DEV.bat` — Development Mode

Passes `--dev` flag which opens DevTools automatically and enables verbose logging from the main process.

### `BUILD.bat` — Package to .exe

Uses `electron-packager` to produce a portable `.exe`:

```bat
npx electron-packager . "Bridge OS" ^
  --platform=win32 --arch=x64 ^
  --out=dist --overwrite ^
  --icon=assets\icon.ico ^
  --app-version=4.3.0
```

Before packaging, `scripts/gen-manifest.js` hashes all application files and writes `manifest.lock` — the integrity reference used by `main.js` at runtime.

---

## File Integrity

`manifest.lock` is a JSON file with this shape:

```json
{
  "built": "2026-05-02T20:27:00.000Z",
  "version": "4.3.0",
  "files": {
    "main.js": "a3f8c2d1...",
    "preload.js": "b7e4f9a2...",
    "bridge-ui.html": "c1d5e8f3...",
    "bridge-node/bridge-node/boot.js": "d9f2a1b4...",
    ...
  }
}
```

At boot, `main.js` re-hashes every listed file with SHA-256 and compares against the stored values. Any mismatch triggers the configured integrity response (warn / refuse / kill).

`scripts/gen-manifest.js` regenerates `manifest.lock` — run it before every build, or wire it into `BUILD.bat` as a pre-step.

---

## The Bundled Runtime (`bridge-node/`)

The `bridge-node/` directory is a copy of the [Bridge-v2](https://github.com/HorrisEllis/Bridge-v2) runtime, bundled with the UI for distribution. It is the full sovereign node — all 29 modules, Causal Nexus v5.0.1, boot.js, index.js.

The Electron main process spawns `bridge-node/index.js` as a child process when the user connects. It communicates with it via HTTP on the configured port (default 3747). The UI never forks into the node process — they are fully separate processes, communicating only over HTTP.

**To update the bundled runtime:** copy the new `bridge-node` source from [Bridge-v2](https://github.com/HorrisEllis/Bridge-v2) and regenerate `manifest.lock`.

---

## UI Versions Included

| File | Description |
|------|-------------|
| `bridge-ui.html` | v4.3 — current production build |
| `bridge-os-v4.3-ui.html` | Same as above (versioned copy) |
| `bridge-os-v4.2-ui.html` | Previous version — LAN subnet scanner added |
| `brainos-cfr-v6.html` | CFR 3D standalone — WebGL point shader, Van Gogh particle field, full Bridge OS polling, no Electron dependency |

`brainos-cfr-v6.html` can be opened directly in any modern browser for a standalone physics visualization that connects to a running Bridge OS node at `localhost:3747`.

---

## Security Model

The UI adds a security layer on top of the node's own security:

**Vault encryption**: AES-256-GCM with PBKDF2-SHA256 (310,000 iterations). The vault is the only path to the node's data directory. Without the vault password, the node's Ed25519 identity cannot be loaded.

**Integrity verification**: every file is hashed at boot and compared against the signed manifest. Tamper detection triggers a configured response up to and including identity destruction.

**Killswitch**: a voluntary capability to permanently destroy the node's identity if the machine is compromised. Three-pass destruction (random → zero → delete) makes forensic recovery of the key material impossible.

**contextBridge isolation**: the renderer process has no direct access to Node.js, the filesystem, or the network. All operations go through named, validated IPC handlers. The renderer cannot be used to exfiltrate data or execute arbitrary system commands even if the bridge-ui.html is compromised.

---

## Related Projects

| Repo | Description |
|------|-------------|
| [Bridge-v2](https://github.com/HorrisEllis/Bridge-v2) | Sovereign node runtime — all 29 modules, Causal Nexus, CFR |
| [Meteditor](https://github.com/HorrisEllis/Meteditor) | Real-time causal editor — element picker, chain walker, .nex revert |

---

## License

Copyright © 2024–2026 James Brooks (Erosmancer). All rights reserved.  
Proprietary software.  
[rheon.world](https://rheon.world)
