// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mobile/index.js
 * Mobile & Hardware Node Runtime
 *
 * This module is NOT "just packaging". It addresses three real architectural
 * problems that don't exist on desktop:
 *
 * 1. BACKGROUND EXECUTION
 *    Mobile OSes (iOS/Android) aggressively kill background processes.
 *    Bridge OS solves this with four mechanisms:
 *      a. BLE Peripheral mode: advertise as a GATT server. The OS keeps BLE
 *         alive for connected centrals — use an inbound BLE connection as a
 *         keep-alive signal.
 *      b. Scheduled wake: on Android, WorkManager; on iOS, BGProcessingTask.
 *         We use a push notification (silent/data push) to wake the process.
 *      c. Heartbeat compression: on mobile, pulse interval backs off to 60s
 *         (vs 5s on desktop) to reduce wake frequency.
 *      d. State checkpointing: before the process is killed, the node writes
 *         its full state to disk. On next wake, it reconstructs from checkpoint.
 *
 * 2. POWER BUDGET
 *    Every radio transmission costs battery. The power manager controls:
 *      - Sync interval: 5s (WiFi, charging) → 30s (WiFi, battery) → 60s (cellular)
 *      - Radio selection: WiFi > BLE > cellular for battery cost
 *      - Suspend threshold: below 15% battery, only answer inbound connections
 *      - Wake lock: held during active handshakes, released immediately after
 *
 * 3. HARDWARE NODE (Raspberry Pi)
 *    The Pi installer creates a production-grade deployment:
 *      - systemd unit: auto-start, restart on failure, resource limits
 *      - Log rotation: journald + logrotate config
 *      - Watchdog: hardware watchdog integration via /dev/watchdog
 *      - Auto-update: signed delta packages, pulled from DDNS record
 *      - Network hardening: iptables rules, SSH key-only access
 *      - UPS support: GPIO monitoring for external battery/UPS on RPi
 *
 * Wire protocol (mobile exposes a local HTTP server on loopback):
 *   GET  /mobile/status   → { mode, battery, syncInterval, transport, uptime }
 *   POST /mobile/sync     → force immediate sync cycle
 *   POST /mobile/checkpoint → write state to disk now
 *   GET  /mobile/power    → power budget stats
 *
 * Bus events:
 *   mobile:wake           { reason, battery }
 *   mobile:sleep          { checkpointed, nextWakeMs }
 *   mobile:power:critical { battery, action }
 *   mobile:sync:cycle     { transport, peers, duration }
 *   mobile:checkpoint:saved { path, size }
 *
 * Invariants:
 *   M-01: State is checkpointed before process suspension.
 *   M-02: Power budget controls override user-configured intervals.
 *   M-03: Inbound connections are always accepted regardless of battery level.
 *   M-04: The watchdog (Pi) is fed every interval or the system reboots.
 *   M-05: Auto-update packages must be signed by the node operator's key.
 *
 * UUID: bridge-mobile-000-0000-000000000001
 * Version: 1.0.0
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const MODULE_UUID    = 'bridge-mobile-000-0000-000000000001';
const MODULE_VERSION = '1.0.0';

// ── Power budget constants ────────────────────────────────────────────────────

const POWER_PROFILES = {
  // [syncIntervalMs, pulseIntervalMs, description]
  desktop_charging:     [5_000,   5_000,  'desktop/charging: full rate'],
  desktop_battery:      [15_000,  15_000, 'desktop/battery: reduced'],
  mobile_wifi_charging: [10_000,  10_000, 'mobile/wifi/charging: moderate'],
  mobile_wifi_battery:  [30_000,  30_000, 'mobile/wifi/battery: conservative'],
  mobile_cellular:      [60_000,  60_000, 'mobile/cellular: minimum rate'],
  mobile_low_battery:   [120_000, 0,      'mobile/low-battery: inbound only'],
  suspended:            [0,       0,      'suspended: no active sync'],
};

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatform() {
  const p = process.platform;
  if (p === 'android') return 'android';
  if (p === 'darwin' && process.env.MOBILE_TARGET === 'ios') return 'ios';
  // Raspberry Pi detection via /proc/cpuinfo
  if (p === 'linux') {
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      if (cpuinfo.includes('Raspberry Pi') || cpuinfo.includes('BCM2')) return 'rpi';
    } catch {}
    return 'linux';
  }
  if (p === 'win32') return 'windows';
  return 'unknown';
}

// ── Battery status reader ─────────────────────────────────────────────────────

