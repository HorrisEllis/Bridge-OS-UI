// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
'use strict';

/**
 * Bridge OS — Electron Main Process  v4.1.0
 *
 * Responsibilities:
 *   1. Window lifecycle
 *   2. IPC bridge (vault, file, node, bridge HTTP proxy)
 *   3. File integrity guardian — hashes all app files at boot,
 *      compares against manifest.lock (signed at build time)
 *   4. Killswitch — on tamper detection or explicit trigger,
 *      overwrites + zeroes + deletes the vault file,
 *      destroying the node's cryptographic identity permanently
 *   5. Bridge OS node process management (spawn/kill bridge-node)
 *
 * Integrity model:
 *   manifest.lock  — JSON: { files: { relPath: sha256hex }, built: iso, version: string }
 *   On boot: re-hash every file listed in manifest.lock.
 *   Mismatch = tamper event. Three modes (set by vault at creation time):
 *     'warn'   — log + notify UI, continue
 *     'refuse' — block startup, show tamper screen
 *     'kill'   — destroy vault, exit
 *
 * Killswitch sequence (cannot be undone):
 *   1. Read vault path from config
 *   2. Stat the file to get byte length
 *   3. Write crypto.randomBytes(length) to the vault path (overwrite with random)
 *   4. Write Buffer.alloc(length, 0) to the vault path (zero over the random)
 *   5. fs.unlinkSync — delete the file
 *   6. Delete identity.key and identity.json from dataDir if present
 *   7. Log the destruction event with timestamp
 *   8. app.exit(0)
 *
 * The private key is gone. The UUID is gone. The node does not exist.
 */

const {
  app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen
} = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const http   = require('http');
const cp     = require('child_process');

// ── Crash-safe logger ─────────────────────────────────────────────────────────
const LOG_PATH = path.join(app.getPath('userData'), 'bridge-os.log');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  console.log(...a);
}
process.on('uncaughtException',  e => log('[CRASH]',  e.stack || e.message));
process.on('unhandledRejection', r => log('[REJECT]', r?.stack || r));
log('[START] Bridge OS v4.1.0');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const isWin = process.platform === 'win32';

// Single instance lock
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'bridge-os-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {
    dataDir: null, theme: 'bridge', firstRun: true, windowBounds: null,
    integrityMode: 'warn',   // 'warn' | 'refuse' | 'kill'
    killswitchArmed: false,  // user explicitly armed the killswitch
    nodePort: 3747,
  }; }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
  catch(e) { log('[CFG] write failed:', e.message); }
}
let CFG = readConfig();

// ── File integrity guardian ───────────────────────────────────────────────────
const MANIFEST_PATH = path.join(__dirname, 'manifest.lock');

function sha256File(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

async function runIntegrityCheck() {
  if (isDev) { log('[INTEGRITY] dev mode — skipping'); return { ok: true, skipped: true }; }
  if (!fs.existsSync(MANIFEST_PATH)) {
    log('[INTEGRITY] manifest.lock missing — cannot verify');
    return { ok: false, reason: 'manifest_missing', files: [] };
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); }
  catch(e) { return { ok: false, reason: 'manifest_corrupt', files: [] }; }

  const tampered = [];
  for (const [relPath, expectedHash] of Object.entries(manifest.files || {})) {
    const absPath = path.join(__dirname, relPath);
    const actualHash = sha256File(absPath);
    if (!actualHash) {
      tampered.push({ file: relPath, reason: 'missing' });
    } else if (actualHash !== expectedHash) {
      tampered.push({ file: relPath, reason: 'hash_mismatch', expected: expectedHash, actual: actualHash });
    }
  }

  if (tampered.length === 0) {
    log('[INTEGRITY] all files verified');
    return { ok: true, files: [], built: manifest.built, version: manifest.version };
  }

  log('[INTEGRITY] TAMPER DETECTED:', JSON.stringify(tampered));
  return { ok: false, reason: 'tamper_detected', files: tampered };
}

