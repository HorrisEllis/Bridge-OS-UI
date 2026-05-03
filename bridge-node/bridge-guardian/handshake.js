// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-guardian/handshake.js
 * Guardian ↔ Node handshake + session layer.
 *
 * Manages:
 *   - AppID validation (one-time registration tokens)
 *   - Session token issuance (TTL 5min, auto-renewed via /guardian/heartbeat)
 *   - Guardian instance registry (persisted in guardianSessions Map)
 *   - Route handlers for /guardian/* endpoints
 *
 * Routes:
 *   POST /guardian/handshake   ← Guardian introduces itself, gets session token
 *   POST /guardian/register    ← alias for /guardian/handshake
 *   POST /guardian/heartbeat   ← renew token, get live node list
 *   GET  /guardian/status      ← list connected instances
 *   POST /guardian/appid/create ← CLI: generate AppID
 *   GET  /guardian/appid/list   ← CLI: list AppIDs
 *   DELETE /guardian/appid/:id  ← CLI: revoke AppID
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SESSION_TTL_MS  = 5 * 60 * 1000; // 5 min inactivity → stale
const APPID_TTL_MS    = 7 * 24 * 60 * 60 * 1000; // 7 days

function createGuardianHandshake({ nodeRegistry, busEmit, identity, dataDir }) {
    // ── In-memory session store ─────────────────────────────────────────────
    const sessions = new Map(); // token → sessionRecord

    // ── AppID file store ────────────────────────────────────────────────────
    const appidPath = path.join(dataDir, 'guardian-appids.json');
    let appids = _loadAppids();

    function _loadAppids() {
        try {
            if (fs.existsSync(appidPath)) return JSON.parse(fs.readFileSync(appidPath, 'utf8'));
        } catch {}
        return {};
    }

    function _saveAppids() {
        try { fs.writeFileSync(appidPath, JSON.stringify(appids, null, 2)); } catch {}
    }

    // ── Token generation ────────────────────────────────────────────────────
    function genToken()  { return crypto.randomBytes(32).toString('hex'); }
    function genAppId()  { return crypto.randomBytes(24).toString('hex'); }

    // ── AppID validation ────────────────────────────────────────────────────
    // Returns: true = valid + marks used, false = invalid/used, null = no appid system (open)
    function validateAppId(appId, instanceId) {
        if (!appId) return null; // no appId provided — allow open registration
        const record = appids[appId];
        if (!record)                             return false; // unknown
        if (record.usedBy && record.usedBy !== instanceId) return false; // used by different instance
        if (record.revoked)                      return false;
        if (Date.now() > record.expiresAt)       return false; // expired
        // Mark as used
        if (!record.usedBy) {
            record.usedBy   = instanceId;
            record.usedAt   = Date.now();
            _saveAppids();
        }
        return true;
    }

    // ── Session management ──────────────────────────────────────────────────
    function createSession({ instanceId, guardianVersion, capabilities, remoteAddress }) {
        const token = genToken();
        sessions.set(token, {
            token,
            instanceId,
            guardianVersion: guardianVersion || 'unknown',
            capabilities:    capabilities    || [],
            remoteAddress:   remoteAddress   || '127.0.0.1',
            createdAt:       Date.now(),
            lastSeen:        Date.now(),
            renewCount:      0,
        });
        return token;
    }

    function getSession(token) {
        const s = sessions.get(token);
        if (!s) return null;
        if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
            sessions.delete(token);
            return null;
        }
        return s;
    }

    function renewSession(token) {
        const s = sessions.get(token);
        if (!s) return null;
        s.lastSeen  = Date.now();
        s.renewCount++;
        return s;
    }

    function listSessions() {
        const now = Date.now();
        const alive = [];
        for (const [tok, s] of sessions) {
            if (now - s.lastSeen > SESSION_TTL_MS) { sessions.delete(tok); continue; }
            alive.push({
                instanceId:      s.instanceId,
                guardianVersion: s.guardianVersion,
                capabilities:    s.capabilities,
                connectedMs:     now - s.createdAt,
                lastSeenMs:      now - s.lastSeen,
                renewCount:      s.renewCount,
                healthy:         (now - s.lastSeen) < 30_000,
            });
        }
        return alive;
    }

    // Prune stale sessions every 2 min
    setInterval(() => {
        const now = Date.now();
        for (const [tok, s] of sessions) {
            if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(tok);
        }
    }, 120_000);

    // ── Route handler ────────────────────────────────────────────────────────
    function route(method, urlParts, body, req) {
        const sub = urlParts[1];

        // POST /guardian/handshake  OR  POST /guardian/register
        if (method === 'POST' && (sub === 'handshake' || sub === 'register')) {
            const { appId, instanceId, guardianVersion, capabilities } = body || {};
            if (!instanceId) return { ok: false, error: 'instanceId required', code: 400 };

            const appIdResult = validateAppId(appId, instanceId);
            if (appIdResult === false) return { ok: false, error: 'Invalid, expired, or already-used AppID', code: 403 };

            const token = createSession({
                instanceId, guardianVersion, capabilities,
                remoteAddress: req?.socket?.remoteAddress || '127.0.0.1',
            });

            // Register in node registry as a mesh peer
            try {
                nodeRegistry.register({
                    uuid:      instanceId,
                    address:   req?.socket?.remoteAddress || '127.0.0.1',
                    groupHint: 'guardian',
                });
            } catch {
                nodeRegistry.seen?.(instanceId);
            }

            busEmit?.('guardian:handshake', {
                instanceId, guardianVersion,
                capabilities, appIdUsed: !!appId,
            }, 'INFO');

            return {
                ok:           true,
                ack:          true,
                token,
                sessionId:    token.slice(0, 12),
                meshShortId:  identity.uuid.slice(0, 8),
                nodeUuid:     identity.uuid,
                version:      '1.0.1',
                capabilities: ['callto', 'listener', 'pulse', 'causal', 'cmd'],
                nodes:        nodeRegistry.list().slice(0, 20),
                serverTs:     Date.now(),
            };
        }

        // POST /guardian/heartbeat
        if (method === 'POST' && sub === 'heartbeat') {
            const { token, instanceId: iid, listenerCount, sessionCount, irStats } = body || {};
            if (!token) return { ok: false, error: 'token required', reauth: true, code: 401 };

            const sess = renewSession(token);
            if (!sess)  return { ok: false, error: 'Token expired — re-handshake required', reauth: true, code: 401 };

            if (iid) nodeRegistry.seen?.(iid);

            busEmit?.('guardian:heartbeat', {
                instanceId: sess.instanceId,
                listenerCount: listenerCount || 0,
                sessionCount:  sessionCount  || 0,
            }, 'DEBUG');

            return {
                ok:       true,
                nodes:    nodeRegistry.list().slice(0, 20),
                serverTs: Date.now(),
            };
        }

        // GET /guardian/status
        if (method === 'GET' && sub === 'status') {
            return { ok: true, count: sessions.size, sessions: listSessions() };
        }

        // ── AppID management (CLI-only) ──────────────────────────────────────

        // POST /guardian/appid/create
        if (method === 'POST' && sub === 'appid' && urlParts[2] === 'create') {
            const { label } = body || {};
            const appId = genAppId();
            appids[appId] = {
                appId,
                label:     label || 'guardian-instance',
                createdAt: Date.now(),
                expiresAt: Date.now() + APPID_TTL_MS,
                usedBy:    null,
                usedAt:    null,
                revoked:   false,
            };
            _saveAppids();
            busEmit?.('guardian:appid:created', { label, appId: appId.slice(0, 8) + '…' }, 'INFO');
            return { ok: true, appId, label: label || 'guardian-instance', expiresAt: appids[appId].expiresAt };
        }

        // GET /guardian/appid/list
        if (method === 'GET' && sub === 'appid' && urlParts[2] === 'list') {
            const list = Object.values(appids).map(a => ({
                appId:     a.appId.slice(0, 8) + '…',
                label:     a.label,
                createdAt: a.createdAt,
                expiresAt: a.expiresAt,
                status:    a.revoked ? 'revoked' : a.usedBy ? 'used' : Date.now() > a.expiresAt ? 'expired' : 'available',
                usedBy:    a.usedBy ? a.usedBy.slice(0, 12) + '…' : null,
            }));
            return { ok: true, count: list.length, appids: list };
        }

        // DELETE /guardian/appid/:id
        if (method === 'DELETE' && sub === 'appid' && urlParts[2]) {
            const targetId = urlParts[2];
            // Match by prefix (user may pass first 8 chars)
            const key = Object.keys(appids).find(k => k === targetId || k.startsWith(targetId));
            if (!key) return { ok: false, error: 'AppID not found', code: 404 };
            appids[key].revoked   = true;
            appids[key].revokedAt = Date.now();
            _saveAppids();
            // Invalidate any active sessions using this AppID
            for (const [tok, sess] of sessions) {
                if (appids[key].usedBy === sess.instanceId) sessions.delete(tok);
            }
            busEmit?.('guardian:appid:revoked', { appId: key.slice(0, 8) + '…' }, 'INFO');
            return { ok: true, revoked: key.slice(0, 8) + '…' };
        }

        return null; // not handled
    }

    return { route, listSessions, getSession, genAppId };
}

module.exports = { createGuardianHandshake };
