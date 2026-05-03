// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * BRIDGE OS — MODULE/MAGNET
 * Resolution Cascade for nexus:// URIs
 *
 * URI formats:
 *   nexus://8db800b3                         short ID only  → cascade resolves
 *   nexus://8db800b3@192.168.1.5:3747        direct hint    → skip cascade
 *   nexus://8db800b3?pk=<b64>&relay=<addr>   full magnet    → relay fallback
 *
 * Cascade order:
 *   0. Direct @ip:port hint in URI
 *   1. LOCAL  — already a connected peer in nodeState.peers
 *   2. LAN    — seen via UDP pulse broadcast (60s TTL cache)
 *   3. DDNS   — <shortId>.nexus.mesh DNS lookup
 *   4. GOSSIP — ask connected peers (stub)
 *   5. HINT   — ?hint= param in URI
 *   6. RELAY  — ?relay= param in URI
 */

const Magnet = {
    bus:         null,
    _node:       null,
    _pulseCache: new Map(),

    init(bus, node) {
        Magnet.bus   = bus;
        Magnet._node = node || null;

        bus.on('peer:seen', ({ uuid, address, port }) => {
            if (uuid && address) {
                Magnet._pulseCache.set(uuid, {
                    addr: `${address}:${port || 3747}`,
                    ts:   Date.now()
                });
            }
        });

        bus.on('mesh:incoming_pulse', (packet, rinfo) => {
            if (packet.type === 'PULSE' && packet.uuid && rinfo) {
                Magnet._pulseCache.set(packet.uuid, {
                    addr: `${rinfo.address}:${packet.port || rinfo.port || 3747}`,
                    ts:   Date.now()
                });
            }
        });

        bus.on('mesh:peer:get', (uuidOrShort, cb) => {
            if (typeof cb !== 'function') return;
            const peers = (Magnet._node && Magnet._node.peers) || [];
            const peer  = peers.find(p =>
                p.uuid === uuidOrShort ||
                (p.uuid && p.uuid.startsWith(uuidOrShort))
            );
            cb(peer ? { addr: `${peer.address}:${peer.port || 3747}` } : null);
        });

        bus.on('mesh:pulse:lookup', (uuidOrShort, cb) => {
            if (typeof cb !== 'function') return;
            let found = Magnet._pulseCache.get(uuidOrShort);
            if (!found) {
                for (const [key, val] of Magnet._pulseCache) {
                    if (key.startsWith(uuidOrShort)) { found = val; break; }
                }
            }
            cb(found && (Date.now() - found.ts < 60_000) ? found : null);
        });

        bus.on('mesh:gossip:query', (uuid, cb) => {
            if (typeof cb === 'function') cb(null);
        });

        bus.on('magnet:resolve', async (uri, callback) => {
            if (typeof callback !== 'function') return;
            try {
                const params     = Magnet.parse(uri);
                const resolution = await Magnet.cascade(params);
                callback({ success: true, resolution });
            } catch (e) {
                callback({ success: false, error: e.message });
            }
        });
    },

    async cascade(params) {
        const { uuid } = params;

        if (params.ip) {
            return { ...params, route: 'DIRECT', addr: `${params.ip}:${params.port || 3747}` };
        }

        const local = await Magnet.request('mesh:peer:get', uuid);
        if (local) return { ...params, route: 'LOCAL', addr: local.addr };

        const lan = await Magnet.request('mesh:pulse:lookup', uuid);
        if (lan) return { ...params, route: 'LAN', addr: lan.addr };

        const ddns = await Magnet.request('dns:resolve', `${uuid.slice(0, 8)}.nexus.mesh`);
        if (ddns) return { ...params, route: 'DDNS', addr: ddns };

        const gossip = await Magnet.request('mesh:gossip:query', uuid);
        if (gossip) return { ...params, route: 'GOSSIP', addr: gossip };

        if (params.hint)  return { ...params, route: 'HINT',  addr: params.hint };
        if (params.relay) return { ...params, route: 'RELAY', via:  params.relay };

        throw new Error(`NODE_UNREACHABLE: ${uuid.slice(0, 8)}`);
    },

    parse(uri) {
        const match = uri.match(/^nexus:\/\/([a-f0-9-]{8,})(?:@([^?]+))?(?:\?(.*))?$/i);
        if (!match) throw new Error(`MALFORMED_URI: ${uri}`);

        const [, uuid, host, qs] = match;
        const params = Object.fromEntries(new URLSearchParams(qs || ''));
        const [ip, portStr] = (host || '').split(':');

        return {
            uuid,
            ip:    ip      || null,
            port:  portStr ? parseInt(portStr, 10) : 3747,
            pk:    params.pk    || null,
            relay: params.relay || null,
            hint:  params.hint  || null,
            sig:   params.sig   || null
        };
    },

    request(event, data) {
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => {
                if (!done) { done = true; resolve(null); }
            }, 2000);
            Magnet.bus.emit(event, data, (res) => {
                if (!done) { done = true; clearTimeout(timer); resolve(res); }
            });
        });
    }
};

module.exports = Magnet;
