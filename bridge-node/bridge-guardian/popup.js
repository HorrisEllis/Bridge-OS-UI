// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// popup.js — Guardian v3.3.2
// IR Layer integrated — route selector wired to all dispatch
// Devices tab: pulse scanner + manual connection system
// URCK migrated to Causal-Nexus protocol

(async function () {
  // One source of truth: manifest.json version updates every [data-guardian-version] element
  try {
    const mf = browser.runtime.getManifest();
    const ver = 'v' + (mf.version || '3.3.1');
    document.querySelectorAll('[data-guardian-version]').forEach(el => { el.textContent = ver; });
  } catch(e) {}


  // ── Particle canvas ────────────────────────────────────────────────────────
  (function initParticles() {
    const canvas = document.getElementById('ptcl');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let W, H, particles;
    function resize() { W = canvas.width = window.innerWidth || 420; H = canvas.height = window.innerHeight || 640; }
    function mkP() { return { x: Math.random()*W, y: Math.random()*H, r: Math.random()*1.2+0.3, vx:(Math.random()-.5)*.25, vy:(Math.random()-.5)*.25, a:Math.random(), hue:Math.random()<.6?192:Math.random()<.7?150:285 }; }
    function init() { resize(); particles = Array.from({length:55},mkP); }
    function draw() {
      ctx.clearRect(0,0,W,H);
      for(const p of particles){
        p.x+=p.vx;p.y+=p.vy;p.a+=.004;
        if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;
        const alpha=(Math.sin(p.a)*.5+.5)*.55;
        ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fillStyle=`hsla(${p.hue},100%,60%,${alpha})`;ctx.fill();
      }
      for(let i=0;i<particles.length;i++)for(let j=i+1;j<particles.length;j++){
        const dx=particles[i].x-particles[j].x,dy=particles[i].y-particles[j].y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<70){ctx.beginPath();ctx.moveTo(particles[i].x,particles[i].y);ctx.lineTo(particles[j].x,particles[j].y);ctx.strokeStyle=`rgba(0,212,255,${(1-d/70)*.08})`;ctx.lineWidth=.5;ctx.stroke();}
      }
      requestAnimationFrame(draw);
    }
    init(); draw(); window.addEventListener('resize',init);
  })();

  // ── Config ─────────────────────────────────────────────────────────────────
  let BRIDGE_URL = (await getSetting('bridgeUrl')) || 'http://127.0.0.1:3747';
  let NEXUS_URL  = (await getSetting('nexusUrl'))  || 'http://127.0.0.1:3747'; // bridge handles /pulse

  let bridgeAlive    = false;
  let nexusAlive     = false;
  let sessionCount   = 0;
  let listenerCount  = 0;
  let calltoIndex    = await loadCalltoIndex();
  let chatLog        = [];
  let pickerActive   = false;
  let handshakeState = { status: 'disconnected', bridgeVersion: null, lastError: null, failCount: 0 };
  let irStats        = { instanceId: '—', retryQueue: 0, discoveredNodes: 0 };
  let _scanActive    = false;

  // ── Storage ─────────────────────────────────────────────────────────────────
  function getSetting(key) { return new Promise(res => browser.storage.local.get(key, r => res(r[key] ?? null))); }
  function setSetting(key, val) { return browser.storage.local.set({ [key]: val }); }
  async function loadCalltoIndex() { const r = await new Promise(res => browser.storage.local.get('calltoIndex', r => res(r.calltoIndex))); return Array.isArray(r) ? r : []; }
  async function saveCalltoIndex() { await browser.storage.local.set({ calltoIndex }); }

  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.ntab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ntab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab)?.classList.add('active');
      if (tab.dataset.tab === 'devices')   initDevicesTab();
      if (tab.dataset.tab === 'capture')   renderCalltoIndex();
      if (tab.dataset.tab === 'settings')  refreshSettings();
      if (tab.dataset.tab === 'listeners') refreshListeners();
    });
  });

  // ── Toast ──────────────────────────────────────────────────────────────────
  let _toastTimer = null;
  function showToast(msg, type = 'ok', dur = 3000) {
    const t = document.getElementById('g-toast');
    if (!t) return;
    clearTimeout(_toastTimer);
    t.textContent = msg;
    t.className = 'g-toast show ' + type;
    _toastTimer = setTimeout(() => { t.className = 'g-toast'; }, dur);
  }

  // ── Route Selector ─────────────────────────────────────────────────────────
  const ROUTE_MAP = {
    nexus:                  { type: 'nexus' },
    pipeline_local:         { type: 'pipeline', steps: [{ type: 'nexus' }, { type: 'local' }] },
    local:                  { type: 'local' },
    mesh:                   { type: 'mesh', mode: 'broadcast' },
    analyze:                { type: 'analyze' },
    pipeline_analyze_nexus: { type: 'pipeline', steps: [{ type: 'analyze' }, { type: 'nexus' }] },
    conditional:            { type: 'conditional', rules: [
      { condition: { field: 'host', op: 'eq', value: 'claude.ai' }, route: { type: 'nexus' } },
      { condition: { field: 'confidence', op: 'lt', value: 0.6 }, route: { type: 'local' } },
    ], fallback: { type: 'nexus' }},
  };

  function resolveRoute() {
    const val = document.getElementById('routeSelector')?.value || 'nexus';
    return ROUTE_MAP[val] || { type: 'nexus' };
  }

  document.getElementById('routeSelector')?.addEventListener('change', function() {
    const label = this.options[this.selectedIndex]?.text || 'nexus';
    const el = document.getElementById('routeIndicator');
    if (el) el.textContent = ROUTE_MAP[this.value]?.type || 'nexus';
    const irEl = document.getElementById('irActiveRoute');
    if (irEl) irEl.textContent = label.replace(/[📡💾🔁🧠⚙→+]/g,'').trim();
  });

  // ── Status ─────────────────────────────────────────────────────────────────
  async function pingUrl(url, timeout = 1800) {
    try {
      const r = await fetch(url + '/health', { method:'GET', signal:AbortSignal.timeout(timeout) });
      return r.ok;
    } catch {
      try { const r2 = await fetch(url, { method:'GET', signal:AbortSignal.timeout(timeout) }); return r2.ok || r2.status < 500; }
      catch { return false; }
    }
  }

  async function checkStatus() {
    [bridgeAlive, nexusAlive] = await Promise.all([pingUrl(BRIDGE_URL), pingUrl(NEXUS_URL)]);
    updateStatusUI();
  }

  function updateStatusUI() {
    const bp = document.getElementById('bridgePill'), bt = document.getElementById('bridgeTxt');
    if (bp && bt) { bp.className = bridgeAlive ? 'pill pill-ok' : 'pill pill-err'; bt.textContent = bridgeAlive ? 'ONLINE' : 'OFFLINE'; }

    for (const [pid, tid] of [['nexusPill','nexusTxt'],['nexusPill2','nexusTxt2']]) {
      const el = document.getElementById(pid), tx = document.getElementById(tid);
      if (!el || !tx) continue;
      el.className = 'npill ' + (nexusAlive ? 'online' : 'offline');
      tx.textContent = nexusAlive ? 'ONLINE' : 'OFFLINE';
    }
    const nd = document.getElementById('nexusDot2');
    if (nd) nd.className = 'alive-dot ' + (nexusAlive ? '' : 'dim');
    const fd = document.getElementById('footerDot');
    if (fd) fd.className = 'alive-dot ' + (bridgeAlive ? '' : 'dim');
    const logo = document.getElementById('nx-logo');
    if (logo) logo.classList.toggle('live', bridgeAlive);

    const sm = document.getElementById('sessionMeta');
    if (sm) sm.textContent = sessionCount + ' session' + (sessionCount !== 1 ? 's' : '') + ' · ' + listenerCount + ' listener' + (listenerCount !== 1 ? 's' : '');
    const sb = document.getElementById('sessionBadge');
    if (sb) sb.textContent = sessionCount;
    const fr = document.getElementById('footerRight');
    if (fr) fr.textContent = bridgeAlive ? 'BRIDGE LIVE' : 'BRIDGE OFFLINE';

    // IR Layer UI
    const irDot = document.getElementById('irDot');
    if (irDot) irDot.className = 'alive-dot ' + (nexusAlive ? 'm' : 'dim');
    const irIns = document.getElementById('irInstance');
    if (irIns) irIns.textContent = (irStats.instanceId || '—').slice(0, 40) + (irStats.instanceId?.length > 40 ? '…' : '');
    const irN = document.getElementById('irNodes');
    if (irN) { irN.textContent = irStats.discoveredNodes + ' discovered'; irN.className = 'diag-val ' + (irStats.discoveredNodes > 0 ? 'ok' : 'dim'); }
    const irR = document.getElementById('irRetry');
    if (irR) { irR.textContent = irStats.retryQueue; irR.className = 'diag-val ' + (irStats.retryQueue > 0 ? 'warn' : 'dim'); }

    // Pulse dot in devices tab
    const pDot = document.getElementById('thisPulseDot');
    const pTxt = document.getElementById('thisPulseTxt');
    if (pDot) pDot.className = 'alive-dot ' + (nexusAlive ? 'm' : 'dim') + ' ' + (nexusAlive ? '' : 'dim');
    if (pTxt) pTxt.textContent = nexusAlive ? 'ACTIVE — 1.5s interval' : 'NEXUS OFFLINE';

    updateHandshakeUI();
  }

  // ── Handshake UI ──────────────────────────────────────────────────────────
  function updateHandshakeUI() {
    const el = document.getElementById('handshakeStatus');
    const dot = document.getElementById('handshakeDot');
    const ver = document.getElementById('bridgeVersion');
    if (!el) return;
    // Toast on state change
    const prev = updateHandshakeUI._last;
    if (prev !== handshakeState.status) {
      if ((handshakeState.status === 'disconnected' || handshakeState.status === 'degraded') && prev === 'connected') {
        showToast('⚠ Bridge disconnected · ' + (handshakeState.lastError || 'bridge not reachable at 127.0.0.1:3747'), 'err', 6000);
      } else if (handshakeState.status === 'connected' && prev !== 'connected') {
        showToast('✓ Bridge connected · v' + (handshakeState.bridgeVersion || '?'), 'ok', 3000);
      }
    }
    updateHandshakeUI._last = handshakeState.status;
    const map = {
      connected:    { text: 'HANDSHAKE OK',   cls: 'ok',   dotCls: 'alive-dot g' },
      handshaking:  { text: 'HANDSHAKING…',   cls: 'warn', dotCls: 'alive-dot y' },
      degraded:     { text: 'DEGRADED',        cls: 'err',  dotCls: 'alive-dot r' },
      disconnected: { text: 'DISCONNECTED',    cls: 'dim',  dotCls: 'alive-dot dim' },
    };
    const s = map[handshakeState.status] || map.disconnected;
    el.textContent = s.text; el.className = 'diag-val ' + s.cls;
    if (dot) dot.className = s.dotCls;
    if (ver) ver.textContent = handshakeState.bridgeVersion ? `v${handshakeState.bridgeVersion}` : '—';
    if (handshakeState.lastError) {
      const errEl = document.getElementById('handshakeError');
      if (errEl) { errEl.textContent = handshakeState.lastError; errEl.style.display = 'block'; }
    }
  }

  // ── Active tab ─────────────────────────────────────────────────────────────
  async function getActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // ── Module badges ──────────────────────────────────────────────────────────
  async function updateModules() {
    const tab = await getActiveTab();
    let host = '';
    try { host = new URL(tab?.url || '').hostname; } catch {}
    const map = { 'mod-instagram':['instagram.com','www.instagram.com'], 'mod-claude':['claude.ai'], 'mod-threads':['threads.net','www.threads.net'], 'mod-chatgpt':['chatgpt.com','chat.openai.com'] };
    let anyOn = false;
    for (const [id, domains] of Object.entries(map)) {
      const el = document.getElementById(id); if (!el) continue;
      const on = domains.some(d => host === d || host.endsWith('.' + d));
      el.classList.toggle('on', on); if (on) anyOn = true;
    }
    const md = document.getElementById('modDot');
    if (md) md.className = 'alive-dot ' + (anyOn ? 'g' : 'dim');
  }

  // ── PICK ELEMENT ──────────────────────────────────────────────────────────
  document.getElementById('btnPick')?.addEventListener('click', async () => {
    const tab = await getActiveTab(); if (!tab) return;
    if (!pickerActive) {
      pickerActive = true;
      const b = document.getElementById('btnPick');
      b.innerHTML = '<span>✕</span> PICKING…';
      b.className = 'btn danger';
      await browser.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
      window.close();
    } else {
      pickerActive = false;
      const b = document.getElementById('btnPick');
      b.innerHTML = '<span>⊕</span> PICK ELEMENT';
      b.className = 'btn primary';
      await browser.tabs.sendMessage(tab.id, { type: 'STOP_PICKER' });
    }
  });

  document.getElementById('btnListen')?.addEventListener('click', async () => {
    const tab = await getActiveTab(); if (!tab) return;
    await browser.tabs.sendMessage(tab.id, { type: 'START_PICKER_LISTEN' });
    window.close();
  });

  document.getElementById('btnCookies')?.addEventListener('click', async () => {
    const tab = await getActiveTab(); if (!tab) return;
    await browser.tabs.sendMessage(tab.id, { type: 'CAPTURE_COOKIES' });
    const b = document.getElementById('btnCookies');
    b.textContent = '✓ CAPTURED'; b.className = 'btn ok';
    setTimeout(() => { b.innerHTML = '<span>◈</span> COOKIES'; b.className = 'btn accent'; }, 1300);
  });

  document.getElementById('btnSnapshot')?.addEventListener('click', async () => {
    const resp = await browser.runtime.sendMessage({ type: 'GET_CAPTURES' });
    const route = resolveRoute();
    const snap = { ts: Date.now(), urckVersion: URCK?.version, irStats, route, calltos: calltoIndex, captures: (resp?.captures || []).slice(-50), chatLog: chatLog.slice(-20) };
    await navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
    const b = document.getElementById('btnSnapshot');
    b.textContent = '✓ COPIED'; b.className = 'btn ok';
    setTimeout(() => { b.innerHTML = '<span>◉</span> SNAPSHOT'; b.className = 'btn'; }, 1300);
  });

  document.getElementById('btnChatLog')?.addEventListener('click', async () => {
    const text = chatLog.map(e => `[${new Date(e.ts).toLocaleTimeString()}] [${e.payload?.provider||'?'}] ${e.payload?.role}: ${(e.payload?.text||'').slice(0,120)}`).join('\n') || 'No chat events.';
    await navigator.clipboard.writeText(text);
    const b = document.getElementById('btnChatLog');
    b.textContent = '✓ COPIED'; b.className = 'btn accent';
    setTimeout(() => { b.innerHTML = '<span>◎</span> CHAT LOG'; b.className = 'btn ok'; }, 1300);
  });

  document.getElementById('btnHandshake')?.addEventListener('click', async () => {
    const b = document.getElementById('btnHandshake');
    b.textContent = 'HANDSHAKING…'; b.disabled = true;
    const r = await browser.runtime.sendMessage({ type: 'FORCE_HANDSHAKE' });
    handshakeState = r?.state || handshakeState;
    updateHandshakeUI();
    b.textContent = r?.ok ? '✓ CONNECTED' : '✗ FAILED';
    b.className = r?.ok ? 'btn ok' : 'btn danger';
    b.disabled = false;
    if (!r?.ok) showToast('✗ Handshake failed: ' + (r?.state?.lastError || 'unknown'), 'err', 5000);
    setTimeout(() => { b.textContent = '⇄ HANDSHAKE'; b.className = 'btn accent'; }, 2000);
  });

  // Killswitch: single tap = stop UI listeners only, double tap (within 1.5s) = full killswitch
  let _ksFirstTap = 0;
  document.getElementById('btnKillswitch')?.addEventListener('click', async () => {
    const now = Date.now();
    const isDouble = (now - _ksFirstTap) < 1500;
    _ksFirstTap = isDouble ? 0 : now;
    const btn = document.getElementById('btnKillswitch');

    if (isDouble) {
      // DOUBLE TAP — full killswitch: all listeners + bridge disconnect + pulse stop
      if (btn) { btn.textContent = '⛔ KILLED'; btn.style.background = 'rgba(255,30,30,0.3)'; }
      await browser.runtime.sendMessage({ type: 'GLOBAL_KILLSWITCH', reason: 'manual-full' });
      await browser.runtime.sendMessage({ type: 'FORCE_DISCONNECT' }).catch(() => {});
      showToast('⛔ FULL KILLSWITCH — all listeners, bridge and pulse terminated', 'err', 4000);
      setTimeout(() => {
        if (btn) { btn.textContent = '⛔ KILLSWITCH'; btn.style.background = ''; }
        _ksFirstTap = 0;
        refreshListeners();
      }, 3000);
    } else {
      // SINGLE TAP — stop UI listeners, keep bridge alive
      if (btn) { btn.textContent = '⚠ AGAIN = FULL'; btn.style.background = 'rgba(255,140,0,0.2)'; }
      await browser.runtime.sendMessage({ type: 'GLOBAL_KILLSWITCH', reason: 'manual-ui' });
      showToast('⚠ Listeners stopped · Tap again within 1.5s for FULL killswitch', 'warn', 2500);
      setTimeout(refreshListeners, 500);
      setTimeout(() => {
        if (btn && btn.textContent.includes('AGAIN')) {
          btn.textContent = '⛔ KILLSWITCH';
          btn.style.background = '';
          _ksFirstTap = 0;
        }
      }, 1500);
    }
  });

  // ── Captures ───────────────────────────────────────────────────────────────
  function timeAgo(ts) { const s=Math.floor((Date.now()-ts)/1000); if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; return Math.floor(s/3600)+'h'; }
  function hostname(url) { try{return new URL(url).hostname.replace('www.','');}catch{return url||'?';} }
  function trunc(s,n=42){return s&&s.length>n?s.slice(0,n-3)+'...':(s||'?');}

  function renderCaptures(captures) {
    const list = document.getElementById('captureList'); if (!list) return;
    const picks = captures.filter(e => e.type === 'guardian.picker.capture');
    if (!picks.length) { list.innerHTML = '<div style="color:var(--text3);font-size:10px;padding:8px 0;text-align:center">No captures yet — pick an element to start</div>'; return; }
    list.innerHTML = picks.slice(-6).reverse().map(e => `
      <div class="cap-row">
        <div class="cap-dot"></div>
        <span class="cap-sel">${trunc(e.payload?.selector||e.payload?.fingerprint?.selector||'?')}</span>
        <span class="cap-host">${hostname(e.payload?.url||'')}</span>
        <span class="cap-age">${timeAgo(e.ts)}</span>
      </div>`).join('');
  }

  async function refreshCaptures() {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'GET_CAPTURES' });
      const all = resp?.captures || [];
      chatLog = all.filter(e => e.type === 'guardian.chat.response' || e.type === 'guardian.chat.message');
      renderCaptures(all);
      const seq = resp?.seq ?? URCK?.clock?.seq ?? '—';
      const el = document.getElementById('urckSeq');
      if (el) el.textContent = 'URCK SEQ ' + seq;
    } catch {}
  }

  // ── Callto index ──────────────────────────────────────────────────────────
  function renderCalltoIndex() {
    const list = document.getElementById('calltoList'), ct = document.getElementById('ctCount');
    if (ct) ct.textContent = calltoIndex.length;
    if (!calltoIndex.length) { list.innerHTML = '<div style="color:var(--text3);font-size:10px;padding:12px 0;text-align:center">No calltos in index yet</div>'; return; }
    list.innerHTML = [...calltoIndex].reverse().map(c => `
      <div class="ct-item">
        <div class="ct-row1"><span class="ct-id">${c.id}</span><span class="ct-action">${c.action||'click'}</span></div>
        <div class="ct-sel">${trunc(c.selector||'?',52)}</div>
        <div class="ct-meta">${hostname(c.url)} · ${trunc(c.label||'',28)} · ${timeAgo(c.ts)} ago</div>
      </div>`).join('');
  }

  document.getElementById('btnExport')?.addEventListener('click', async () => {
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(JSON.stringify(calltoIndex, null, 2));
    a.download = 'guardian-calltos-' + Date.now() + '.json'; a.click();
  });
  document.getElementById('btnCopy')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(calltoIndex, null, 2));
    const b = document.getElementById('btnCopy'); b.textContent = '✓ COPIED'; b.className = 'btn ok';
    setTimeout(() => { b.innerHTML = '⧉ COPY ALL'; b.className = 'btn accent'; }, 1300);
  });
  document.getElementById('btnClear')?.addEventListener('click', async () => {
    if (!confirm('Clear all calltos?')) return;
    calltoIndex = []; await saveCalltoIndex(); renderCalltoIndex();
  });

  // ── Listeners ─────────────────────────────────────────────────────────────
  async function refreshListeners() {
    const r = await browser.runtime.sendMessage({ type: 'GET_LISTENERS' });
    const list = document.getElementById('listenerList'); if (!list) return;
    const ls = r?.listeners || [];
    const lc = document.getElementById('listenerCount');
    if (lc) lc.textContent = ls.filter(l=>l.active).length;
    if (!ls.length) { list.innerHTML = '<div style="color:var(--text3);font-size:10px;padding:12px 0;text-align:center">No active listeners</div>'; return; }
    list.innerHTML = ls.map(l => `
      <div class="ct-item" style="${l.active?'border-color:rgba(204,68,255,0.3)':'opacity:0.4'}">
        <div class="ct-row1">
          <span style="color:#cc44ff;font-size:8px">${l.id}</span>
          <span class="ct-action" style="color:${l.active?'var(--m)':'var(--text3)'}">${l.active?'ACTIVE':'STOPPED'}</span>
        </div>
        <div class="ct-sel">${trunc(l.selector||'?',52)}</div>
        <div class="ct-meta">${hostname(l.url||'')} · mode:${l.mode} · events:${l.eventCount} · ${timeAgo(l.startTs)} ago</div>
        ${l.linkTarget?`<div class="ct-meta" style="color:var(--m);margin-top:2px">→ ${l.linkTarget.type}${l.linkTarget.url?': '+hostname(l.linkTarget.url):''}</div>`:''}
        ${l.active?`<div style="margin-top:5px"><button class="hbtn" onclick="stopListener('${l.id}')">STOP</button></div>`:''}
      </div>`).join('');
  }

  window.stopListener = async (lid) => {
    await browser.runtime.sendMessage({ type: 'STOP_LISTENER', listenerId: lid });
    showToast('Listener stopped: ' + lid.slice(-6));
    setTimeout(refreshListeners, 200);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── DEVICES TAB — FULL REBUILD ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  let _allNodes = { discovered: [], manual: [] };
  let _scanLogEntries = [];

  function _ts() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }

  function _appendScanLog(msg, cls = 'info') {
    _scanLogEntries.push({ ts: _ts(), msg, cls });
    if (_scanLogEntries.length > 50) _scanLogEntries.shift();
    const log = document.getElementById('scanLog');
    if (!log) return;
    log.innerHTML = _scanLogEntries.map(e =>
      `<div class="scan-entry"><span class="ts">${e.ts}</span><span class="msg ${e.cls}">${e.msg}</span></div>`
    ).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function runScan() {
    if (_scanActive) return;
    _scanActive = true;

    const ring = document.getElementById('scanRing');
    const btn  = document.getElementById('btnScan');
    if (ring) ring.classList.add('active');
    if (btn)  { btn.textContent = 'SCANNING…'; btn.disabled = true; }

    _appendScanLog('Initiating pulse scan…', 'info');

    // 1. Fetch discovered nodes from background (via IR pulse)
    try {
      const r = await browser.runtime.sendMessage({ type: 'GET_DISCOVERED_NODES' });
      _allNodes.discovered = r?.nodes?.discovered || [];
      _allNodes.manual     = r?.nodes?.manual     || [];
      _appendScanLog(`Pulse registry: ${_allNodes.discovered.length} node(s) found`, _allNodes.discovered.length > 0 ? 'ok' : 'info');
    } catch (e) {
      _appendScanLog('Pulse registry unavailable: ' + e.message, 'err');
    }

    // 2. Probe known ports on localhost
    const localPorts = [3747, 3748, 3749, 3750, 4747, 4748, 8080, 8747];
    _appendScanLog(`Probing ${localPorts.length} local ports…`, 'info');

    for (const port of localPorts) {
      try {
        const r = await browser.runtime.sendMessage({ type: 'PROBE_NODE', ip: '127.0.0.1', port });
        if (r?.reachable) {
          const existing = _allNodes.discovered.find(n => n.port === port && (n.ip === '127.0.0.1' || n.ip === 'localhost'));
          if (!existing) {
            _allNodes.discovered.push({
              instanceId:   `local-${port}`,
              logicalId:    r.data?.logicalId || `local:${port}`,
              ip:           '127.0.0.1',
              port,
              status:       'online',
              capabilities: r.data?.capabilities || [],
              intent:       r.data?.type || 'unknown',
              lastSeen:     Date.now(),
              manual:       false,
            });
          }
          _appendScanLog(`Port ${port}: ONLINE ← ${r.data?.logicalId || 'unknown service'}`, 'ok');
        }
      } catch {}
    }

    // 3. Probe all manual nodes
    for (const node of _allNodes.manual) {
      _appendScanLog(`Probing manual: ${node.ip}:${node.port}…`, 'info');
      const r = await browser.runtime.sendMessage({ type: 'PROBE_NODE', ip: node.ip, port: node.port });
      node.status  = r?.reachable ? 'online' : 'offline';
      node.lastSeen = r?.reachable ? Date.now() : node.lastSeen;
      _appendScanLog(`${node.label || node.ip+':'+node.port}: ${r?.reachable ? 'ONLINE' : 'OFFLINE'}`, r?.reachable ? 'ok' : 'err');
    }

    _appendScanLog(`Scan complete — ${_allNodes.discovered.length + _allNodes.manual.length} total node(s)`, 'ok');
    renderNodeList();

    if (ring) ring.classList.remove('active');
    if (btn)  { btn.textContent = 'SCAN'; btn.disabled = false; }
    _scanActive = false;
  }

  function renderNodeList() {
    const list = document.getElementById('nodeList');
    if (!list) return;

    const all = [
      ..._allNodes.discovered.map(n => ({ ...n, _type: 'discovered' })),
      ..._allNodes.manual.map(n => ({ ...n, _type: 'manual' })),
    ];

    const meshDot   = document.getElementById('meshDot');
    const nodeCount = document.getElementById('nodeCount');
    const onlineCount = all.filter(n => n.status === 'online').length;
    if (meshDot)   meshDot.className = 'alive-dot ' + (onlineCount > 0 ? 'm' : 'dim');
    if (nodeCount) nodeCount.textContent = all.length;

    if (!all.length) {
      list.innerHTML = '<div style="color:var(--text3);font-size:10px;padding:10px 0;text-align:center">No connections — scan or add manually</div>';
      return;
    }

    // Display short ID — derived only, never used for routing
    // guardian-3000b1c2-0669-... → "3000b1c2"
    function shortGid(instanceId) {
      if (!instanceId) return null;
      const raw = instanceId.startsWith('guardian-') ? instanceId.slice(9) : instanceId;
      return raw.slice(0, 8);
    }

    list.innerHTML = all.map(n => {
      const statusCls  = n.status === 'online' ? 'online' : n.status === 'stale' ? 'stale' : 'offline';
      const intentTag  = n.intent || (n._type === 'manual' ? 'custom' : 'mesh');
      const caps       = Array.isArray(n.capabilities) ? n.capabilities.slice(0, 4).join(' · ') : '';
      const isGuardian = n.intent === 'guardian' || n.logicalId === 'guardian' || (n.instanceId || '').startsWith('guardian');
      const shortId    = isGuardian ? shortGid(n.instanceId) : null;
      const shortIdBadge = shortId
        ? `<span class="node-shortid m">${shortId}</span>`
        : '';

      return `<div class="node-card ${statusCls} ${n._type === 'manual' ? 'manual' : ''} ${intentTag === 'nexus' ? 'nexus' : ''}">
        <div class="node-top">
          <div class="node-status-dot ${statusCls}"></div>
          <span class="node-name" style="color:${n.status==='online'?'var(--c)':'var(--text3)'}">${n.logicalId || n.label || n.instanceId || '?'}</span>
          ${shortIdBadge}
          <span class="node-tag ${intentTag}">${intentTag.toUpperCase()}</span>
          ${n._type === 'manual' ? '<span class="node-tag manual" style="font-size:7px">MANUAL</span>' : ''}
        </div>
        <div class="node-meta">
          <span>${n.ip || '?'}:${n.port || '?'}</span>
          ${n.lastSeen ? `<span>${timeAgo(n.lastSeen)} ago</span>` : ''}
          ${n.instanceId ? `<span style="color:var(--text4);font-size:8px">${n.instanceId.slice(0, 28)}…</span>` : ''}
        </div>
        ${caps ? `<div class="node-caps" style="font-size:8px;color:var(--text3);font-style:italic;margin-bottom:4px">${caps}</div>` : ''}
        <div class="node-acts" style="margin-top:5px">
          ${n.status === 'online' ? `
            <button class="hbtn" onclick="routeToNode('${n.instanceId || n.id}','${n.ip}','${n.port}')">PIPE</button>
            <button class="hbtn" onclick="sendCalltoNode('${n.instanceId || n.id}','${n.ip}','${n.port}')">CALLTO</button>
          ` : `<span style="font-size:8px;color:var(--r)">OFFLINE</span>`}
          ${n._type === 'manual' ? `<button class="hbtn" style="color:var(--r)" onclick="removeNode('${n.id}')">REMOVE</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  window.routeToNode = async (nodeId, ip, port) => {
    await browser.runtime.sendMessage({ type: 'BRIDGE_FETCH', path: `/nodes/${nodeId}/set-host`, method: 'POST', body: {} });
    showToast(`Routing → ${ip}:${port}`);
  };
  window.sendCalltoNode = async (nodeId, ip, port) => {
    const last = calltoIndex[calltoIndex.length - 1]; if (!last) { showToast('No calltos to send', 'warn'); return; }
    const r = await browser.runtime.sendMessage({
      type: 'IR_ROUTE',
      payload: last,
      routeSpec: { type: 'device', instanceId: nodeId, ip, port },
      intent: 'forward',
    });
    if (!r?.ok) showToast('✗ Callto send failed: ' + (r?.reason || 'no response'), 'err');
    else showToast(`✓ Callto sent → ${ip}:${port}`);
  };
  window.removeNode = async (nodeId) => {
    await browser.runtime.sendMessage({ type: 'REMOVE_MANUAL_NODE', nodeId });
    showToast('Node removed');
    initDevicesTab();
  };

  // ── Add manual connection — mode toggle ───────────────────────────────────
  let _connMode = 'instance'; // 'instance' | 'ip'

  document.getElementById('btnAddManual')?.addEventListener('click', () => {
    const form = document.getElementById('addManualForm');
    if (form) form.classList.toggle('open');
  });

  document.querySelectorAll('.conn-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _connMode = btn.dataset.mode;
      document.querySelectorAll('.conn-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('connInstancePanel').style.display = _connMode === 'instance' ? '' : 'none';
      document.getElementById('connIpPanel').style.display       = _connMode === 'ip'       ? '' : 'none';
      document.getElementById('instanceFallback').style.display  = 'none';
    });
  });

  document.getElementById('btnCancelManual')?.addEventListener('click', () => {
    const form = document.getElementById('addManualForm');
    if (form) form.classList.remove('open');
    _resetAddForm();
  });

  function _resetAddForm() {
    ['manualLabel','manualIp','manualPort','manualInstanceId','manualLabelInstance','fallbackIp','fallbackPort']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('instanceFallback').style.display = 'none';
  }

  document.getElementById('btnConfirmManual')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnConfirmManual');
    btn.textContent = 'CONNECTING…'; btn.disabled = true;

    if (_connMode === 'instance') {
      await _connectByInstanceId(btn);
    } else {
      await _connectByIp(btn);
    }

    btn.textContent = '⊕ CONNECT'; btn.disabled = false;
  });

  async function _connectByInstanceId(btn) {
    const instanceId = document.getElementById('manualInstanceId')?.value.trim();
    const label      = document.getElementById('manualLabelInstance')?.value.trim();
    const intent     = document.getElementById('manualIntentInstance')?.value || 'guardian';

    if (!instanceId) { showToast('Instance ID required', 'err'); return; }

    _appendScanLog(`Looking up ${instanceId.slice(0, 20)}…`, 'info');

    // Check if fallback panel is already open (second attempt with IP)
    const fallbackEl = document.getElementById('instanceFallback');
    const fallbackVisible = fallbackEl?.style.display !== 'none';

    if (fallbackVisible) {
      // User has supplied IP+port fallback — do a manual add with instanceId attached
      const ip   = document.getElementById('fallbackIp')?.value.trim();
      const port = parseInt(document.getElementById('fallbackPort')?.value.trim() || '3747', 10);
      if (!ip) { showToast('IP address required', 'err'); return; }

      const r = await browser.runtime.sendMessage({
        type: 'ADD_MANUAL_NODE', ip, port,
        label:      label || instanceId.slice(0, 20),
        intent,
        instanceId,
      });
      if (r?.ok) {
        showToast(`✓ Connected: ${r.node?.label || instanceId.slice(0, 16)}`);
        _appendScanLog(`Connected ${r.node?.label}: ${r.node?.status?.toUpperCase()}`, r.node?.status === 'online' ? 'ok' : 'warn');
        document.getElementById('addManualForm')?.classList.remove('open');
        _resetAddForm();
        await initDevicesTab();
      } else {
        showToast('✗ Connection failed', 'err');
        _appendScanLog('Failed: ' + (r?.reason || 'unknown'), 'err');
      }
      return;
    }

    // First attempt — try pulse registry
    const r = await browser.runtime.sendMessage({
      type: 'CONNECT_BY_INSTANCE_ID', instanceId, label, intent,
    });

    if (r?.ok) {
      showToast(`✓ Connected: ${r.node?.label || instanceId.slice(0, 16)}`);
      _appendScanLog(`Found in pulse registry: ${instanceId.slice(0, 20)}`, 'ok');
      document.getElementById('addManualForm')?.classList.remove('open');
      _resetAddForm();
      await initDevicesTab();
    } else if (r?.partial) {
      // Not in pulse registry — show IP fallback
      _appendScanLog(`Not in pulse registry — enter IP+port to connect`, 'warn');
      if (fallbackEl) fallbackEl.style.display = '';
      showToast('⚠ Enter IP + port to connect directly', 'warn', 4000);
    } else {
      showToast('✗ Failed: ' + (r?.reason || 'unknown'), 'err');
      _appendScanLog('Failed: ' + (r?.reason || 'unknown'), 'err');
    }
  }

  async function _connectByIp(btn) {
    const ip     = document.getElementById('manualIp')?.value.trim();
    const port   = parseInt(document.getElementById('manualPort')?.value.trim() || '3748', 10);
    const label  = document.getElementById('manualLabel')?.value.trim() || `${ip}:${port}`;
    const intent = document.getElementById('manualIntent')?.value || 'nexus';

    if (!ip) { showToast('IP address required', 'err'); return; }
    if (!port || isNaN(port)) { showToast('Valid port required', 'err'); return; }

    _appendScanLog(`Connecting ${label} at ${ip}:${port}…`, 'info');

    const r = await browser.runtime.sendMessage({ type: 'ADD_MANUAL_NODE', ip, port, label, intent });

    if (r?.ok) {
      showToast(`✓ Connected: ${label}`);
      _appendScanLog(`${label}: ${r.node?.status?.toUpperCase() || 'ADDED'}`, r.node?.status === 'online' ? 'ok' : 'warn');
      document.getElementById('addManualForm')?.classList.remove('open');
      _resetAddForm();
      await initDevicesTab();
    } else {
      showToast('✗ Failed to add node', 'err');
      _appendScanLog(`Failed to add ${label}`, 'err');
    }
  }

  document.getElementById('btnScan')?.addEventListener('click', runScan);
  document.getElementById('btnRefreshNodes')?.addEventListener('click', async () => {
    await initDevicesTab();
    runScan();
  });

  async function initDevicesTab() {
    // Populate this-device info
    const r = await browser.runtime.sendMessage({ type: 'GET_IR_STATS' });
    if (r?.instanceId) {
      irStats.instanceId = r.instanceId;
      const el     = document.getElementById('thisInstanceId');
      const shortId = r.instanceId.startsWith('guardian-') ? r.instanceId.slice(9, 17) : r.instanceId.slice(0, 8);
      if (el) el.textContent = r.instanceId;
      // Update short ID badge in header if it exists
      const shortEl = document.getElementById('thisShortId');
      if (shortEl) shortEl.textContent = shortId;
    }
    const bu = document.getElementById('thisBridgeUrl');
    if (bu) bu.textContent = BRIDGE_URL;
    const nu = document.getElementById('thisNexusUrl');
    if (nu) nu.textContent = NEXUS_URL;

    // Load existing nodes silently
    try {
      const nr = await browser.runtime.sendMessage({ type: 'GET_DISCOVERED_NODES' });
      _allNodes.discovered = nr?.nodes?.discovered || [];
      _allNodes.manual     = nr?.nodes?.manual     || [];
      renderNodeList();
    } catch {}
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function refreshSettings() {
    const bi = document.getElementById('bridgeUrlInput');
    const ni = document.getElementById('nexusUrlInput');
    if (bi) bi.value = BRIDGE_URL;
    if (ni) ni.value = NEXUS_URL;
    const us = document.getElementById('urckStats');
    if (us) us.textContent = `Events: ${URCK?.length||0} · Edges: ${URCK?.edgeCount||0} · Macros: ${URCK?.macros?.length||0} · Dropped: ${URCK?.droppedCount||0}`;
  }

  document.getElementById('btnSaveBridgeUrl')?.addEventListener('click', async () => {
    BRIDGE_URL = document.getElementById('bridgeUrlInput').value.trim();
    await setSetting('bridgeUrl', BRIDGE_URL);
    checkStatus();
    const b = document.getElementById('btnSaveBridgeUrl'); b.textContent = 'SAVED ✓'; b.className = 'btn ok';
    setTimeout(() => { b.textContent = 'SAVE'; b.className = 'btn accent'; }, 1300);
  });
  document.getElementById('btnSaveNexusUrl')?.addEventListener('click', async () => {
    NEXUS_URL = document.getElementById('nexusUrlInput').value.trim();
    await setSetting('nexusUrl', NEXUS_URL);
    checkStatus();
    const b = document.getElementById('btnSaveNexusUrl'); b.textContent = 'SAVED ✓'; b.className = 'btn ok';
    setTimeout(() => { b.textContent = 'SAVE'; b.className = 'btn accent'; }, 1300);
  });

  document.querySelectorAll('.chk[data-setting]').forEach(tog => {
    tog.addEventListener('click', async () => {
      tog.classList.toggle('on');
      const on = tog.classList.contains('on');
      tog.innerHTML = `<div class="chk-dot"></div>${on?'ON':'OFF'}`;
      await setSetting(tog.dataset.setting, on);
    });
    getSetting(tog.dataset.setting).then(val => {
      if (val === false) { tog.classList.remove('on'); tog.innerHTML = '<div class="chk-dot"></div>OFF'; }
    });
  });

  document.getElementById('btnResetUrck')?.addEventListener('click', () => {
    if (!confirm('Reset URCK kernel?')) return;
    URCK?.reset(); refreshSettings();
  });

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const tests = {
    bridge:    async () => { const ok = await pingUrl(BRIDGE_URL, 2500); return ok ? {cls:'ok',msg:'PASS'} : {cls:'err',msg:'FAIL — bridge unreachable'}; },
    nexus: async () => {
      // Check bridge /service-status — shows Windows service state
      try {
        const r = await fetch(BRIDGE_URL + '/service-status', { signal: AbortSignal.timeout(2500) });
        if (!r.ok) return { cls:'err', msg:'OFFLINE' };
        const d = await r.json();
        if (d.mode === 'service' && d.running) return { cls:'ok', msg:'SERVICE · running · pid ' + d.pid };
        if (d.mode === 'service-stopped')      return { cls:'warn', msg:'SERVICE installed · STOPPED · start it' };
        if (d.mode === 'in-process')           return { cls:'ok', msg:'IN-PROCESS · pid ' + d.pid + ' · uptime ' + d.uptime + 's' };
        return { cls:'ok', msg:d.mode + ' · ' + d.bridgeVersion };
      } catch(e) {
        return { cls:'err', msg:'OFFLINE — bridge not running' };
      }
    },
    ir:        async () => {
      const r = await browser.runtime.sendMessage({ type: 'GET_IR_STATS' });
      return r?.instanceId ? {cls:'ok',msg:'PASS · ' + r.instanceId.slice(0,16)} : {cls:'err',msg:'FAIL — IR layer not responding'};
    },
    handshake: async () => { const r = await browser.runtime.sendMessage({type:'FORCE_HANDSHAKE'}); handshakeState = r?.state||handshakeState; updateHandshakeUI(); return r?.ok ? {cls:'ok',msg:'PASS · '+handshakeState.bridgeVersion} : {cls:'err',msg:'FAIL · '+(handshakeState.lastError||'?')}; },
    urck:      async () => { const ev = URCK?.ingest('system:test',{ping:true},{source:'guardian:test'}); const found = URCK?.findById(ev?.id); return found?.id===ev?.id ? {cls:'ok',msg:'PASS · seq '+ev?.seq} : {cls:'err',msg:'FAIL'}; },
    callto:    async () => { const id='test-'+Date.now().toString(36); const ev1=URCK?.ingest('command:running',{calltoId:id},{source:'guardian:test'}); URCK?.registerCallto(id,ev1?.id); const resolved=URCK?.resolveCallto(id); const ev2=URCK?.ingest('command:success',{calltoId:id},{source:'guardian:test',causedBy:resolved,edgeType:'causal/adapter'}); const edge=URCK?.edgeMeta(ev2?.id); return resolved&&edge?{cls:'ok',msg:'PASS · edge ✓'}:{cls:'err',msg:'FAIL'}; },
    content:   async () => { const tab=await getActiveTab(); if(!tab)return{cls:'err',msg:'NO TAB'}; try{const r=await browser.tabs.sendMessage(tab.id,{type:'PING'});return r?.pong?{cls:'ok',msg:'PASS'}:{cls:'err',msg:'NO PONG'};}catch{return{cls:'err',msg:'UNREACHABLE'};} },
  };

  async function runTest(name) {
    const el = document.getElementById('t-' + name); if (!el) return;
    el.className = 'diag-val run'; el.textContent = '…';
    try { const r = await tests[name](); el.className = 'diag-val ' + r.cls; el.textContent = r.msg; }
    catch (e) { el.className = 'diag-val err'; el.textContent = 'ERR: ' + e.message.slice(0,30); }
  }

  document.querySelectorAll('.hbtn[data-test]').forEach(b => b.addEventListener('click', () => runTest(b.dataset.test)));
  document.getElementById('btnRunAllTests')?.addEventListener('click', async () => {
    for (const name of Object.keys(tests)) { runTest(name); await new Promise(r => setTimeout(r, 120)); }
  });

  // ── Incoming messages ──────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener(async (msg) => {
    if (msg.type === 'CALLTO_ADDED') {
      calltoIndex.push(msg.callto);
      await saveCalltoIndex();
      refreshCaptures();
      if (document.getElementById('panel-capture')?.classList.contains('active')) renderCalltoIndex();
      const ct = document.getElementById('ctCount'); if (ct) ct.textContent = calltoIndex.length;
      if (msg.ok === false) showToast('✗ Bridge rejected callto: ' + (msg.reason || 'unknown'), 'err', 5000);
    }
    if (msg.type === 'HEARTBEAT') {
      bridgeAlive     = msg.alive;
      sessionCount    = msg.sessions || 0;
      listenerCount   = msg.listenerCount || 0;
      if (msg.handshake) handshakeState = msg.handshake;
      if (msg.discoveredNodes !== undefined) irStats.discoveredNodes = msg.discoveredNodes;
      if (msg.instanceId) irStats.instanceId = msg.instanceId;
      updateStatusUI();
    }
    if (msg.type === 'HANDSHAKE_STATE') { handshakeState = msg.state; updateHandshakeUI(); }
    if (msg.type === 'CONNECTION_DEGRADED') showToast('⚠ Bridge connection degraded: ' + msg.reason, 'warn', 6000);
    if (msg.type === 'CONNECTION_RESTORED') showToast('✓ Bridge connection restored', 'ok');
    if (msg.type === 'ROUTE_FAILURE') showToast(`✗ Route failed [${msg.targetType}]: ${msg.reason}`, 'err', 6000);
    if (msg.type === 'LISTENER_STARTED') { listenerCount++; updateStatusUI(); showToast('⦿ Listener active: ' + msg.listener?.label?.slice(0,30)); }
    if (msg.type === 'LISTENER_STOPPED') { if (listenerCount > 0) listenerCount--; updateStatusUI(); }
    if (msg.type === 'KILLSWITCH') { showToast('⛔ KILLSWITCH — all listeners stopped', 'err'); listenerCount = 0; updateStatusUI(); }
  });

  // BroadcastChannel
  const channel = new BroadcastChannel('guardian-bridge');
  channel.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'HEARTBEAT') {
      bridgeAlive = d.alive; sessionCount = d.sessions || 0; listenerCount = d.listenerCount || 0;
      if (d.handshake) handshakeState = d.handshake;
      if (d.discoveredNodes !== undefined) irStats.discoveredNodes = d.discoveredNodes;
      if (d.instanceId) irStats.instanceId = d.instanceId;
      updateStatusUI();
    }
    if (d.type === 'CALLTO_ADDED') { calltoIndex.push(d.callto); saveCalltoIndex(); refreshCaptures(); if (d.ok === false) showToast('✗ Bridge rejected callto: '+(d.reason||'unknown'),'err',5000); }
    if (d.type === 'HANDSHAKE_STATE') { handshakeState = d.state; updateHandshakeUI(); }
    if (d.type === 'CONNECTION_DEGRADED') showToast('⚠ Bridge degraded: ' + d.reason, 'warn', 6000);
    if (d.type === 'CONNECTION_RESTORED') showToast('✓ Connection restored', 'ok');
    if (d.type === 'ROUTE_FAILURE') showToast(`✗ Route failed [${d.targetType}]: ${d.reason}`, 'err', 6000);
    if (d.type === 'KILLSWITCH') { showToast('⛔ KILLSWITCH', 'err'); listenerCount = 0; updateStatusUI(); }
    if (d.type === 'LISTENER_STARTED') { listenerCount++; updateStatusUI(); }
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  await checkStatus();
  await updateModules();
  await refreshCaptures();
  refreshSettings();

  // Get IR stats from background
  const irR = await browser.runtime.sendMessage({ type: 'GET_IR_STATS' });
  if (irR?.instanceId) {
    irStats.instanceId     = irR.instanceId;
    irStats.retryQueue     = irR.stats?.retryQueue || 0;
    irStats.discoveredNodes = irR.stats?.discoveredNodes || 0;
  }
  const irInsEl = document.getElementById('thisInstanceId');
  if (irInsEl) irInsEl.textContent = irStats.instanceId || '—';

  const hState = await browser.runtime.sendMessage({ type: 'GET_HANDSHAKE_STATE' });
  if (hState?.state) { handshakeState = hState.state; updateHandshakeUI(); }

  browser.runtime.sendMessage({ type:'BRIDGE_FETCH', path:'/info', method:'GET' })
    .then(r => { if (r?.result?.name) { const el = document.getElementById('thisBridgeUrl'); if(el) el.textContent = BRIDGE_URL; } })
    .catch(() => {});

  updateStatusUI();

  // Auto-check service status on open and update the diag row
  (async () => {
    const el = document.getElementById('t-nexus');
    if (!el) return;
    el.className = 'diag-val run'; el.textContent = '…';
    try {
      const r = await fetch(BRIDGE_URL + '/service-status', { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const d = await r.json();
        if (d.mode === 'service' && d.running) { el.className='diag-val ok'; el.textContent='SERVICE · running'; }
        else if (d.mode === 'service-stopped') { el.className='diag-val warn'; el.textContent='SERVICE · stopped'; }
        else { el.className='diag-val ok'; el.textContent='IN-PROCESS · up '+d.uptime+'s'; }
      } else { el.className='diag-val err'; el.textContent='OFFLINE'; }
    } catch { el.className='diag-val err'; el.textContent='OFFLINE'; }
  })();

  const timer = setInterval(async () => {
    await checkStatus();
    const r = await browser.runtime.sendMessage({ type: 'GET_IR_STATS' });
    if (r?.instanceId) { irStats.instanceId = r.instanceId; irStats.retryQueue = r.stats?.retryQueue||0; irStats.discoveredNodes = r.stats?.discoveredNodes||0; updateStatusUI(); }
  }, 6000);
  window.addEventListener('unload', () => clearInterval(timer));

})();
