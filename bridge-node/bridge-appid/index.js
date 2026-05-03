// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-appid/index.js
 * AppID Registry + One-Time Trust Code System
 *
 * AppIDs are persistent named identities for external clients (Guardian,
 * ErosmancerOS, CFR, SENTINEL). Each AppID gets a stable cryptographic
 * identity derived from the node's private key + the appId name.
 *
 * Flow:
 *   CLI:       /appid create guardian   → generates code + nexus:// URI
 *   Client:    POST /appid/redeem { code, appId } → session token
 *   Reconnect: POST /appid/session { token } → validated, IME sees activity
 *
 * Trust code format:  nxt-XXXX-XXXX  (HMAC-SHA256 prefix, time-limited)
 * nexus:// format:    nexus://SHORTID?code=nxt-XXXX-XXXX&appId=guardian&ttl=300
 *
 * Invariants:
 *   - Codes are single-use. Redemption marks them consumed.
 *   - Codes expire after TTL seconds (default 300 = 5 minutes).
 *   - Session tokens are HMAC-signed, 24h lifetime, renewable.
 *   - AppID → session → IME profile chain is one-directional.
 *   - AppIDs never carry private key material.
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const MODULE_UUID    = 'bridge-appid-v100-0000-000000000001';
const MODULE_VERSION = '1.0.0';

const DEFAULT_CODE_TTL     = 300;   // 5 minutes
const DEFAULT_SESSION_TTL  = 86400; // 24 hours
const CODE_PREFIX          = 'nxt';

// ── Capability sets per appId name ───────────────────────────────────────────
const DEFAULT_CAPABILITIES = {
    guardian:    ['callto', 'listener', 'bus', 'dom'],
    erosmancer:  ['callto', 'cdp', 'bus'],
    cfr:         ['render', 'physics', 'pulse', 'nodes:read'],
    sentinel:    ['data:read', 'bus:read'],
    default:     ['bus:read'],
};

function capabilitiesFor(appId) {
    return DEFAULT_CAPABILITIES[appId] || DEFAULT_CAPABILITIES.default;
}

