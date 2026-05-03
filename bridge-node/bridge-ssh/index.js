// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-ssh/index.js
 * SSH session management — sovereign node transport layer extension.
 *
 * §5.1  UUID + hook + event bus registration
 * §5.2  Implements bridge (all state via bus events)
 * §1.2  Nothing silently fails — all errors loud and specific
 * §2.1  Sessions persisted to data/ssh-sessions.json
 * §2.3  All state observable via /ssh/* routes and bus events
 * §5.5  No external runtime deps — uses Node built-in child_process
 *
 * UUID: bridge-ssh-7a3f-4b2d-9e1c-0000000001
 *
 * Bus events emitted:
 *   ssh:connected    { sessionId, host, user, port }
 *   ssh:disconnected { sessionId, reason }
 *   ssh:exec:result  { sessionId, command, stdout, stderr, exitCode, durationMs }
 *   ssh:exec:error   { sessionId, command, error }
 *   ssh:error        { sessionId, error }
 *
 * HTTP routes (registered in boot.js /ssh/* block):
 *   POST   /ssh/connect          { host, user?, port?, keyPath?, password?, label? }
 *   GET    /ssh/sessions         list all sessions
 *   GET    /ssh/session/:id      single session detail
 *   POST   /ssh/exec             { sessionId, command, timeoutMs? }
 *   DELETE /ssh/session/:id      disconnect + remove
 *   GET    /ssh/status           SSH module health
 *
 * Version: 1.1.0
 */

const { execFile }  = require('child_process');
const { promisify } = require('util');
const crypto        = require('crypto');
const path          = require('path');
const fs            = require('fs');

const execFileAsync = promisify(execFile);

const MODULE_UUID    = 'bridge-ssh-7a3f-4b2d-9e1c-0000000001';
const MODULE_VERSION = '1.1.0';

// ── Session state ─────────────────────────────────────────────────────────────

class SSHModule {
    constructor({ dataDir, busEmit }) {
        this.dataDir  = dataDir;
        this.busEmit  = busEmit || (() => {});
        this.sessions = new Map(); // sessionId → session record
        this.sessFile = path.join(dataDir, 'ssh-sessions.json');
        this._load();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _load() {
        try {
            if (fs.existsSync(this.sessFile)) {
                const raw  = JSON.parse(fs.readFileSync(this.sessFile, 'utf8'));
                for (const s of raw) {
                    // Restore as disconnected — process state is lost on restart
                    this.sessions.set(s.sessionId, { ...s, status: 'disconnected', pid: null });
                }
            }
        } catch (e) {
            // Non-fatal — fresh session map
            console.error(`[bridge-ssh] session load error: ${e.message}`);
        }
    }

    _save() {
        try {
            const data = JSON.stringify([...this.sessions.values()], null, 2);
            const tmp  = this.sessFile + '.tmp';
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, this.sessFile);
        } catch (e) {
            console.error(`[bridge-ssh] session save error: ${e.message}`);
        }
    }

    // ── SSH binary detection ──────────────────────────────────────────────────

    _sshBin() {
        // Windows OpenSSH ships at System32/OpenSSH/ssh.exe; Linux/Mac: ssh
        return process.platform === 'win32'
            ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
            : 'ssh';
    }

    // ── Session management ────────────────────────────────────────────────────

    connect({ host, user, port, keyPath, label }) {
        if (!host) throw new Error('host required');

        const sessionId = crypto.randomUUID();
        const record    = {
            sessionId,
            host,
            user:      user || process.env.USERNAME || process.env.USER || 'root',
            port:      Number(port) || 22,
            keyPath:   keyPath || null,
            label:     label  || `${user || 'root'}@${host}`,
            status:    'connected',
            pid:       null,
            connectedAt: new Date().toISOString(),
            lastSeen:    new Date().toISOString(),
            execCount:   0,
        };

        this.sessions.set(sessionId, record);
        this._save();

        this.busEmit('ssh:connected', {
            sessionId,
            host:  record.host,
            user:  record.user,
            port:  record.port,
            label: record.label,
        }, 'INFO');

        return record;
    }