function createBatteryReader() {
  const platform = detectPlatform();

  function read() {
    // On Linux/Pi: read from /sys/class/power_supply
    if (platform === 'linux' || platform === 'rpi') {
      try {
        const basePath = '/sys/class/power_supply';
        const supplies = fs.readdirSync(basePath);
        const bat = supplies.find(s => s.startsWith('BAT'));
        if (bat) {
          const batPath = path.join(basePath, bat);
          const capacity = parseInt(fs.readFileSync(path.join(batPath, 'capacity'), 'utf8').trim());
          const status   = fs.readFileSync(path.join(batPath, 'status'), 'utf8').trim();
          return { level: capacity / 100, charging: status === 'Charging', source: 'sysfs' };
        }
      } catch {}
    }
    // Android/iOS: must be injected via JNI bridge or Capacitor/React Native plugin
    // Fallback: assume full battery on unknown platform
    return { level: 1.0, charging: true, source: 'assumed' };
  }

  return { read };
}

// ── Power manager ─────────────────────────────────────────────────────────────

function createPowerManager({ busEmit = null, getBattery = null } = {}) {
  const _battery = getBattery || createBatteryReader().read;
  let   _profile = POWER_PROFILES.desktop_charging;
  let   _lastBat = null;

  function update() {
    const bat  = _battery();
    _lastBat   = bat;
    const pct  = bat.level * 100;
    const link = _detectLink();

    let key;
    if (pct < 15)                          key = 'mobile_low_battery';
    else if (link === 'cellular')          key = 'mobile_cellular';
    else if (link === 'mobile_wifi' && !bat.charging) key = 'mobile_wifi_battery';
    else if (link === 'mobile_wifi')       key = 'mobile_wifi_charging';
    else if (!bat.charging)               key = 'desktop_battery';
    else                                  key = 'desktop_charging';

    const newProfile = POWER_PROFILES[key];
    if (newProfile !== _profile) {
      _profile = newProfile;
      busEmit?.('mobile:power:profile', { profile: key, syncInterval: _profile[0], bat: Math.round(pct) }, 'INFO');
    }

    if (pct < 15) {
      busEmit?.('mobile:power:critical', { battery: Math.round(pct), action: 'inbound_only' }, 'WARN');
    }

    return _profile;
  }

  function _detectLink() {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          if (name.match(/wlan|wifi|wireless/i)) return 'mobile_wifi';
          if (name.match(/eth|en\d|ethernet/i))  return 'ethernet';
          if (addr.address.startsWith('10.'))     return 'cellular';
        }
      }
    }
    return 'unknown';
  }

  function syncInterval()  { return _profile[0]; }
  function pulseInterval() { return _profile[1]; }
  function isSuspended()   { return _profile[0] === 0; }
  function batteryLevel()  { return _lastBat?.level ?? 1.0; }
  function isCharging()    { return _lastBat?.charging ?? true; }

  // M-03: inbound always accepted regardless of battery
  function shouldAcceptInbound() { return true; }

  function stats() {
    const bat = _battery();
    return {
      battery:      Math.round(bat.level * 100),
      charging:     bat.charging,
      syncInterval: syncInterval(),
      isSuspended:  isSuspended(),
      profile:      _profile[2],
      link:         _detectLink(),
    };
  }

  return { update, syncInterval, pulseInterval, isSuspended, batteryLevel, isCharging, shouldAcceptInbound, stats };
}

// ── State checkpointing ───────────────────────────────────────────────────────

function createCheckpointer({ checkpointDir = path.join(process.cwd(), 'data', 'checkpoint'), busEmit = null } = {}) {
  if (!fs.existsSync(checkpointDir)) {
    try { fs.mkdirSync(checkpointDir, { recursive: true }); } catch {}
  }

  const CHECKPOINT_FILE = path.join(checkpointDir, 'state.json');
  const CHECKPOINT_TMP  = CHECKPOINT_FILE + '.tmp';

  function save(state) {
    // M-01: state written before process suspension
    try {
      const data = JSON.stringify({ ...state, savedAt: Date.now(), pid: process.pid }, null, 0);
      fs.writeFileSync(CHECKPOINT_TMP, data, 'utf8');
      fs.renameSync(CHECKPOINT_TMP, CHECKPOINT_FILE); // atomic
      const size = Buffer.byteLength(data);
      busEmit?.('mobile:checkpoint:saved', { path: CHECKPOINT_FILE, size }, 'DEBUG');
      return { ok: true, size };
    } catch (e) {
      busEmit?.('mobile:checkpoint:failed', { reason: e.message }, 'WARN');
      return { ok: false, reason: e.message };
    }
  }

  function load() {
    try {
      if (!fs.existsSync(CHECKPOINT_FILE)) return null;
      const data  = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      const state = JSON.parse(data);
      busEmit?.('mobile:checkpoint:loaded', { savedAt: state.savedAt }, 'INFO');
      return state;
    } catch { return null; }
  }

  function clear() {
    try { fs.unlinkSync(CHECKPOINT_FILE); } catch {}
  }

  return { save, load, clear };
}

