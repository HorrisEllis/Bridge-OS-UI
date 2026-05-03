// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
'use strict';

/**
 * Bridge OS — Preload Script  v4.1.0
 * Secure contextBridge — exposes NXAPI to renderer.
 * Uses contextIsolation=true. No nodeIntegration.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('NXAPI', {
  // ── Window controls ──────────────────────────────────────────────
  minimize:       () => ipcRenderer.invoke('win:minimize'),
  maximize:       () => ipcRenderer.invoke('win:maximize'),
  close:          () => ipcRenderer.invoke('win:close'),
  isMaximized:    () => ipcRenderer.invoke('win:isMax'),

  // ── Config ───────────────────────────────────────────────────────
  getConfig:      () => ipcRenderer.invoke('config:get'),
  saveConfig:     (u)  => ipcRenderer.invoke('config:set', u),

  // ── Folder / data dir ────────────────────────────────────────────
  pickDataFolder: () => ipcRenderer.invoke('folder:pick'),
  defaultFolder:  () => ipcRenderer.invoke('folder:default'),
  setDataDir:     (d)  => ipcRenderer.invoke('folder:set', d),
  openFolder:     (d)  => ipcRenderer.invoke('folder:open', d),

  // ── Vault I/O ────────────────────────────────────────────────────
  vaultRead:      (p)     => ipcRenderer.invoke('vault:read', p),
  vaultWrite:     (p, d)  => ipcRenderer.invoke('vault:write', p, d),
  vaultExists:    (p)     => ipcRenderer.invoke('vault:exists', p),
  vaultDelete:    (p)     => ipcRenderer.invoke('vault:delete', p),
  vaultBackup:    (p)     => ipcRenderer.invoke('vault:backup', p),

  // ── File I/O ─────────────────────────────────────────────────────
  readFile:       (p)     => ipcRenderer.invoke('file:read', p),
  writeFile:      (p, d)  => ipcRenderer.invoke('file:write', p, d),
  saveFileDialog: (opts)  => ipcRenderer.invoke('file:save-dialog', opts),
  openFileDialog: (opts)  => ipcRenderer.invoke('file:open-dialog', opts),

  // ── Bridge OS node process ────────────────────────────────────────
  nodeStart:      (port, dataDir) => ipcRenderer.invoke('node:start', port, dataDir),
  nodeStop:       ()      => ipcRenderer.invoke('node:stop'),
  nodeStatus:     ()      => ipcRenderer.invoke('node:status'),
  nodeSetPort:    (port)  => ipcRenderer.invoke('node:port:set', port),

  // ── Bridge HTTP proxy (bypasses CORS) ────────────────────────────
  // Use these instead of fetch() when talking to localhost:3747
  bridgeGet:      (path)        => ipcRenderer.invoke('bridge:get',  path),
  bridgePost:     (path, body)  => ipcRenderer.invoke('bridge:post', path, body),

  // ── File integrity ────────────────────────────────────────────────
  integrityCheck: ()     => ipcRenderer.invoke('integrity:check'),
  integrityMode:  (mode) => ipcRenderer.invoke('integrity:mode', mode),

  // ── Killswitch ───────────────────────────────────────────────────
  killswitchArm:     (armed)   => ipcRenderer.invoke('killswitch:arm', armed),
  killswitchExecute: (reason)  => ipcRenderer.invoke('killswitch:execute', reason),

  // ── App ──────────────────────────────────────────────────────────
  getVersion:        () => ipcRenderer.invoke('app:version'),
  getUserDataPath:   () => ipcRenderer.invoke('app:path'),
  openLog:           () => ipcRenderer.invoke('app:open-log'),
  relaunch:          () => ipcRenderer.invoke('app:relaunch'),
  openDevTools:      () => ipcRenderer.invoke('devtools:open'),

  // ── Main → Renderer events ────────────────────────────────────────
  onConfigLoaded:      cb => ipcRenderer.on('config-loaded',      (_, d) => cb(d)),
  onNodeMessage:       cb => ipcRenderer.on('node:message',        (_, d) => cb(d)),
  onNodeStopped:       cb => ipcRenderer.on('node:stopped',        (_, d) => cb(d)),
  onIntegrityResult:   cb => ipcRenderer.on('integrity:result',    (_, d) => cb(d)),
  onIntegrityTamper:   cb => ipcRenderer.on('integrity:tamper',    (_, d) => cb(d)),
  onKillswitchComplete:cb => ipcRenderer.on('killswitch:complete', (_, d) => cb(d)),

  removeAllListeners: ch => ipcRenderer.removeAllListeners(ch),
});

console.log('[preload] NXAPI bridge ready — Bridge OS v4.1.0');