    disconnect(sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error(`session not found: ${sessionId}`);

        s.status       = 'disconnected';
        s.disconnectedAt = new Date().toISOString();
        this._save();

        this.busEmit('ssh:disconnected', { sessionId, reason: 'manual' }, 'INFO');
        return { ok: true, sessionId };
    }

    list() {
        return [...this.sessions.values()];
    }

    get(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    // ── Remote exec ───────────────────────────────────────────────────────────

    async exec(sessionId, command, { timeoutMs = 30_000 } = {}) {
        const s = this.sessions.get(sessionId);
        if (!s) throw new Error(`session not found: ${sessionId}`);
        if (!command) throw new Error('command required');

        const ssh   = this._sshBin();
        const flags = [
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'BatchMode=yes',
            '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
            '-p', String(s.port),
        ];

        if (s.keyPath) {
            flags.push('-i', s.keyPath);
        }

        const target = `${s.user}@${s.host}`;
        const t0     = Date.now();

        try {
            const { stdout, stderr } = await execFileAsync(
                ssh,
                [...flags, target, command],
                { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
            );

            const durationMs = Date.now() - t0;

            s.lastSeen  = new Date().toISOString();
            s.execCount = (s.execCount || 0) + 1;
            this._save();

            const result = { sessionId, command, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, durationMs };
            this.busEmit('ssh:exec:result', result, 'INFO');
            return result;

        } catch (e) {
            const durationMs = Date.now() - t0;
            // execFile throws on non-zero exit
            const stderr = e.stderr?.trim() || '';
            const stdout = e.stdout?.trim() || '';
            const exitCode = e.code ?? 1;

            s.lastSeen  = new Date().toISOString();
            this._save();

            const result = { sessionId, command, stdout, stderr, exitCode, durationMs, error: e.message };
            this.busEmit('ssh:exec:error', result, 'WARN');
            return result;
        }
    }

    // ── HTTP route handler ────────────────────────────────────────────────────

    route(method, urlParts, body) {
        const sub = urlParts[1];

        // GET /ssh/status
        if (method === 'GET' && sub === 'status') {
            return {
                ok:         true,
                module:     'bridge-ssh',
                uuid:       MODULE_UUID,
                version:    MODULE_VERSION,
                sessions:   this.sessions.size,
                connected:  [...this.sessions.values()].filter(s => s.status === 'connected').length,
                sshBin:     this._sshBin(),
            };
        }

        // GET /ssh/sessions
        if (method === 'GET' && sub === 'sessions') {
            return { ok: true, sessions: this.list() };
        }

        // GET /ssh/session/:id
        if (method === 'GET' && sub === 'session' && urlParts[2]) {
            const s = this.get(urlParts[2]);
            if (!s) return { ok: false, error: 'session not found' };
            return { ok: true, session: s };
        }

        // POST /ssh/connect
        if (method === 'POST' && sub === 'connect') {
            try {
                const s = this.connect(body || {});
                return { ok: true, session: s };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        // POST /ssh/exec
        if (method === 'POST' && sub === 'exec') {
            const { sessionId, command, timeoutMs } = body || {};
            if (!sessionId) return { ok: false, error: 'sessionId required' };
            if (!command)   return { ok: false, error: 'command required' };
            // Return a promise — boot.js must await route() result
            return this.exec(sessionId, command, { timeoutMs })
                .then(r => ({ ok: true, ...r }))
                .catch(e => ({ ok: false, error: e.message }));
        }

        // DELETE /ssh/session/:id
        if (method === 'DELETE' && sub === 'session' && urlParts[2]) {
            try {
                return this.disconnect(urlParts[2]);
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        return null;
    }

    diagnostics() {
        return {
            uuid:      MODULE_UUID,
            version:   MODULE_VERSION,
            sessions:  this.sessions.size,
            connected: [...this.sessions.values()].filter(s => s.status === 'connected').length,
        };
    }
}

module.exports = { SSHModule, MODULE_UUID, MODULE_VERSION };