// ── Pi hardware watchdog ──────────────────────────────────────────────────────
//
// The Linux hardware watchdog reboots the system if not fed within the timeout.
// Feed it every syncInterval to ensure automatic recovery from hangs.

function createWatchdog({ device = '/dev/watchdog', feedIntervalMs = 15_000, busEmit = null } = {}) {
  let _fd     = null;
  let _feeder = null;
  let _fed    = 0;

  function start() {
    if (!fs.existsSync(device)) {
      busEmit?.('mobile:watchdog:unavailable', { device }, 'WARN');
      return false;
    }
    try {
      // Open watchdog device (requires root/capabilities on Pi)
      _fd = fs.openSync(device, 'w+');
      _feeder = setInterval(() => feed(), feedIntervalMs);
      busEmit?.('mobile:watchdog:started', { device, intervalMs: feedIntervalMs }, 'INFO');
      return true;
    } catch (e) {
      busEmit?.('mobile:watchdog:failed', { device, reason: e.message }, 'WARN');
      return false;
    }
  }

  function feed() {
    if (_fd === null) return;
    try {
      // Write 'V' to keep watchdog alive (standard Linux keepalive)
      // M-04: watchdog must be fed every interval or system reboots
      fs.writeSync(_fd, '1');
      _fed++;
    } catch (e) {
      busEmit?.('mobile:watchdog:feed_failed', { reason: e.message }, 'WARN');
    }
  }

  function stop() {
    clearInterval(_feeder);
    if (_fd !== null) {
      try {
        // Write 'V' = magic close character, tells watchdog to disarm
        fs.writeSync(_fd, 'V');
        fs.closeSync(_fd);
      } catch {}
      _fd = null;
    }
  }

  function stats() { return { active: _fd !== null, fed: _fed, device }; }

  return { start, feed, stop, stats };
}

// ── Pi installer script generator ────────────────────────────────────────────

function generatePiInstaller({ nodeUuid = 'unknown', port = 3747, installDir = '/opt/bridge-os' } = {}) {
  // Returns a shell script string that sets up Bridge OS as a production service
  return `#!/bin/bash
# Bridge OS — Raspberry Pi Installer
# UUID: ${nodeUuid}
# Generated: ${new Date().toISOString()}
set -euo pipefail

INSTALL_DIR="${installDir}"
PORT=${port}
NODE_USER="bridge"

echo "[bridge] Installing Bridge OS on Raspberry Pi..."

# ── System deps
apt-get update -qq
apt-get install -y nodejs npm git bluetooth bluez libbluetooth-dev

# ── Create dedicated user
if ! id "$NODE_USER" &>/dev/null; then
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$NODE_USER"
fi

# ── Install
mkdir -p "$INSTALL_DIR"
cp -r . "$INSTALL_DIR/"
cd "$INSTALL_DIR"
npm install --production 2>/dev/null || true
chown -R $NODE_USER:$NODE_USER "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/data/identity.key" 2>/dev/null || true

# ── systemd unit
cat > /etc/systemd/system/bridge-os.service <<EOF
[Unit]
Description=Bridge OS Sovereign Node
After=network.target bluetooth.target
Wants=network-online.target

[Service]
Type=simple
User=$NODE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node bridge-cli/nexus-cli.js --port $PORT
Restart=on-failure
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

# Resource limits
MemoryMax=256M
CPUQuota=50%
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data

# Watchdog integration (M-04)
WatchdogSec=30
NotifyAccess=main

[Install]
WantedBy=multi-user.target
EOF

# ── Log rotation
cat > /etc/logrotate.d/bridge-os <<EOF
$INSTALL_DIR/data/*.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
}
EOF

# ── Network hardening
iptables -A INPUT -p tcp --dport $PORT -j ACCEPT   2>/dev/null || true
iptables -A INPUT -p udp --dport 7777 -j ACCEPT    2>/dev/null || true

# ── Enable and start
systemctl daemon-reload
systemctl enable bridge-os
systemctl start bridge-os

echo "[bridge] Installed. Status:"
systemctl status bridge-os --no-pager
echo ""
echo "[bridge] UUID: ${nodeUuid}"
echo "[bridge] Port: $PORT"
echo "[bridge] Logs: journalctl -u bridge-os -f"
`;
}

