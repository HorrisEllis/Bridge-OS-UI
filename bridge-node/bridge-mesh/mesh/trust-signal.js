// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-mesh/mesh/trust-signal.js
 * Lightweight dispute signal protocol.
 * NOT consensus. NOT global truth. Advisory divergence detection only.
 *
 * From architecture Critique #3 resolution:
 * When two nodes disagree on a third node's trust score by > threshold,
 * both nodes enter observe mode for that UUID until divergence resolves.
 * Human or explicit admin command required to resolve.
 * Neither node changes their score automatically.
 * Sovereignty of each node is preserved.
 *
 * POST /mesh/trust-signal
 * { aboutUuid, myScore, myEvidenceHash, sig }
 */

const crypto = require('crypto');

const DIVERGENCE_THRESHOLD = 4;  // score delta that triggers dispute flag

function createTrustSignalHandler({ ime = null, gate = null, busEmit = null, identity = null } = {}) {

  // In-memory dispute log — persisted by caller if needed
  const _disputes = new Map();  // aboutUuid → dispute[]

  // Send our trust signal about a UUID to a peer
  function makeTrustSignal(aboutUuid) {
    if (!identity || !ime) return null;
    const score = ime.getTrustScore(aboutUuid);
    const profile = ime.getProfile(aboutUuid);
    const evidenceHash = profile
      ? crypto.createHash('sha256').update(JSON.stringify({
          eventCount: profile.eventCount,
          anomalies:  profile.anomalies.length,
          baseline:   !!profile.baseline,
        })).digest('hex')
      : 'no-profile';

    const payload = JSON.stringify({ aboutUuid, myScore: score, myEvidenceHash: evidenceHash, ts: Date.now() });
    return {
      aboutUuid,
      myScore:         score,
      myEvidenceHash:  evidenceHash,
      senderUuid:      identity.uuid,
      sig:             identity.sign(payload),
      ts:              Date.now(),
    };
  }

  // Receive a trust signal from a peer, compare with our score
  function receiveSignal(signal) {
    const { aboutUuid, myScore: theirScore, senderUuid } = signal;
    if (!aboutUuid || theirScore === undefined) return { ok: false, reason: 'invalid signal' };

    const ourScore = ime ? ime.getTrustScore(aboutUuid) : 5;
    const delta    = Math.abs(ourScore - theirScore);

    if (delta >= DIVERGENCE_THRESHOLD) {
      const dispute = {
        id:          crypto.randomUUID(),
        ts:          Date.now(),
        aboutUuid,
        nodeA:       identity?.uuid || 'local',
        nodeB:       senderUuid,
        scoreA:      ourScore,
        scoreB:      theirScore,
        delta,
        action:      'flag',       // never auto-resolve
        resolved:    false,
      };

      if (!_disputes.has(aboutUuid)) _disputes.set(aboutUuid, []);
      _disputes.get(aboutUuid).push(dispute);

      // Both nodes shift to observe mode for the disputed UUID
      busEmit?.('mesh:trust:divergence', dispute, 'WARN');

      // Add sngate observe rule if gate is available
      gate?.rules.add({
        type:    'uuid',
        value:   aboutUuid,
        action:  'observe',
        surface: 'mesh',
        meta:    { reason: 'trust-divergence', disputeId: dispute.id },
      });

      return { ok: true, disputed: true, dispute };
    }

    return { ok: true, disputed: false, delta };
  }

  function resolveDispute(disputeId, resolution = 'admin') {
    for (const [uuid, disputes] of _disputes.entries()) {
      const d = disputes.find(x => x.id === disputeId);
      if (d) {
        d.resolved   = true;
        d.resolution = resolution;
        d.resolvedAt = Date.now();
        busEmit?.('mesh:trust:dispute:resolved', { disputeId, aboutUuid: uuid, resolution }, 'INFO');
        return { ok: true };
      }
    }
    return { ok: false, reason: 'dispute not found' };
  }

  function listDisputes(uuid = null) {
    if (uuid) return _disputes.get(uuid) || [];
    return [..._disputes.values()].flat();
  }

  return { makeTrustSignal, receiveSignal, resolveDispute, listDisputes };
}

module.exports = { createTrustSignalHandler, DIVERGENCE_THRESHOLD };
