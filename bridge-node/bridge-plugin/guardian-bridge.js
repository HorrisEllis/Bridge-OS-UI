// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * guardian/bridge-sync.js
 * Guardian → Bridge data pipeline.
 *
 * Two sides:
 * 1. Browser side (extension): URCKKernel._bridgePush() → POST /data/push
 * 2. Bridge side (Node): registerGuardianHook() registers bridge-data hook
 *    to receive Guardian events and route them into URCK kernel + bus
 *
 * Every Guardian action (element pick, cookie capture, site module event,
 * session event, voice save) flows through bridge-data:
 *   Guardian action → URCK.ingest() → _bridgePush() → POST /data/push
 *   → bridge-sngate → delta log → bus:guardian:event → NEXUS modules
 *
 * The Guardian module UUID is fixed and registered in MANIFEST.json.
 * Bridge-data uses it to route callto hooks to the Guardian receiver.
 */

'use strict';

const GUARDIAN_MODULE_UUID = 'guardian-firefox-ext-0000-000000000001';

// ── Bridge-side: register Guardian data hook ──────────────────────────────────
// Called once during bridge-node boot to wire Guardian events into the system.
function registerGuardianHook({ dataBus, busEmit, ime, calltoRegistry }) {
  dataBus.registerHook(GUARDIAN_MODULE_UUID, (data) => {
    const { tag, payload, uuid } = data;

    // Route by tag to appropriate subsystem
    switch (tag) {
      case 'guardian.picker.capture': {
        // Element captured → register as callto in registry
        if (payload?.selector && payload?.origin && calltoRegistry) {
          const callto = calltoRegistry.register({
            action:    'captured',
            selector:  payload.selector,
            origin:    payload.origin,
            sessionId: payload.sessionId || null,
            tag:       'guardian-capture',
            meta:      { backendNodeId: payload.backendNodeId, fingerprint: payload.fingerprint },
          });
          busEmit?.('guardian:element:captured', {
            _uuid:      uuid,
            calltoUuid: callto.uuid,
            selector:   payload.selector,
            origin:     payload.origin,
          }, 'INFO');
        }
        break;
      }

      case 'guardian.cookies.capture': {
        busEmit?.('guardian:cookies:captured', {
          _uuid:  uuid,
          domain: payload?.domain,
          count:  payload?.count,
        }, 'INFO');
        break;
      }

      case 'guardian.chat.message':
      case 'guardian.chat.response': {
        busEmit?.('guardian:chat:event', {
          _uuid:          uuid,
          type:           tag,
          provider:       payload?.provider,
          role:           payload?.role,
          textLength:     payload?.text?.length || 0,
          conversationId: payload?.conversationId,
        }, 'DEBUG');
        break;
      }

      case 'guardian.ig.dm':
      case 'guardian.ig.post':
      case 'guardian.threads.post': {
        busEmit?.('guardian:social:event', {
          _uuid:    uuid,
          type:     tag,
          platform: tag.startsWith('guardian.ig') ? 'instagram' : 'threads',
          url:      payload?.url,
        }, 'DEBUG');
        break;
      }

      case 'guardian.voice.save': {
        busEmit?.('guardian:voice:saved', {
          _uuid:    uuid,
          duration: payload?.duration,
          size:     payload?.size,
        }, 'INFO');
        break;
      }

      case 'guardian.session.connect':
      case 'guardian.session.disconnect': {
        busEmit?.('guardian:session:event', {
          _uuid:  uuid,
          type:   tag,
          tabId:  payload?.tabId,
          origin: payload?.origin,
        }, 'INFO');
        break;
      }

      case 'guardian.bridge.callto':
      case 'guardian.bridge.result': {
        busEmit?.('guardian:callto:event', {
          _uuid:     uuid,
          type:      tag,
          calltoId:  payload?.calltoId,
          action:    payload?.action,
        }, 'DEBUG');
        break;
      }

      default:
        busEmit?.('guardian:event', { _uuid: uuid, tag, payload }, 'DEBUG');
    }
  });

  return GUARDIAN_MODULE_UUID;
}

// ── Browser-side: URCKKernel._bridgePush() implementation ─────────────────────
// This is injected into the extension's urck.js to replace the stub.
// Sends every URCK event to bridge-data with Guardian's module UUID.
const BRIDGE_PUSH_IMPL = `
async _bridgePush(event) {
  try {
    await fetch('http://127.0.0.1:3747/data/push', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        uuid:       this._sessionId || 'guardian-anonymous',
        moduleUuid: '${GUARDIAN_MODULE_UUID}',
        tag:        event.type,
        payload: {
          seq:       event.seq,
          source:    event.source,
          sessionId: event.sessionId,
          tabId:     event.tabId,
          url:       event.url,
          // Summarize payload — never send full DOM or message text
          payloadSummary: event.payload ? Object.keys(event.payload).join(',') : null,
        },
        ts: event.ts,
      }),
    });
  } catch {
    // Non-blocking — Guardian never stalls on bridge availability
  }
}`;

module.exports = { registerGuardianHook, GUARDIAN_MODULE_UUID, BRIDGE_PUSH_IMPL };