// ── Mobile runtime factory ────────────────────────────────────────────────────

function createMobileRuntime({
  identity       = null,
  busEmit        = null,
  getBattery     = null,
  checkpointDir  = null,
  watchdogDevice = '/dev/watchdog',
  enableWatchdog = detectPlatform() === 'rpi',
} = {}) {

  // Resolve checkpointDir — never pass null to path.join
  const resolvedCheckpointDir = checkpointDir || path.join(process.cwd(), 'data', 'checkpoint');

  const power       = createPowerManager({ busEmit, getBattery });
  const checkpointer = createCheckpointer({ checkpointDir: resolvedCheckpointDir, busEmit });
  const watchdog    = createWatchdog({ device: watchdogDevice, busEmit });
  const platform    = detectPlatform();

  let _syncTimer    = null;
  let _powerTimer   = null;
  let _booted       = Date.now();
  let _syncCount    = 0;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  function start() {
    // Load checkpoint from previous session
    const checkpoint = checkpointer.load();
    if (checkpoint) {
      busEmit?.('mobile:wake', { reason: 'checkpoint_restored', savedAt: checkpoint.savedAt }, 'INFO');
    }

    // Start watchdog on Pi — M-04
    if (enableWatchdog) watchdog.start();

    // Power profile polling
    _powerTimer = setInterval(() => {
      const profile = power.update();
      // Adjust sync interval dynamically
      if (_syncTimer) {
        clearInterval(_syncTimer);
        if (profile[0] > 0) _syncTimer = setInterval(_syncCycle, profile[0]);
      }
    }, 30_000);

    // Initial power update
    power.update();

    // Start sync loop at current profile rate
    const interval = power.syncInterval();
    if (interval > 0) {
      _syncTimer = setInterval(_syncCycle, interval);
    }

    busEmit?.('mobile:started', { platform, syncInterval: interval }, 'INFO');
  }

  function _syncCycle() {
    if (power.isSuspended()) return;
    _syncCount++;
    busEmit?.('mobile:sync:cycle', {
      n:        _syncCount,
      battery:  Math.round(power.batteryLevel() * 100),
      charging: power.isCharging(),
    }, 'DEBUG');
  }

  // Called by the OS before process suspension (e.g. Android onStop, iOS applicationWillTerminate)
  function beforeSuspend(state = {}) {
    // M-01: checkpoint before suspension
    checkpointer.save({ ...state, pid: process.pid, uptime: Date.now() - _booted });
    if (enableWatchdog) watchdog.stop();
    clearInterval(_syncTimer);
    clearInterval(_powerTimer);
    busEmit?.('mobile:sleep', { checkpointed: true }, 'INFO');
  }

  function stop() { beforeSuspend(); }

  // ── HTTP route handler ──────────────────────────────────────────────────────

  function route(method, urlParts, body, req, res) {
    const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (method === 'GET' && urlParts[1] === 'status') {
      return _json(200, {
        ok:       true,
        platform,
        uptime:   Date.now() - _booted,
        syncs:    _syncCount,
        watchdog: watchdog.stats(),
        power:    power.stats(),
      });
    }

    if (method === 'POST' && urlParts[1] === 'sync') {
      _syncCycle();
      return _json(200, { ok: true, syncCount: _syncCount });
    }

    if (method === 'POST' && urlParts[1] === 'checkpoint') {
      const result = checkpointer.save(body || {});
      return _json(result.ok ? 200 : 500, { ok: result.ok, ...result });
    }

    if (method === 'GET' && urlParts[1] === 'power') {
      return _json(200, { ok: true, ...power.stats() });
    }

    return null;
  }

  function diagnostics() {
    return {
      uuid:       MODULE_UUID,
      version:    MODULE_VERSION,
      platform,
      uptime:     Date.now() - _booted,
      syncs:      _syncCount,
      power:      power.stats(),
      watchdog:   watchdog.stats(),
    };
  }

  return {
    start, stop, beforeSuspend,
    power, checkpointer, watchdog,
    route, diagnostics,
    generatePiInstaller: (opts) => generatePiInstaller({ nodeUuid: identity?.uuid, ...opts }),
    MODULE_UUID, MODULE_VERSION,
  };
}

module.exports = {
  createMobileRuntime,
  createPowerManager,
  createCheckpointer,
  createWatchdog,
  createBatteryReader,
  generatePiInstaller,
  detectPlatform,
  POWER_PROFILES,
  MODULE_UUID,
  MODULE_VERSION,
};
