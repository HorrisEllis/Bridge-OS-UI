# Bridge OS — Sovereign Distributed Node Runtime

> **v4.1.0** · 29 modules · 630+ passing tests · Zero external runtime dependencies on Windows

**Author:** James Brooks (Erosmancer) · [rheon.world](https://rheon.world)  
**License:** Proprietary — All rights reserved. See [LICENSE](LICENSE).  
**Repository:** [github.com/HorrisEllis/Bridge-v2](https://github.com/HorrisEllis/Bridge-v2)

---

## What It Is

Bridge OS turns any machine into a cryptographically-identified, self-governing peer in a private mesh network. No cloud coordinator. No central server. No registration. Two machines running Bridge OS can find each other, authenticate each other, and communicate — without any third party knowing they exist.

Each node:
- Generates its own Ed25519 identity on first boot (UUID = SHA-256 of public key)
- Maintains behavioral memory of every peer it has ever seen
- Makes independent trust decisions using Bayesian estimation + a programmable gate
- Records everything in a 1-million-entry causal graph queryable by type, chain, and time
- Speaks HTTP, Bluetooth Low Energy, and TCP — automatically picking the best available transport
- Runs a real-time physics visualization of the entire mesh

---

## Quick Start

```bash
# Install
git clone https://github.com/HorrisEllis/Bridge-v2.git
cd Bridge-v2
npm install

# Start the node
node index.js

# In a second terminal — interactive CLI
node index.js --cli
```

The node is live at **your machine's LAN IP on port 3747**. Check the boot output for the exact address:

```
  ●  Online in 0.08s
  │  UUID     4a71196a-021f-a030-1844-9fb0af87e6d4
  │  ShortID  4a71196a
  │  LAN      http://192.168.1.42:3747
  │  CLI      node index.js --cli
  └  nexus://4a71196a
```

---

## Networking — How Two Nodes Find Each Other

Bridge OS uses **real machine IPs**, not localhost. Each node discovers all its network interfaces on boot, advertises the best LAN address, and the CLI connects there automatically.

### Same machine, two nodes

The second node detects port 3747 is taken locally and negotiates a free ephemeral port automatically. Both nodes appear in each other's peer registry.

### Two machines on the same LAN

Both start on port 3747 — no conflict because they're on different machines. The CLI scans the LAN subnet on startup, finds all Bridge nodes, and shows you the full list with IPs:

```
nexus@3747 ❯ mesh scan
  ●  192.168.1.42:3747  lan   uuid=4a71196a  (this machine)
  ●  192.168.1.87:3747  lan   uuid=c297f838  (remote)
```

Connect to a remote node's CLI:

```bash
node index.js --cli --host 192.168.1.87 --port 3747
```

Or connect via HTTP from anywhere on the LAN:

```bash
curl http://192.168.1.87:3747/health
```

### Across networks (internet)

Nodes find each other via DDNS: the DDNS client registers `<uuid>.nexus.mesh` DNS records pointing to each node's current public IP. Once discovered, they authenticate via Ed25519 handshake and communicate over HTTP or the onion router.

### Via Bluetooth (no WiFi required)

On Windows, Bridge OS uses the internal Bluetooth hardware chip — no driver swap, no USB dongle. Within ~30 metres, nodes discover each other via BLE and communicate directly:

```
nexus@3747 ❯ ble scan
nexus@3747 ❯ ble discovered
  shortId   rssi   address              name
  c297f838  -62    AA:BB:CC:DD:EE:FF    BRIDGE:c297f838

nexus@3747 ❯ ble connect c297f838
nexus@3747 ❯ ble send c297f838 hello
```

---

## The 29 Modules

| Module | Role | Status |
|--------|------|--------|
| bridge-identity | Ed25519 keypair, UUID = SHA-256(pubKey), keystore | ✓ complete |
| bridge-core | SISO event bus, callto registry, node registry | ✓ complete |
| bridge-IME | Behavioral memory, trust scoring, probationary ramp | ✓ complete |
| bridge-sngate | Three-state gate (allow/deny/observe), rule introspection | ✓ complete |
| bridge-data | Universal intake pipeline | ✓ complete |
| bridge-heartbeat | BPM tracker, UDP pulse :7777, liveness | ✓ complete |
| bridge-contracts | Boot-time interface enforcement, 5ms IME contract | ✓ complete |
| bridge-appid | AppID registry, nexus:// trust codes, session tokens | ✓ complete |
| bridge-plugin | WebSocket gateway for Guardian/Tampermonkey | ✓ complete |
| bridge-mesh | ECDH peer channels, Bayesian trust-mesh | ◐ partial |
| bridge-causal | 1M ring buffer, CQL, WAL, sigma classifier | ✓ complete |
| bridge-dht | Kademlia DHT, Ed25519-signed records | ✓ complete |
| bridge-ollama | Local LLM driver (Ollama), bus-driven streaming | ✓ integrated |
| bridge-gateway | HTTP API gateway :3748, rate limiting, CORS | ✓ complete |
| bridge-ddns | DDNS client (Cloudflare/No-IP) + custom DNS server | ✓ complete |
| bridge-proxy | HTTP/HTTPS reverse proxy with SNI routing | ✓ complete |
| bridge-ssh | SSH transport, session management | ✓ active |
| bridge-guardian | Browser extension endpoint, Guardian handshake | ✓ complete |
| bridge-health | Mesh health score, auto-heal, delta replay, divergence alerts | ✓ complete |
| bridge-onion | Multi-hop onion routing, ECDH P-256, AES-256-GCM | ✓ complete |
| bridge-steg | Steganographic channels (JSON + HTTP header) | ✓ complete |
| bridge-shaper | Traffic shaping, TLS-aligned padding, Gaussian jitter | ✓ complete |
| bridge-transport | Unified transport: HTTP + BLE + cellular | ✓ complete |
| bridge-mobile | Power budget, checkpoint, watchdog, Pi installer | ✓ complete |
| bridge-ipfs | IPFS CIDv0 content-addressed storage, DHT providers | ✓ complete |
| bridge-bayesian | Beta belief engine, temporal decay | ✓ complete |
| bridge-magnet | nexus:// URI 7-level resolution cascade | ✓ complete |
| bridge-routing | TCP mesh router :3749 | ✓ complete |
| module-registry | Runtime hot-unload/reload, /module/* routes | ✓ complete |

---

## HTTP API — Port 3747

All endpoints return JSON. CORS enabled. Optional API key via `NEXUS_API_KEY` env var.

```
GET  /health                    Full diagnostics + real network addresses
GET  /identity                  UUID, public key, all reachable endpoints
GET  /network                   All network interfaces, scopes, LAN/VPN/public IPs
POST /pulse                     Register a client (any instanceId, any language)
GET  /nodes                     All registered nodes
GET  /calltos                   Callto registry
POST /callto                    Execute a browser action via Guardian
GET  /magnet/:shortId           Resolve 8-char short ID to full address
POST /magnet/resolve            Full nexus:// URI cascade resolution
GET  /trust/stats               Trust mesh statistics
GET  /trust/score/:uuid         Per-peer trust score + snapshot
GET  /ime/profile/:uuid         Behavioral profile for a UUID
GET  /sngate/trace              Last 100 gate decisions with matchPath
GET  /sngate/rules              Active gate rules
POST /sngate/rules              Add a rule
GET  /causal/stats              Ring stats, WAL status
GET  /causal/classify           Sigma regime: stable/degraded/collapsing/oscillatory
POST /causal/query              CQL query against 1M causal ring
POST /appid/create              Create AppID + one-time nexus:// trust code
POST /appid/redeem              Exchange trust code for session token
POST /data/push                 Push event through intake pipeline
POST /mesh/*                    Mesh peer operations
GET  /dht/peers                 DHT routing table
POST /dht/find                  Kademlia iterative lookup
GET  /dht/stats                 DHT statistics
GET  /cfr/*                     Physics field: nodes, field, deltas, stream
POST /cfr/emit                  Emit bus event from HTTP
POST /cfr/simulate              Inject simulation event
GET  /guardian/status           Connected Guardian sessions
POST /guardian/handshake        Guardian AppID introduction
GET  /module/list               All loaded modules + status + uptime
POST /module/:name/unload       Hot-unload a non-vital module
POST /module/:name/reload       Stop + re-read from disk + re-init
GET  /ble/status                BLE adapter, backend, peripheral, subscribers
POST /ble/scan                  Start Bluetooth scan
GET  /ble/discovered            Bridge nodes found in last scan
POST /ble/connect               Connect to discovered peer by short ID
POST /ble/send                  Send message to BLE peer
POST /ble/advertise             Start advertising (peripheral mode, internal BT)
POST /ble/stop-advertise        Stop advertising
POST /ble/notify                Push to all subscribed centrals
GET  /ipfs/:cid                 Retrieve content by CID
POST /ipfs/put                  Store content, get CID, announce to DHT
POST /ipfs/pin                  Pin CID (exempt from GC)
POST /ipfs/find                 Find DHT providers for CID
GET  /health/mesh               Aggregate mesh health score
POST /health/replay             Reconstruct past state from delta log
GET  /health/divergence         Nodes diverging beyond 2σ from peer group
GET  /onion/*                   Onion circuit status
POST /steg/*                    Steganographic channel operations
POST /mobile/checkpoint         Force state checkpoint
GET  /mobile/status             Power profile, battery, watchdog state
POST /cli/command               Execute any CLI command via HTTP
GET  /gateway/status            API gateway diagnostics (port 3748)
```

---

## Ports

| Port | Protocol | Role |
|------|----------|------|
| 3747 | HTTP + WebSocket | Primary sovereign node — all REST API + WS gateway |
| 3748 | HTTP | API gateway (rate limiting, CORS, proxy) |
| 3749 | TCP | Mesh router (binary pulse protocol) |
| 5353 | UDP | DNS server (fallback from port 53) |
| 7777 | UDP | Heartbeat broadcast (LAN peer discovery) |
| 11434 | HTTP | Ollama local LLM |

---

## CLI

```bash
node index.js --cli          # Start node + CLI together
node index.js --cli --host 192.168.1.87 --port 3747   # Connect to remote node
```

| Command | Description |
|---------|-------------|
| `status` | Full system health — UUID, port, LAN address, causal count |
| `identity` | Node public record + all reachable endpoints |
| `nodes` | All registered nodes with lifecycle, trust, address |
| `trust [uuid]` | Trust mesh summary or per-peer score |
| `ime <uuid>` | Behavioral profile |
| `sngate trace\|rules\|add` | Gate decisions, rules, add rule |
| `causal stats\|classify\|query <cql>` | Causal kernel |
| `mesh scan` | Scan LAN for Bridge nodes (shows IPs, scopes, remote vs local) |
| `mesh dht` | DHT routing table |
| `dht find <uuid>` | Kademlia lookup |
| `module list` | All loaded modules |
| `module <name> unload\|reload` | Hot-unload/reload without restart |
| `ble status` | Bluetooth adapter, backend, peripheral support, subscribers |
| `ble scan [ms]` | Start BLE scan |
| `ble discovered` | All discovered Bridge BLE nodes with RSSI |
| `ble connect <shortId>` | Connect to discovered peer |
| `ble send <shortId> <msg>` | Send message (Central→Peripheral) |
| `ble advertise [name]` | Start advertising on internal Bluetooth hardware |
| `ble notify <msg>` | Push to all subscribed centrals |
| `mobile status\|power\|checkpoint` | Mobile/Pi runtime |
| `ollama <prompt>` | Query local Ollama LLM |
| `test all` | Run all test suites |
| `bench <n>` | Throughput benchmark |
| `watch [sig]` | Stream live bus events |

---

## Bluetooth (Windows — No Driver Swap Required)

Bridge OS uses the Windows 10+ built-in Bluetooth APIs (WinRT `Windows.Devices.Bluetooth`) via a PowerShell bridge process. No Zadig. No WinUSB. No USB dongle. Works alongside your keyboard, mouse, and headphones.

The node simultaneously acts as:
- **Central** — scans for and connects to other Bridge nodes
- **Peripheral** — advertises itself and accepts inbound connections via a real GATT server

Adapter support check at boot: `ble status` shows `Peripheral: supported` or `not supported by adapter`.

On Linux/macOS: uses `@abandonware/noble` (requires `libbluetooth-dev` + `cap_net_raw` capability on Linux).

---

## Connecting Clients

Any language, any platform. HTTP only.

**Register:**
```bash
curl -X POST http://192.168.1.42:3747/pulse \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"my-app","logicalId":"My App v1","capabilities":["data:push"]}'
```

**Push an event:**
```bash
curl -X POST http://192.168.1.42:3747/data/push \
  -H 'Content-Type: application/json' \
  -d '{"_localVerified":true,"type":"myapp:event","payload":{"value":42}}'
```

**Bootstrap a client with a scoped session:**
```bash
# Generate trust code
curl -X POST http://192.168.1.42:3747/appid/create \
  -d '{"appId":"my-client"}' -H 'Content-Type: application/json'
# → { "code": "nxt-7k3p-xm9q", "uri": "nexus://4a71196a?code=...&ttl=300" }

# Redeem for a session token (from the client machine)
curl -X POST http://192.168.1.42:3747/appid/redeem \
  -d '{"code":"nxt-7k3p-xm9q","appId":"my-client"}' -H 'Content-Type: application/json'
# → { "token": "...", "permissions": ["data:read","bus:read"] }
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_PORT` | `3747` | HTTP server port |
| `NEXUS_BIND_HOST` | `0.0.0.0` | Bind address (0.0.0.0 = all interfaces) |
| `NEXUS_DATA_DIR` | `./data` | Data directory for identity, WAL, state |
| `NEXUS_API_KEY` | *(none)* | Optional API key for all endpoints |
| `NEXUS_GROUP` | *(none)* | Group hint for identity clustering |
| `NEXUS_PLAYWRIGHT` | `false` | Enable Playwright bridge |
| `NEXUS_LOG` | `INFO` | Log level: INFO or DEBUG |
| `NEXUS_ANNOUNCED_HOST` | *(auto)* | Override the advertised public hostname |
| `NEXUS_DHT_BOOTSTRAP` | *(none)* | Comma-separated bootstrap peer addresses |
| `NEXUS_GATEWAY_PORT` | `3748` | API gateway port |
| `NEXUS_MESH_PORT` | `3749` | TCP mesh router port |

---

## Security

**Strong:** Ed25519 identity (unforgeable without private key) · 30-second handshake replay window · HMAC-signed single-use trust codes · Probationary trust ramp (rotating-UUID attack closed) · Score-never-blocks invariant (enforcement always traceable to an explicit rule) · Append-only causal log · Atomic state writes · Layer sovereignty (modules communicate via bus only).

**Pending:**
- `FLAG-004` — Remote data push signature verification (currently trust-score-gated)
- `FLAG-003` — STUN/TURN for cross-network NAT traversal
- `FLAG-005` — TPM/DPAPI hardware-bound key storage

**By design:** Each node maintains independent trust scores — no global consensus. This is intentional. Forced consensus creates a single point of manipulation.

---

## Backup

**Critical file:** `data/identity.key` — your node's private key. Losing it means losing your UUID. Peers will treat you as a new, unknown node. Back this up.

---

## Architecture Reference

See [bridge-os-v4.1.0-docs.docx](bridge-os-v4.1.0-docs.docx) for the complete 11-section reference document covering all 29 modules, the full HTTP API, CLI reference, security model, reliability guarantees, and design principles.

---

## License

Copyright © 2024–2026 James Brooks (Erosmancer). All rights reserved.  
Proprietary software. See [LICENSE](LICENSE) for terms and IP assertions.

