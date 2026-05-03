// bridge-sync.js — Guardian bridge data sync
// Handles data push to bridge, callto registry, node discovery

const BRIDGE = 'http://127.0.0.1:3747';

async function bridgeFetch(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(BRIDGE + path, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Push event data to bridge data bus
async function dataPush(tag, payload) {
  return bridgeFetch('/data/push', 'POST', { tag, payload, ts: Date.now() });
}

// Get mesh nodes (for DEVICES tab)
async function getNodes() {
  const r = await bridgeFetch('/nodes');
  return r?.nodes || [];
}

// Set active pipe target for cross-device routing
async function pipeToDevice(nodeId) {
  return bridgeFetch(`/nodes/${nodeId}/set-host`, 'POST', {});
}

// Register a callto with the bridge
async function registerCallto(callto) {
  return bridgeFetch('/userscript/callto', 'POST', callto);
}

// Execute a callto on the bridge
async function executeCallto(calltoId, params = {}) {
  return bridgeFetch(`/userscript/callto/${calltoId}/exec`, 'POST', params);
}

// Export calltos as JSON
async function exportCalltos() {
  return bridgeFetch('/userscript/callto');
}

// Check bridge health
async function checkBridge() {
  try {
    const r = await fetch(BRIDGE + '/health', { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
}