// ── AppID registry ────────────────────────────────────────────────────────────
class AppIDRegistry {
    constructor({ dataDir, identity, busEmit }) {
        this._dataDir  = dataDir;
        this._identity = identity;
        this._busEmit  = busEmit || (() => {});
        this._storePath = path.join(dataDir, 'appids.json');
        this._apps     = new Map(); // appId → AppID record
        this._codes    = new Map(); // code  → { appId, expiresAt, used }
        this._sessions = new Map(); // token → { appId, expiresAt, uuid }
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this._storePath)) {
                const data = JSON.parse(fs.readFileSync(this._storePath, 'utf8'));
                for (const [k, v] of Object.entries(data.apps || {})) {
                    this._apps.set(k, v);
                }
            }
        } catch {}
    }

    _save() {
        try {
            fs.mkdirSync(this._dataDir, { recursive: true });
            const data = { apps: Object.fromEntries(this._apps), version: MODULE_VERSION };
            fs.writeFileSync(this._storePath, JSON.stringify(data, null, 2));
        } catch {}
    }

    // ── Derive a stable AppID UUID from node identity + appId name ───────────
    _deriveAppUUID(appId) {
        const nodeUuid = this._identity?.uuid || 'unknown';
        return crypto.createHash('sha256')
            .update(`${nodeUuid}:appid:${appId}`)
            .digest('hex')
            .slice(0, 32);
    }

    // ── Generate a time-limited one-time code ─────────────────────────────────
    _generateCode(appId, ttl = DEFAULT_CODE_TTL) {
        // HMAC-sign the appId + timestamp with node's session seed
        const seed      = this._identity?.sessionSeed || crypto.randomBytes(16).toString('hex');
        const ts        = Date.now().toString();
        const hmac      = crypto.createHmac('sha256', seed)
            .update(`${appId}:${ts}`)
            .digest('hex');
        const short     = hmac.slice(0, 4) + '-' + hmac.slice(4, 8);
        const code      = `${CODE_PREFIX}-${short}`;
        const expiresAt = Date.now() + ttl * 1000;

        this._codes.set(code, { appId, expiresAt, used: false, createdAt: Date.now() });

        // Prune old codes
        for (const [k, v] of this._codes) {
            if (v.used || v.expiresAt < Date.now()) this._codes.delete(k);
        }

        return { code, expiresAt, ttl };
    }

    // ── Generate a session token ──────────────────────────────────────────────
    _generateToken(appId, appUuid) {
        const seed      = this._identity?.sessionSeed || 'fallback';
        const payload   = `${appId}:${appUuid}:${Date.now()}`;
        const sig       = crypto.createHmac('sha256', seed).update(payload).digest('hex');
        const token     = `stk-${sig.slice(0, 32)}`;
        const expiresAt = Date.now() + DEFAULT_SESSION_TTL * 1000;

        this._sessions.set(token, { appId, appUuid, expiresAt, createdAt: Date.now() });
        return { token, expiresAt };
    }

    // ── Short ID of this node (first 8 hex of UUID) ───────────────────────────
    _shortId() {
        return (this._identity?.uuid || '00000000').slice(0, 8);
    }

    // ── Build nexus:// URI ────────────────────────────────────────────────────
    _buildURI(code, appId, ttl) {
        const shortId = this._shortId();
        return `nexus://${shortId}?code=${code}&appId=${appId}&ttl=${ttl}`;
    }

    // ── PUBLIC: create or refresh an AppID ───────────────────────────────────
    create(appId, opts = {}) {
        if (!appId || !/^[a-z0-9_-]{1,32}$/.test(appId)) {
            return { ok: false, error: 'Invalid appId — lowercase alphanumeric, max 32 chars' };
        }

        const appUuid = this._deriveAppUUID(appId);
        const caps    = opts.capabilities || capabilitiesFor(appId);
        const ttl     = opts.ttl || DEFAULT_CODE_TTL;

        const existing = this._apps.get(appId) || {
            appId,
            appUuid,
            capabilities: caps,
            createdAt:    Date.now(),
            sessions:     0,
        };

        this._apps.set(appId, existing);
        this._save();

        const { code, expiresAt } = this._generateCode(appId, ttl);
        const uri = this._buildURI(code, appId, ttl);

        this._busEmit('appid:code:created', {
            appId, appUuid, ttl,
            expiresAt: new Date(expiresAt).toISOString(),
        }, 'INFO');

        return {
            ok:           true,
            appId,
            appUuid,
            capabilities: caps,
            code,
            uri,
            expiresAt:    new Date(expiresAt).toISOString(),
            ttl,
            instructions: `Paste the nexus:// URI into Guardian popup, or POST /appid/redeem { code, appId }`,
        };
    }

    // ── PUBLIC: redeem a one-time code → session token ───────────────────────
    redeem(code, appId) {
        const record = this._codes.get(code);

        if (!record) {
            return { ok: false, error: 'Code not found or expired' };
        }
        if (record.used) {
            return { ok: false, error: 'Code already used' };
        }
        if (record.expiresAt < Date.now()) {
            this._codes.delete(code);
            return { ok: false, error: 'Code expired' };
        }
        if (record.appId !== appId) {
            return { ok: false, error: 'Code/appId mismatch' };
        }

        // Mark consumed — single use
        record.used = true;

        const app     = this._apps.get(appId);
        if (!app) return { ok: false, error: 'AppID not registered' };

        // Increment session count
        app.sessions = (app.sessions || 0) + 1;
        app.lastSeen  = Date.now();
        this._save();

        const { token, expiresAt } = this._generateToken(appId, app.appUuid);

        this._busEmit('appid:session:created', {
            appId,
            appUuid:      app.appUuid,
            capabilities: app.capabilities,
            expiresAt:    new Date(expiresAt).toISOString(),
        }, 'INFO');

        return {
            ok:           true,
            appId,
            appUuid:      app.appUuid,
            token,
            capabilities: app.capabilities,
            expiresAt:    new Date(expiresAt).toISOString(),
            sessionTTL:   DEFAULT_SESSION_TTL,
        };
    }

    // ── PUBLIC: validate a session token ─────────────────────────────────────
    validateSession(token) {
        const session = this._sessions.get(token);
        if (!session) return { ok: false, error: 'Invalid token' };
        if (session.expiresAt < Date.now()) {
            this._sessions.delete(token);
            return { ok: false, error: 'Token expired' };
        }
        const app = this._apps.get(session.appId);
        return {
            ok:           true,
            appId:        session.appId,
            appUuid:      session.appUuid,
            capabilities: app?.capabilities || [],
            expiresAt:    new Date(session.expiresAt).toISOString(),
        };
    }

    // ── PUBLIC: list registered AppIDs ────────────────────────────────────────
    list() {
        return [...this._apps.values()].map(a => ({
            appId:        a.appId,
            appUuid:      a.appUuid,
            capabilities: a.capabilities,
            sessions:     a.sessions,
            lastSeen:     a.lastSeen ? new Date(a.lastSeen).toISOString() : null,
            createdAt:    new Date(a.createdAt).toISOString(),
        }));
    }

    diagnostics() {
        return {
            online:       true,
            apps:         this._apps.size,
            pendingCodes: [...this._codes.values()].filter(c => !c.used && c.expiresAt > Date.now()).length,
            activeSessions: [...this._sessions.values()].filter(s => s.expiresAt > Date.now()).length,
        };
    }

    // ── HTTP route handler ────────────────────────────────────────────────────
    route(method, urlParts, body) {
        if (urlParts[0] !== 'appid') return null;
        const sub = urlParts[1];

        // POST /appid/create { appId, ttl?, capabilities? }
        if (method === 'POST' && sub === 'create') {
            const { appId, ttl, capabilities } = body || {};
            if (!appId) return { ok: false, error: 'appId required' };
            return this.create(appId, { ttl, capabilities });
        }

        // POST /appid/redeem { code, appId }
        if (method === 'POST' && sub === 'redeem') {
            const { code, appId } = body || {};
            if (!code || !appId) return { ok: false, error: 'code and appId required' };
            return this.redeem(code, appId);
        }

        // POST /appid/session { token }
        if (method === 'POST' && sub === 'session') {
            const { token } = body || {};
            if (!token) return { ok: false, error: 'token required' };
            return this.validateSession(token);
        }

        // GET /appid/list
        if (method === 'GET' && sub === 'list') {
            return { ok: true, apps: this.list() };
        }

        // GET /appid/stats
        if (method === 'GET' && sub === 'stats') {
            return { ok: true, ...this.diagnostics() };
        }

        return null;
    }
}

module.exports = { AppIDRegistry, MODULE_UUID, MODULE_VERSION };