// ── Killswitch ────────────────────────────────────────────────────────────────
async function executeKillswitch(reason = 'manual') {
  log(`[KILLSWITCH] ARMED — reason: ${reason} — ${new Date().toISOString()}`);

  const targets = [];

  // Vault file
  const vaultPath = CFG.dataDir ? path.join(CFG.dataDir, 'bridge-os.vault') : null;
  if (vaultPath && fs.existsSync(vaultPath)) targets.push(vaultPath);

  // Bridge OS identity files
  const dataDir = CFG.dataDir;
  if (dataDir) {
    for (const f of ['identity.key', 'identity.json', 'bridge-os.vault']) {
      const p = path.join(dataDir, f);
      if (fs.existsSync(p)) targets.push(p);
    }
  }

  for (const target of targets) {
    try {
      const stat = fs.statSync(target);
      const len  = stat.size || 4096;

      // Pass 1: overwrite with random bytes
      fs.writeFileSync(target, crypto.randomBytes(len));
      // Pass 2: overwrite with zeros
      fs.writeFileSync(target, Buffer.alloc(len, 0));
      // Pass 3: delete
      fs.unlinkSync(target);

      log(`[KILLSWITCH] destroyed: ${target}`);
    } catch(e) {
      log(`[KILLSWITCH] error destroying ${target}:`, e.message);
    }
  }

  // Write kill receipt
  const receipt = {
    destroyed: new Date().toISOString(),
    reason,
    targets: targets.length,
    machine: os.hostname(),
  };
  try {
    const receiptPath = path.join(app.getPath('userData'), 'kill-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  } catch {}

  log('[KILLSWITCH] complete — identity destroyed');

  if (mainWin && !mainWin.isDestroyed()) {
    try {
      mainWin.webContents.send('killswitch:complete', receipt);
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }

  app.exit(0);
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWin  = null;
let nodeProc = null;  // bridge-node child process

function getIconPath() {
  for (const p of [
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'icon.ico'),
  ]) { if (fs.existsSync(p)) return p; }
  return undefined;
}

function createWindow() {
  log('[WIN] creating');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width:           CFG.windowBounds?.width  || sw,
    height:          CFG.windowBounds?.height || sh,
    x:               CFG.windowBounds?.x ?? undefined,
    y:               CFG.windowBounds?.y ?? undefined,
    frame:           false,
    show:            false,
    backgroundColor: '#020408',
    minWidth:        900,
    minHeight:       600,
    icon:            getIconPath(),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  if (isWin) try { mainWin.setBackgroundMaterial?.('none'); } catch {}

  const html = path.join(__dirname, 'bridge-ui.html');
  if (!fs.existsSync(html)) {
    dialog.showErrorBox('Bridge OS', 'bridge-ui.html not found.\nPlace all Bridge OS files in the same folder.');
    app.quit(); return;
  }

  mainWin.loadFile(html).catch(e => log('[WIN] load failed:', e.message));

  mainWin.once('ready-to-show', () => {
    try { mainWin.maximize(); } catch {}
    mainWin.show();
    mainWin.focus();
    if (isDev) try { mainWin.webContents.openDevTools({ mode: 'right' }); } catch {}
  });

  mainWin.webContents.on('did-finish-load', async () => {
    // Send config
    try { mainWin.webContents.send('config-loaded', CFG); } catch {}

    // Run integrity check after renderer is ready
    if (!isDev) {
      const result = await runIntegrityCheck();
      try { mainWin.webContents.send('integrity:result', result); } catch {}

      if (!result.ok && result.reason !== 'skipped' && result.reason !== 'manifest_missing') {
        const mode = CFG.integrityMode || 'warn';
        log(`[INTEGRITY] mode=${mode} tampered=${result.files?.length}`);
        if (mode === 'kill' && CFG.killswitchArmed) {
          await executeKillswitch('integrity_failure');
        } else if (mode === 'refuse') {
          try { mainWin.webContents.send('integrity:tamper', result); } catch {}
        }
      }
    }
  });

  mainWin.webContents.on('render-process-gone', (_, d) => {
    log('[WIN] renderer gone:', d.reason);
    if (d.reason !== 'clean-exit') {
      const choice = dialog.showMessageBoxSync({
        type: 'error', title: 'Bridge OS',
        message: 'Renderer process crashed. Relaunch?',
        buttons: ['Relaunch', 'Quit'],
      });
      if (choice === 0) { app.relaunch(); app.exit(0); } else app.quit();
    }
  });

  const saveBounds = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isMaximized() || mainWin.isMinimized()) return;
    try { CFG.windowBounds = mainWin.getBounds(); writeConfig(CFG); } catch {}
  };
  mainWin.on('resize', saveBounds);
  mainWin.on('move',   saveBounds);
  mainWin.on('closed', () => {
    mainWin = null;
    stopBridgeNode();
  });
}

// ── Bridge Node process management ────────────────────────────────────────────
function startBridgeNode(port = 3747, dataDir = null) {
  if (nodeProc) return { ok: false, reason: 'already_running' };

  // Use absolute path from __dirname to avoid package.json resolution confusion
  const nodeScript = path.resolve(__dirname, 'bridge-node', 'index.js');
  log('[NODE] looking for:', nodeScript);
  if (!fs.existsSync(nodeScript)) {
    log('[NODE] bridge-node index.js not found at:', nodeScript);
    // Show user-facing error
    try {
      dialog.showErrorBox('Bridge OS — Node Not Found',
        'bridge-node/index.js not found at:\n' + nodeScript +
        '\n\nMake sure bridge-node/ folder is in the same directory as main.js');
    } catch {}
    return { ok: false, reason: 'not_found: ' + nodeScript };
  }

  const env = {
    ...process.env,
    NEXUS_PORT:     String(port),
    NEXUS_DATA_DIR: dataDir || path.join(app.getPath('userData'), 'bridge-data'),
    NEXUS_LOG:      isDev ? 'DEBUG' : 'INFO',
  };

  try {
    nodeProc = cp.fork(nodeScript, [], {
      env,
      silent: false,
      detached: false,
    });

    nodeProc.on('message', msg => {
      try { mainWin?.webContents?.send('node:message', msg); } catch {}
    });

    nodeProc.on('exit', (code, signal) => {
      log(`[NODE] exited code=${code} signal=${signal}`);
      nodeProc = null;
      try { mainWin?.webContents?.send('node:stopped', { code, signal }); } catch {}
    });

    nodeProc.on('error', e => {
      log('[NODE] error:', e.message);
      nodeProc = null;
    });

    log(`[NODE] started pid=${nodeProc.pid} port=${port}`);
    return { ok: true, pid: nodeProc.pid, port };
  } catch(e) {
    log('[NODE] start failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

function stopBridgeNode() {
  if (!nodeProc) return;
  try { nodeProc.kill('SIGTERM'); }
  catch { try { nodeProc.kill('SIGKILL'); } catch {} }
  nodeProc = null;
  log('[NODE] stopped');
}

// ── Bridge HTTP proxy (pass-through for renderer → Bridge OS node) ─────────────
function bridgeRequest(method, path_, body) {
  return new Promise((resolve, reject) => {
    const port = CFG.nodePort || 3747;
    const data = body ? JSON.stringify(body) : null;
    const req  = http.request({
      hostname: '127.0.0.1', port, path: path_, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 5000,
    }, res => {
      const c = [];
      res.on('data', x => c.push(x));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(c).toString()) }); }
        catch { resolve({ status: res.statusCode, data: Buffer.concat(c).toString() }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
const safe = fn => async (...args) => {
  try { return await fn(...args); }
  catch(e) { log('[IPC]', e.message); return { ok: false, error: e.message }; }
};

// Window
ipcMain.handle('win:minimize', () => mainWin?.minimize());
ipcMain.handle('win:maximize', () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
ipcMain.handle('win:close',    () => mainWin?.close());
ipcMain.handle('win:isMax',    () => mainWin?.isMaximized() ?? false);

// Config
ipcMain.handle('config:get', () => CFG);
ipcMain.handle('config:set', (_, u) => { Object.assign(CFG, u); writeConfig(CFG); return CFG; });

// Folder picker
ipcMain.handle('folder:pick', safe(async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Select Bridge OS data folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: CFG.dataDir || path.join(os.homedir(), 'Documents', 'BridgeOS'),
  });
  return r.canceled ? null : r.filePaths[0];
}));
ipcMain.handle('folder:default', () => {
  const d = path.join(os.homedir(), 'Documents', 'BridgeOS');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
});
ipcMain.handle('folder:set', (_, p) => {
  try { CFG.dataDir = p; writeConfig(CFG); fs.mkdirSync(p, { recursive: true }); } catch(e) { log('[FOLDER]', e.message); }
  return p;
});
ipcMain.handle('folder:open', (_, p) => { try { if (p) shell.openPath(p); } catch {} });

// Vault I/O
ipcMain.handle('vault:read',   (_, p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
ipcMain.handle('vault:exists', (_, p) => { try { return fs.existsSync(p); } catch { return false; } });
ipcMain.handle('vault:delete', (_, p) => { try { fs.unlinkSync(p); return true; } catch { return false; } });
ipcMain.handle('vault:write',  safe(async (_, p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', data, 'utf8');
  fs.renameSync(p + '.tmp', p);
  return { ok: true };
}));
ipcMain.handle('vault:backup', safe(async (_, p) => {
  if (!fs.existsSync(p)) return { ok: false, error: 'not found' };
  const b = p.replace(/\.json$/, '') + '.backup.' + Date.now() + '.json';
  fs.copyFileSync(p, b); return { ok: true, backupPath: b };
}));

// File I/O
ipcMain.handle('file:read',    (_, p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
ipcMain.handle('file:write',   (_, p, d) => {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d, 'utf8'); return true; }
  catch(e) { log('[FILE] write:', e.message); return false; }
});
ipcMain.handle('file:save-dialog', safe(async (_, opts = {}) => {
  const r = await dialog.showSaveDialog(mainWin, {
    title: opts.title || 'Save',
    defaultPath: opts.defaultPath || path.join(os.homedir(), 'Desktop', opts.filename || 'export.json'),
    filters: opts.filters || [{ name: 'JSON', extensions: ['json'] }],
  });
  return r.canceled ? null : r.filePath;
}));
ipcMain.handle('file:open-dialog', safe(async (_, opts = {}) => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: opts.title || 'Open',
    properties: ['openFile'],
    filters: opts.filters || [{ name: 'All', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
}));

// Bridge OS node process
ipcMain.handle('node:start',  (_, port, dataDir) => startBridgeNode(port, dataDir));
ipcMain.handle('node:stop',   () => { stopBridgeNode(); return { ok: true }; });
ipcMain.handle('node:status', () => ({ running: !!nodeProc, pid: nodeProc?.pid || null }));
ipcMain.handle('node:port:set', (_, p) => { CFG.nodePort = p; writeConfig(CFG); return p; });

// Bridge HTTP proxy — renderer calls this instead of fetch() to avoid CORS
ipcMain.handle('bridge:get',  safe(async (_, path_)       => bridgeRequest('GET',  path_, null)));
ipcMain.handle('bridge:post', safe(async (_, path_, body)  => bridgeRequest('POST', path_, body)));

// Integrity
ipcMain.handle('integrity:check', safe(async () => runIntegrityCheck()));
ipcMain.handle('integrity:mode',  (_, mode) => { CFG.integrityMode = mode; writeConfig(CFG); return mode; });

// Killswitch
ipcMain.handle('killswitch:arm',     (_, armed) => { CFG.killswitchArmed = !!armed; writeConfig(CFG); return CFG.killswitchArmed; });
ipcMain.handle('killswitch:execute', safe(async (_, reason) => {
  const confirmed = await dialog.showMessageBoxSync(mainWin, {
    type: 'warning',
    title: 'KILLSWITCH — IRREVERSIBLE',
    message: 'This will permanently destroy your node identity.\n\nThe private key will be overwritten with random bytes, then zeros, then deleted.\n\nYour UUID and mesh presence will cease to exist.\n\nThis cannot be undone.',
    buttons: ['DESTROY IDENTITY', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if (confirmed !== 0) return { ok: false, reason: 'cancelled' };
  await executeKillswitch(reason || 'manual');
}));

// App
ipcMain.handle('app:version',    () => app.getVersion());
ipcMain.handle('app:path',       () => app.getPath('userData'));
ipcMain.handle('app:log-path',   () => LOG_PATH);
ipcMain.handle('app:open-log',   () => { try { shell.openPath(LOG_PATH); } catch {} });
ipcMain.handle('app:relaunch',   () => { log('[APP] relaunch'); stopBridgeNode(); app.relaunch(); app.exit(0); });
ipcMain.handle('devtools:open',  () => { try { mainWin?.webContents.openDevTools({ mode: 'detach' }); } catch {} });

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.on('ready', () => {
  log('[APP] ready');
  if (isWin) try { app.setAppUserModelId('world.rheon.bridge-os'); } catch {}
  try { nativeTheme.themeSource = 'dark'; } catch {}
  createWindow();
});

app.on('second-instance', () => {
  if (mainWin) try { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } catch {}
});

app.on('window-all-closed', () => {
  stopBridgeNode();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => { stopBridgeNode(); });

log('[MAIN] handlers registered');
