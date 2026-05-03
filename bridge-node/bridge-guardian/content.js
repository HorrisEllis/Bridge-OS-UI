// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// content.js — Guardian v2.0.0
// Fixed: popup auto-close after ADD TO INDEX
// New: Listener mode, background tab support, ESC killswitch, failure toasts, link routing

(function () {
  if (window.__guardianContent) return;
  window.__guardianContent = true;

  const HOST = window.location.hostname;

  // ── Inject styles ────────────────────────────────────────────────────────
  const STYLE = document.createElement('style');
  STYLE.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Rajdhani:wght@600;700&display=swap');

    #__g-mask {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0);
      z-index: 2147483640; pointer-events: none;
      transition: background 0.2s ease;
    }
    #__g-mask.on { background: rgba(0,0,0,0.6); }

    #__g-sel {
      position: fixed; z-index: 2147483641; pointer-events: none;
      border: 2px solid #00ffa3; border-radius: 3px;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.58), 0 0 0 3px rgba(0,255,163,0.25),
                  0 0 18px rgba(0,255,163,0.4), inset 0 0 0 1px rgba(0,255,163,0.12);
      display: none;
      transition: top 0.04s, left 0.04s, width 0.04s, height 0.04s;
    }
    #__g-sel.listener-mode {
      border-color: #cc44ff;
      box-shadow: 0 0 0 9999px rgba(0,0,0,0.58), 0 0 0 3px rgba(204,68,255,0.25),
                  0 0 18px rgba(204,68,255,0.4), inset 0 0 0 1px rgba(204,68,255,0.12);
    }
    #__g-sel::before, #__g-sel::after, #__g-sel-c::before, #__g-sel-c::after {
      content: ''; position: absolute; width: 9px; height: 9px;
      border-color: #00ffa3; border-style: solid;
    }
    #__g-sel.listener-mode::before, #__g-sel.listener-mode::after,
    #__g-sel.listener-mode ~ * ::before, #__g-sel.listener-mode ~ * ::after {
      border-color: #cc44ff;
    }
    #__g-sel::before  { top: -2px; left: -2px;   border-width: 2px 0 0 2px; }
    #__g-sel::after   { top: -2px; right: -2px;  border-width: 2px 2px 0 0; }
    #__g-sel-c { position: absolute; inset: 0; pointer-events: none; }
    #__g-sel-c::before { bottom: -2px; left: -2px;  border-width: 0 0 2px 2px; }
    #__g-sel-c::after  { bottom: -2px; right: -2px; border-width: 0 2px 2px 0; }

    #__g-sel-scan {
      position: absolute; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(0,255,163,0.7) 50%, transparent 100%);
      animation: g-scan 1.4s ease-in-out infinite; pointer-events: none;
    }
    #__g-sel.listener-mode #__g-sel-scan {
      background: linear-gradient(90deg, transparent 0%, rgba(204,68,255,0.7) 50%, transparent 100%);
    }
    @keyframes g-scan { 0% { top: 0%; opacity: 0; } 5% { opacity: 1; } 95% { opacity: 1; } 100% { top: 100%; opacity: 0; } }

    #__g-overlay {
      position: fixed; inset: 0; z-index: 2147483642;
      pointer-events: none; cursor: crosshair;
    }
    #__g-overlay.picking { pointer-events: none; cursor: crosshair; }

    #__g-tip {
      position: fixed; z-index: 2147483647;
      background: #080c10; border: 1px solid rgba(0,255,163,0.5);
      border-left: 2px solid #00ffa3; border-radius: 2px;
      padding: 5px 10px; font: 500 11px/1.4 'IBM Plex Mono', monospace;
      pointer-events: none; max-width: 280px; white-space: nowrap; display: none;
      box-shadow: 0 2px 12px rgba(0,0,0,0.8), 0 0 8px rgba(0,255,163,0.15);
    }
    #__g-tip.listener-mode { border-color: rgba(204,68,255,0.5); border-left-color: #cc44ff; }
    #__g-tip-tag { font-family: 'Rajdhani', sans-serif; font-size: 9px; letter-spacing: 0.12em; color: rgba(0,255,163,0.5); margin-bottom: 2px; }
    #__g-tip.listener-mode #__g-tip-tag { color: rgba(204,68,255,0.6); }
    #__g-tip-sel { color: #00ffa3; font-size: 11px; }
    #__g-tip.listener-mode #__g-tip-sel { color: #cc44ff; }
    #__g-tip-dims { font-size: 9px; color: rgba(0,255,163,0.4); margin-top: 1px; }

    #__g-esc {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483648; background: rgba(8,12,16,0.92);
      border: 1px solid rgba(0,255,163,0.25); padding: 5px 16px;
      font: 10px/1.5 'IBM Plex Mono', monospace; color: rgba(0,255,163,0.6);
      border-radius: 2px; pointer-events: none; display: none;
      box-shadow: 0 2px 12px rgba(0,0,0,0.6);
    }
    #__g-esc.listener-mode { border-color: rgba(204,68,255,0.35); color: rgba(204,68,255,0.7); }
    #__g-esc.show { display: block; animation: g-fadein 0.2s ease; }
    @keyframes g-fadein { from { opacity:0; transform: translateX(-50%) translateY(-4px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }

    /* ── Callto Popup ── */
    #__g-popup {
      position: fixed; z-index: 2147483649; width: 330px;
      background: #080c10; border: 1px solid rgba(0,255,163,0.3);
      border-top: 2px solid #00ffa3; border-radius: 3px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.85), 0 0 20px rgba(0,255,163,0.1);
      font-family: 'IBM Plex Mono', monospace; display: none; overflow: hidden;
    }
    #__g-popup.listener-mode { border-color: rgba(204,68,255,0.3); border-top-color: #cc44ff; }
    #__g-popup.show { display: block; animation: g-popup-in 0.18s ease-out; }
    @keyframes g-popup-in { from { opacity:0; transform: scale(0.96) translateY(6px); } to { opacity:1; transform: scale(1) translateY(0); } }

    #__g-popup-hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 11px; background: rgba(0,255,163,0.06);
      border-bottom: 1px solid rgba(0,255,163,0.15);
    }
    #__g-popup.listener-mode #__g-popup-hdr { background: rgba(204,68,255,0.06); border-bottom-color: rgba(204,68,255,0.15); }
    #__g-popup-title { font-family: 'Rajdhani', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; color: #00ffa3; }
    #__g-popup.listener-mode #__g-popup-title { color: #cc44ff; }
    #__g-popup-close { background: none; border: none; cursor: pointer; color: rgba(0,255,163,0.4); font-size: 14px; line-height: 1; padding: 0 2px; }
    #__g-popup-close:hover { color: #00ffa3; }
    #__g-popup-body { padding: 10px 11px; }

    .gf { margin-bottom: 8px; }
    .gf-label { font-size: 8.5px; letter-spacing: 0.14em; color: rgba(200,220,240,0.35); text-transform: uppercase; margin-bottom: 3px; }
    .gf-val { font-size: 10px; color: #00c8ff; background: rgba(0,200,255,0.06); border: 1px solid rgba(0,200,255,0.15); border-radius: 2px; padding: 4px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gf-input {
      width: 100%; font: 10px/1.4 'IBM Plex Mono', monospace; color: #c8d8e8;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 2px; padding: 4px 8px; outline: none; transition: border-color 0.15s;
    }
    .gf-input:focus { border-color: rgba(0,255,163,0.4); color: #00ffa3; }

    #__g-ct-id-row { display: flex; align-items: center; gap: 5px; }
    #__g-ct-id { flex: 1; font: 9px/1.4 'IBM Plex Mono', monospace; color: rgba(0,255,163,0.5); background: transparent; border: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #__g-ct-regen { background: none; border: none; cursor: pointer; color: rgba(0,255,163,0.35); font-size: 13px; line-height: 1; padding: 0; transition: color 0.15s; }
    #__g-ct-regen:hover { color: #00ffa3; }

    #__g-popup-actions { display: flex; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); }
    .gf-btn { flex: 1; padding: 7px; font-family: 'Rajdhani', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.1em; border-radius: 2px; cursor: pointer; border: 1px solid; transition: all 0.15s; }
    .__g-zoom-btn { background: rgba(0,255,163,0.05); border: 1px solid rgba(0,255,163,0.2); border-radius: 2px; color: rgba(0,255,163,0.6); font: 700 9px 'Rajdhani',sans-serif; letter-spacing: .1em; padding: 2px 7px; cursor: pointer; transition: all .15s; }
    .__g-zoom-btn:hover { background: rgba(0,255,163,0.12); border-color: rgba(0,255,163,0.5); color: #00ffa3; }
    .__g-nearby-chip { background: rgba(0,212,255,0.06); border: 1px solid rgba(0,212,255,0.25); border-radius: 2px; color: rgba(0,212,255,0.8); font: 9px 'IBM Plex Mono',monospace; padding: 2px 7px; cursor: pointer; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .__g-nearby-chip:hover { background: rgba(0,212,255,0.14); border-color: rgba(0,212,255,0.6); }
    #__g-btn-add    { background: rgba(0,255,163,0.1);  border-color: rgba(0,255,163,0.4);  color: #00ffa3; }
    #__g-btn-add:hover { background: rgba(0,255,163,0.2); border-color: #00ffa3; }
    /* LISTEN button: opens listener config modal — NOT a callto action */
    #__g-btn-listen { background: rgba(204,68,255,0.1); border-color: rgba(204,68,255,0.4); color: #cc44ff; }
    #__g-btn-listen:hover { background: rgba(204,68,255,0.2); border-color: #cc44ff; }
    #__g-btn-pick   { background: transparent; border-color: rgba(0,200,255,0.3); color: rgba(0,200,255,0.7); }
    #__g-btn-pick:hover { border-color: #00c8ff; color: #00c8ff; }
    #__g-btn-cancel { background: transparent; border-color: rgba(255,255,255,0.08); color: rgba(200,220,240,0.35); }
    #__g-btn-cancel:hover { border-color: rgba(255,59,59,0.4); color: #ff3b3b; }

    /* ── Listener Config Modal (separate from callto popup) ── */
    #__g-listen-modal {
      position: fixed; z-index: 2147483649; width: 340px;
      background: #080c10; border: 1px solid rgba(204,68,255,0.4);
      border-top: 2px solid #cc44ff; border-radius: 3px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.85), 0 0 24px rgba(204,68,255,0.12);
      font-family: 'IBM Plex Mono', monospace; display: none; overflow: hidden;
    }
    #__g-listen-modal.show { display: block; animation: g-popup-in 0.18s ease-out; }
    #__g-listen-modal-hdr {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 11px; background: rgba(204,68,255,0.07);
      border-bottom: 1px solid rgba(204,68,255,0.2);
    }
    #__g-listen-modal-title { font-family: 'Rajdhani', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; color: #cc44ff; }
    #__g-listen-modal-close { background: none; border: none; cursor: pointer; color: rgba(204,68,255,0.4); font-size: 14px; line-height: 1; padding: 0 2px; }
    #__g-listen-modal-close:hover { color: #cc44ff; }
    #__g-listen-modal-body { padding: 10px 11px; }
    .lm-section-title { font-family: 'Rajdhani', sans-serif; font-size: 9px; letter-spacing: 0.18em; color: rgba(204,68,255,0.5); text-transform: uppercase; margin: 8px 0 4px; }
    .lm-info { font-size: 9px; color: rgba(200,220,240,0.3); line-height: 1.5; margin-bottom: 8px; }
    #__g-listen-modal-actions { display: flex; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(204,68,255,0.1); }
    .lm-btn-confirm { flex:1; padding:7px; font-family:'Rajdhani',sans-serif; font-size:12px; font-weight:700; letter-spacing:.1em; border-radius:2px; cursor:pointer; border:1px solid rgba(204,68,255,0.4); background:rgba(204,68,255,0.1); color:#cc44ff; transition:all .15s; }
    .lm-btn-confirm:hover { background:rgba(204,68,255,0.2); border-color:#cc44ff; }
    .lm-btn-cancel  { flex:1; padding:7px; font-family:'Rajdhani',sans-serif; font-size:12px; font-weight:700; letter-spacing:.1em; border-radius:2px; cursor:pointer; border:1px solid rgba(255,255,255,0.08); background:transparent; color:rgba(200,220,240,0.35); transition:all .15s; }
    .lm-btn-cancel:hover { border-color:rgba(255,59,59,.4); color:#ff3b3b; }

    /* link target sub-section inside listener modal */
    .lm-link-opt { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid rgba(204,68,255,0.18); border-radius:2px; cursor:pointer; margin-bottom:4px; transition:background .1s; }
    .lm-link-opt:hover { background:rgba(204,68,255,0.06); border-color:rgba(204,68,255,0.35); }
    .lm-link-opt.selected { background:rgba(204,68,255,0.1); border-color:#cc44ff; }
    .lm-link-opt-icon { font-size:13px; }
    .lm-link-opt-label { font-size:10px; color:#cc44ff; display:block; font-family:'Rajdhani',sans-serif; letter-spacing:.08em; }
    .lm-link-opt-desc  { font-size:9px; color:rgba(200,220,240,0.45); }
    .lm-url-row { display:none; margin-top:5px; }
    .lm-url-row.show { display:block; }
    #__g-link-actions { display: flex; gap: 6px; margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.05); }

    /* ── Listener badge (shows on active listeners) ── */
    .g-listener-badge {
      position: fixed; z-index: 2147483645;
      background: rgba(204,68,255,0.15); border: 1px solid rgba(204,68,255,0.5);
      border-radius: 2px; padding: 3px 8px; font: 9px 'IBM Plex Mono', monospace;
      color: #cc44ff; pointer-events: none; animation: g-pulse-m 2s ease-in-out infinite;
    }
    @keyframes g-pulse-m { 0%,100%{box-shadow:0 0 6px rgba(204,68,255,0.3)} 50%{box-shadow:0 0 16px rgba(204,68,255,0.6)} }

    /* ── Toast ── */
    #__g-toast {
      position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
      z-index: 2147483650; background: #080c10;
      border: 1px solid rgba(0,255,163,0.4); border-left: 3px solid #00ffa3;
      padding: 6px 16px; font: 11px/1.4 'IBM Plex Mono', monospace;
      color: #00ffa3; border-radius: 2px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6); pointer-events: none; opacity: 0;
      transition: opacity 0.2s; white-space: nowrap; max-width: 380px;
    }
    #__g-toast.show { opacity: 1; }
    #__g-toast.err { border-color: rgba(255,45,85,0.4); border-left-color: #ff2d55; color: #ff2d55; }
    #__g-toast.warn { border-color: rgba(255,204,0,0.4); border-left-color: #ffcc00; color: #ffcc00; }

    /* ── Killswitch flash ── */
    @keyframes g-kill-flash { 0%{background:rgba(255,45,85,0.25)} 100%{background:transparent} }
  `;
  document.head.appendChild(STYLE);

  // ── Build DOM ────────────────────────────────────────────────────────────
  function el(tag, id, html) {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (html) e.innerHTML = html;
    return e;
  }

  const selBox  = el('div', '__g-sel', '<div id="__g-sel-c"></div><div id="__g-sel-scan"></div>');
  const overlay = el('div', '__g-overlay');
  const tip     = el('div', '__g-tip', `<div id="__g-tip-tag">GUARDIAN · SELECT</div><div id="__g-tip-sel">—</div><div id="__g-tip-dims">—</div>`);
  const escHint = el('div', '__g-esc');
  const toast   = el('div', '__g-toast');

  const popup = el('div', '__g-popup');
  popup.innerHTML = `
    <div id="__g-popup-hdr">
      <div id="__g-popup-title">◈ GENERATE CALLTO</div>
      <button id="__g-popup-close">✕</button>
    </div>
    <div id="__g-popup-body">
      <div class="gf"><div class="gf-label">Selector</div><div class="gf-val" id="__g-ct-sel">—</div></div>
      <div id="__g-zoom-bar" style="display:flex;align-items:center;gap:4px;padding:4px 0 2px;flex-wrap:wrap;">
        <button class="__g-zoom-btn" id="__g-zoom-parent" title="Select parent element">↑ PARENT</button>
        <button class="__g-zoom-btn" id="__g-zoom-child"  title="Select first child">↓ CHILD</button>
        <button class="__g-zoom-btn" id="__g-zoom-prev"   title="Previous sibling">← PREV</button>
        <button class="__g-zoom-btn" id="__g-zoom-next"   title="Next sibling">→ NEXT</button>
        <span id="__g-zoom-depth" style="font:9px 'IBM Plex Mono',monospace;color:rgba(0,255,163,0.4);margin-left:4px"></span>
      </div>
      <div id="__g-nearby-row" style="display:none;padding:3px 0 4px;">
        <div style="font:9px 'IBM Plex Mono',monospace;color:rgba(0,255,163,0.3);margin-bottom:3px;">NEARBY</div>
        <div id="__g-nearby-chips" style="display:flex;flex-wrap:wrap;gap:4px;"></div>
      </div>
      <div class="gf"><div class="gf-label">Label</div><input class="gf-input" id="__g-ct-label" placeholder="e.g. submit-btn" maxlength="60"/></div>
      <div class="gf" id="__g-action-row">
        <div class="gf-label">Action</div>
        <select class="gf-input" id="__g-ct-action">
          <option value="click">click</option>
          <option value="type">type</option>
          <option value="focus">focus</option>
          <option value="hover">hover</option>
          <option value="extract">extract text</option>
          <option value="screenshot">screenshot</option>
        </select>
      </div>
      <div class="gf">
        <div class="gf-label">Callto ID</div>
        <div id="__g-ct-id-row"><div id="__g-ct-id">—</div><button id="__g-ct-regen" title="Regenerate ID">↻</button></div>
      </div>
      <div id="__g-popup-actions">
        <button class="gf-btn" id="__g-btn-add">ADD TO INDEX</button>
        <button class="gf-btn" id="__g-btn-listen">⦿ LISTEN</button>
        <button class="gf-btn" id="__g-btn-pick">RE-PICK</button>
        <button class="gf-btn" id="__g-btn-cancel">CANCEL</button>
      </div>
    </div>
  `;

  // ── Listener Config Modal (separate DOM node — NOT part of callto popup) ──
  const listenModal = el('div', '__g-listen-modal');
  listenModal.innerHTML = `
    <div id="__g-listen-modal-hdr">
      <div id="__g-listen-modal-title">⦿ LISTENER CONFIG</div>
      <button id="__g-listen-modal-close">✕</button>
    </div>
    <div id="__g-listen-modal-body">
      <div class="gf"><div class="gf-label">Element</div><div class="gf-val" id="__g-lm-sel">—</div></div>
      <div class="gf"><div class="gf-label">Label</div><input class="gf-input" id="__g-lm-label" placeholder="e.g. chat-output" maxlength="60"/></div>
      <div class="gf">
        <div class="gf-label">Observe Mode</div>
        <select class="gf-input" id="__g-lm-mode">
          <option value="mutation">DOM mutations (all child/text changes)</option>
          <option value="input">Input / value changes</option>
          <option value="chat">Chat messages (AI stream)</option>
        </select>
      </div>
      <div class="gf">
        <div class="gf-label">Emit Callto Type</div>
        <select class="gf-input" id="__g-lm-callto-type">
          <option value="mutation">mutation</option>
          <option value="listen">listen</option>
        </select>
      </div>
      <div class="lm-section-title">LINK TARGET (optional)</div>
      <div class="lm-info">Where mutation Calltos are routed. Leave blank to route via IR Layer default.</div>
      <div class="lm-link-opt" data-lm-link="bridge" id="__g-lm-link-bridge">
        <span class="lm-link-opt-icon">⬡</span>
        <div><span class="lm-link-opt-label">Another Bridge / Guardian</span><span class="lm-link-opt-desc">POST mutation events to a bridge /bus/emit endpoint</span></div>
      </div>
      <div class="lm-url-row" id="__g-lm-bridge-row">
        <div class="gf-label">Bridge URL</div>
        <input class="gf-input" id="__g-lm-bridge-url" placeholder="http://192.168.x.x:3747"/>
      </div>
      <div class="lm-link-opt" data-lm-link="callto" id="__g-lm-link-callto">
        <span class="lm-link-opt-icon">⊕</span>
        <div><span class="lm-link-opt-label">Trigger a Callto</span><span class="lm-link-opt-desc">Execute a registered callto on each mutation</span></div>
      </div>
      <div class="lm-url-row" id="__g-lm-callto-row">
        <div class="gf-label">Callto ID</div>
        <input class="gf-input" id="__g-lm-callto-id" placeholder="callto-xxxxxxxx"/>
      </div>
      <div class="lm-link-opt" data-lm-link="url" id="__g-lm-link-url">
        <span class="lm-link-opt-icon">↗</span>
        <div><span class="lm-link-opt-label">External Endpoint</span><span class="lm-link-opt-desc">POST mutation Calltos to any HTTP URL</span></div>
      </div>
      <div class="lm-url-row" id="__g-lm-url-row">
        <div class="gf-label">Endpoint URL</div>
        <input class="gf-input" id="__g-lm-url-input" placeholder="https://your-service.com/hook"/>
      </div>
      <div class="lm-link-opt" data-lm-link="nexus" id="__g-lm-link-nexus">
        <span class="lm-link-opt-icon">📡</span>
        <div><span class="lm-link-opt-label">Nexus (via IR Layer)</span><span class="lm-link-opt-desc">Route via IR Layer to Nexus /ingest — default behaviour</span></div>
      </div>
      <div id="__g-listen-modal-actions">
        <button class="lm-btn-confirm" id="__g-lm-btn-confirm">⦿ START LISTENER</button>
        <button class="lm-btn-cancel"  id="__g-lm-btn-cancel">CANCEL</button>
      </div>
      <div id="__g-lm-log-section" style="display:none;margin-top:8px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <span style="font:700 9px 'Rajdhani',sans-serif;letter-spacing:.12em;color:rgba(0,212,255,0.6)">EVENT LOG</span>
          <span id="__g-lm-log-count" style="font:9px 'IBM Plex Mono',monospace;color:rgba(255,255,255,0.3)">0 events</span>
          <button id="__g-lm-log-export" style="margin-left:auto;background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);border-radius:2px;color:rgba(0,212,255,0.7);font:700 9px 'Rajdhani',sans-serif;padding:2px 8px;cursor:pointer;letter-spacing:.1em;">⬇ EXPORT</button>
          <button id="__g-lm-log-clear" style="background:rgba(255,60,60,0.08);border:1px solid rgba(255,60,60,0.2);border-radius:2px;color:rgba(255,100,100,0.7);font:700 9px 'Rajdhani',sans-serif;padding:2px 8px;cursor:pointer;letter-spacing:.1em;">CLEAR</button>
        </div>
        <div id="__g-lm-log-list" style="max-height:100px;overflow-y:auto;font:9px 'IBM Plex Mono',monospace;color:rgba(255,255,255,0.45);line-height:1.6;background:rgba(0,0,0,0.2);border-radius:2px;padding:4px 6px;"></div>
      </div>
    </div>
  `;

  for (const e of [selBox, overlay, tip, escHint, toast, popup, listenModal]) {
    document.body.appendChild(e);
  }

  // ── State ────────────────────────────────────────────────────────────────
  let pickerActive   = false;
  let pickerMode       = 'callto';   // always 'callto' — listener is a separate modal path
  let _currentEl       = null;
  let _currentFp       = null;
  let _calltoId        = null;
  let _toastTimer      = null;
  let _linkType        = null;       // unused legacy, kept for safety
  let _currentHighlight = null;      // kept for compatibility, no longer used for styling
  // Listener event log: { listenerId → [{ts, type, before, after, selector}] }
  const _listenerLog   = {};
  const LISTENER_LOG_MAX = 500;
  let _lmLinkType    = null;       // selected link type inside listener modal
  let _pendingListenerId = null;   // pending listener config

  // Active listeners on this page: listenerId → { observer, el, badges }
  const activeListeners = new Map();

  // ── Helpers ──────────────────────────────────────────────────────────────
  function genCalltoId() { return 'callto-' + crypto.randomUUID().slice(0, 8); }
  function truncSel(s, n = 45) { return s?.length > n ? s.slice(0, n - 3) + '...' : (s || '?'); }

  function fingerprint(el) {
    if (!el || !el.tagName) return { tag:'unknown', selector:'unknown', xpath:'/', rect:{top:0,left:0,width:0,height:0}, url:window.location.href, text:'', id:'', classes:'', name:'', type:'', ariaLabel:'' };
    try {
      const tag  = el.tagName.toLowerCase();
      const id   = el.id ? '#' + el.id : '';
      // Safe classList access — SVG elements have non-iterable classList in Firefox
      let cls = '';
      try {
        const classArr = el.classList ? Array.from(el.classList) : [];
        cls = classArr
          .filter(c => c && c.length > 1 && c.length < 40 && !/^[a-z]{1,2}$/.test(c) && !/^\d/.test(c))
          .slice(0, 3).map(c => '.' + c).join('');
      } catch(_) {}
      // Safe getAttribute — some elements throw
      const safeAttr = (name) => { try { return el.getAttribute ? el.getAttribute(name) || '' : ''; } catch(_) { return ''; } };
      const name  = safeAttr('name')       ? `[name="${safeAttr('name').slice(0,30)}"]` : '';
      const type  = safeAttr('type')       ? `[type="${safeAttr('type')}"]` : '';
      const aria  = safeAttr('aria-label') ? `[aria-label="${safeAttr('aria-label').slice(0,30)}"]` : '';
      const ph    = safeAttr('placeholder')? `[placeholder="${safeAttr('placeholder').slice(0,20)}"]` : '';
      const selector = (id ? tag + id : tag + cls + name + type + ph) || tag;
      const text  = (el.innerText || el.textContent || '').trim().slice(0, 40);
      const rect  = el.getBoundingClientRect();
      return {
        tag, id, classes: cls, name, type, ariaLabel: aria, text, selector,
        xpath: getXPath(el),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        url: window.location.href,
      };
    } catch(err) {
      const tag = (el.tagName || 'unknown').toLowerCase();
      return { tag, selector: tag, xpath: '/' + tag, rect:{top:0,left:0,width:0,height:0}, url:window.location.href, text:'', id:'', classes:'', name:'', type:'', ariaLabel:'' };
    }
  }

  function getXPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = []; let node = el;
    while (node && node.nodeType === 1) {
      let idx = 1, sib = node.previousSibling;
      while (sib) { if (sib.nodeType === 1 && sib.tagName === node.tagName) idx++; sib = sib.previousSibling; }
      parts.unshift(node.tagName.toLowerCase() + (idx > 1 ? `[${idx}]` : ''));
      node = node.parentNode;
    }
    return '/' + parts.join('/');
  }

  function positionTooltip(rect) {
    const vw = window.innerWidth, vh = window.innerHeight, pad = 10;
    let top = rect.top - 52, left = rect.left;
    if (top < pad) top = rect.bottom + pad;
    if (left + 290 > vw - pad) left = vw - 290 - pad;
    if (left < pad) left = pad;
    if (top + 52 > vh - pad) top = vh - 60;
    tip.style.top = top + 'px'; tip.style.left = left + 'px';
  }

  function showToast(msg, type = 'ok', dur = 2800) {
    clearTimeout(_toastTimer);
    toast.textContent = msg;
    toast.className = 'show' + (type !== 'ok' ? ' ' + type : '');
    _toastTimer = setTimeout(() => { toast.className = ''; }, dur);
  }

  // ── Selection zone ───────────────────────────────────────────────────────
  // Refs cached once at init — never query DOM inside move handler
  const _tipTag  = document.getElementById('__g-tip-tag');
  const _tipSel  = document.getElementById('__g-tip-sel');
  const _tipDims = document.getElementById('__g-tip-dims');

  function updateSel(el, r) {
    // r passed in — caller already computed getBoundingClientRect, no extra call
    selBox.style.top    = r.top    + 'px';
    selBox.style.left   = r.left   + 'px';
    selBox.style.width  = r.width  + 'px';
    selBox.style.height = r.height + 'px';
    selBox.style.display = 'block';
    if (_tipTag)  _tipTag.textContent  = pickerMode === 'listener' ? 'GUARDIAN · LISTEN' : 'GUARDIAN · SELECT';
    if (_tipSel)  _tipSel.textContent  = el.tagName.toLowerCase()
      + (el.id ? '#' + el.id.slice(0, 20)
        : (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\s+/)[0].slice(0, 20) : '');
    if (_tipDims) _tipDims.textContent = Math.round(r.width) + '\xd7' + Math.round(r.height);
    tip.style.display = 'block';
    positionTooltip(r);
  }
  function hideSel() { selBox.style.display = 'none'; tip.style.display = 'none'; }

  // ── Picker — ZERO-REFLOW, ZERO-LEAK ──────────────────────────────────────
  // Design:
  //   overlay is pointer-events:none AT ALL TIMES — we NEVER toggle it
  //   pointermove fires on document, passes through overlay naturally
  //   AbortController removes all listeners in one call — impossible to leak
  //   rAF id tracked — if a frame is in flight, new moves update coords but
  //   don't schedule another frame (last-write-wins, no queue buildup)
  //   try/finally in rAF callback — _rafId always cleared even on throw

  let _pickerAbort = null;

  function startPicker(mode = 'callto') {
    if (pickerActive) stopPicker(true);  // always clean up first
    pickerMode   = mode;
    pickerActive = true;

    overlay.classList.add('picking');
    selBox.classList.toggle('listener-mode', mode === 'listener');
    tip.classList.toggle('listener-mode', mode === 'listener');
    escHint.className = 'show' + (mode === 'listener' ? ' listener-mode' : '');
    escHint.textContent = mode === 'listener'
      ? 'LISTEN MODE — click element  ·  ESC to cancel'
      : 'PICKING — click element to capture  ·  ESC to cancel';
    document.body.style.cursor = 'crosshair';

    _pickerAbort = new AbortController();
    const sig = _pickerAbort.signal;

    let _rafId = null;
    let _mx = 0, _my = 0;

    document.addEventListener('pointermove', (e) => {
      _mx = e.clientX; _my = e.clientY;
      if (_rafId !== null) return;
      _rafId = requestAnimationFrame(() => {
        try {
          if (!pickerActive) return;
          const t = document.elementFromPoint(_mx, _my);
          if (!t || t === selBox || t === tip || t === overlay || t === escHint) return;
          if (t.id && t.id.startsWith('__g-')) return;
          _currentEl = t;
          updateSel(t, t.getBoundingClientRect());
        } finally {
          _rafId = null;  // always reset — even if we throw
        }
      });
    }, { signal: sig, passive: true });

    document.addEventListener('pointerdown', (e) => {
      if (!pickerActive) return;
      // Guard: ignore clicks on Guardian's own UI
      let _tgt = e.target;
      while (_tgt) {
        if (_tgt.id && _tgt.id.startsWith('__g-')) return;
        _tgt = _tgt.parentElement;
      }
      e.preventDefault();
      e.stopPropagation();
      // Use e.target as primary source — it's the real element the pointer hit
      // Fall back to _currentEl (last hover target) then elementFromPoint
      const t = (e.target && e.target !== document.body && e.target !== document.documentElement)
        ? e.target
        : (_currentEl || document.elementFromPoint(e.clientX, e.clientY));
      if (!t) return;
      _currentEl = t;
      try {
        _currentFp = fingerprint(t);
      } catch(fpErr) {
        showToast('⚠ Could not fingerprint element: ' + fpErr.message.slice(0,40), 'warn');
        return;
      }
      if (!_currentFp || !_currentFp.selector) {
        showToast('⚠ Element not fingerprintable (shadow DOM?)', 'warn');
        return;
      }
      stopPicker(true);
      openPopup(_currentFp, e.clientX, e.clientY);
    }, { signal: sig, capture: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') stopPicker();
    }, { signal: sig });

    try { if (typeof URCK !== 'undefined') URCK.ingest('guardian.picker.start', { url: window.location.href, mode }, { source: 'content' }); } catch(_) {}
  }

  function stopPicker(silent) {
    if (!pickerActive) return;
    pickerActive = false;
    if (_pickerAbort) { _pickerAbort.abort(); _pickerAbort = null; }
    overlay.classList.remove('picking');
    escHint.className = '';
    document.body.style.cursor = '';
    hideSel();
    if (!silent) try { if (typeof URCK !== 'undefined') URCK.ingest('guardian.picker.stop', { url: window.location.href }, { source: 'content' }); } catch(_) {}
  }

  // Kept for any code that still calls onKey directly
  function onKey(e) { if (e.key === 'Escape') stopPicker(); }


  // ── Global killswitch ────────────────────────────────────────────────────
  // Re-entrancy guard — prevents the background broadcast round-trip from
  // calling triggerKillswitch() a second time on this same tab.
  let _killswitchActive = false;

  // notify=true  → self-initiated (ESC, button): tell background so other tabs die too
  // notify=false → initiated by background broadcast: local cleanup only, no re-broadcast
  function triggerKillswitch(reason = 'ESC', notify = true) {
    if (_killswitchActive) return;
    _killswitchActive = true;

    stopPicker(true);
    closeCalltoPopup(true);

    for (const [lid] of activeListeners) detachListenerDOM(lid);
    activeListeners.clear();

    if (notify) {
      // Only send to background when self-initiated — background skips our tab in broadcast
      browser.runtime.sendMessage({ type: 'GLOBAL_KILLSWITCH', reason }).catch(() => {});
    }
    // If notify=false, background already knows and already handled other tabs.

    document.body.style.animation = 'g-kill-flash 0.4s ease-out';
    setTimeout(() => { document.body.style.animation = ''; }, 400);
    showToast('⛔ KILLSWITCH — all listeners stopped', 'err', 2000);

    setTimeout(() => { _killswitchActive = false; }, 0);
  }

  // ── Single global ESC handler — registered once, never duplicated ─────────
  // Distinct from onKey (which only lives during picking).
  // Uses { capture: true } so it fires before any page handler can swallow it.
  document.addEventListener('keydown', function onGlobalEsc(e) {
    if (e.key !== 'Escape') return;
    if (pickerActive) {
      // Picker is active — let onKey (registered by startPicker) handle it.
      // Do NOT also trigger killswitch here.
      return;
    }
    triggerKillswitch('ESC');
  }, { capture: true });

  // ── Popup ────────────────────────────────────────────────────────────────
  function openPopup(fp, cx, cy) {
    _calltoId = genCalltoId();
    _linkType = null;

    // Callto popup is always in callto mode — no listener-mode state here
    popup.classList.remove('listener-mode');
    document.getElementById('__g-popup-title').textContent = '◈ GENERATE CALLTO';

    document.getElementById('__g-ct-sel').textContent   = truncSel(fp.selector);
    document.getElementById('__g-ct-label').value       = '';
    document.getElementById('__g-ct-action').value      = 'click';
    document.getElementById('__g-ct-id').textContent    = _calltoId;

    // Action row is ALWAYS shown — callto popup is callto-only
    document.getElementById('__g-action-row').style.display = '';

    // Position
    const vw = window.innerWidth, vh = window.innerHeight;
    let px = cx + 12, py = cy + 12;
    if (px + 340 > vw - 10) px = cx - 340 - 12;
    if (py + 380 > vh - 10) py = cy - 380 - 12;
    if (px < 10) px = 10; if (py < 10) py = 10;
    popup.style.left = px + 'px'; popup.style.top = py + 'px';
    popup.classList.add('show');
  }

  function closeCalltoPopup(silent) {
    popup.classList.remove('show', 'listener-mode');
    _currentFp         = null;
    _calltoId          = null;
    _linkType          = null;
    _pendingListenerId = null;
    pickerMode = 'callto';
  }

  // ── Listener Config Modal open/close ──────────────────────────────────────
  function openListenModal(fp, cx, cy) {
    // Populate from the already-captured fingerprint
    document.getElementById('__g-lm-sel').textContent     = truncSel(fp.selector);
    document.getElementById('__g-lm-label').value         = '';
    document.getElementById('__g-lm-mode').value          = 'mutation';
    document.getElementById('__g-lm-callto-type').value   = 'mutation';

    // Reset link selection
    document.querySelectorAll('.lm-link-opt').forEach(o => o.classList.remove('selected'));
    document.querySelectorAll('.lm-url-row').forEach(r => r.classList.remove('show'));
    _lmLinkType = null;

    // Position near callto popup (offset slightly so both visible)
    const vw = window.innerWidth, vh = window.innerHeight;
    let px = cx + 16, py = cy + 16;
    if (px + 350 > vw - 10) px = cx - 350 - 16;
    if (py + 500 > vh - 10) py = Math.max(10, vh - 510);
    if (px < 10) px = 10;
    listenModal.style.left = px + 'px'; listenModal.style.top = py + 'px';
    listenModal.classList.add('show');

    // Show log section if listener already has events
    const matchId = Object.keys(_listenerLog).find(k => k.includes(fp.selector || ''));
    if (matchId && _listenerLog[matchId]?.length) {
      if (typeof showListenerLog === 'function') showListenerLog(matchId);
    }
  }

  function closeListenModal() {
    listenModal.classList.remove('show');
    _lmLinkType        = null;
    _pendingListenerId = null;
  }

  // ── Commit callto ────────────────────────────────────────────────────────
  async function commitCallto() {
    if (!_currentFp || !_calltoId) return;
    const label  = document.getElementById('__g-ct-label').value.trim();
    const action = document.getElementById('__g-ct-action').value;

    const callto = {
      id:          _calltoId,
      selector:    _currentFp.selector,
      xpath:       _currentFp.xpath,
      label:       label || _currentFp.selector,
      action,
      url:         window.location.href,
      host:        HOST,
      ts:          Date.now(),
      fingerprint: _currentFp,
    };

    // URCK ingest
    if (typeof URCK !== 'undefined') {
      const ev = URCK.ingest('guardian.picker.capture', callto, { source: 'content', url: window.location.href });
      URCK.registerCallto(_calltoId, ev.id);
    }

    // ── FIX: Close popup IMMEDIATELY before async bridge call ─────────────
    const savedId    = _calltoId;
    const savedLabel = label || _calltoId;
    closeCalltoPopup(true);

    // Now send to background (non-blocking from user's perspective)
    const result = await browser.runtime.sendMessage({ type: 'CALLTO_ADDED', callto });

    if (result?.ok === false) {
      showToast(`✗ Bridge rejected callto: ${result.reason || 'unknown error'}`, 'err', 4000);
    } else if (result?.ok) {
      showToast('✓ callto registered → ' + savedLabel);
    } else {
      // No response or ambiguous — show warning
      showToast('⚠ callto saved locally (bridge status unknown)', 'warn', 3000);
    }
  }

  // ── Commit listener — called from modal CONFIRM button ───────────────────
  async function commitListener() {
    if (!_pendingListenerId) return;
    const label    = document.getElementById('__g-lm-label').value.trim();
    const mode     = document.getElementById('__g-lm-mode').value;
    const calltoType = document.getElementById('__g-lm-callto-type').value;

    let linkTarget = null;
    if (_lmLinkType === 'bridge') {
      const url = document.getElementById('__g-lm-bridge-url').value.trim();
      if (!url) { showToast('⚠ Enter a bridge URL', 'warn'); return; }
      linkTarget = { type: 'bridge', url };
    } else if (_lmLinkType === 'callto') {
      const cid = document.getElementById('__g-lm-callto-id').value.trim();
      if (!cid) { showToast('⚠ Enter a callto ID', 'warn'); return; }
      linkTarget = { type: 'callto', calltoId: cid };
    } else if (_lmLinkType === 'url') {
      const url = document.getElementById('__g-lm-url-input').value.trim();
      if (!url) { showToast('⚠ Enter an endpoint URL', 'warn'); return; }
      linkTarget = { type: 'url', url };
    } else if (_lmLinkType === 'nexus') {
      linkTarget = { type: 'nexus' };
    } else {
      // Default: always route to Nexus via bridge bus
      // This ensures every listener sends data back to NEXUS console/SSE
      linkTarget = { type: 'bridge', url: BRIDGE_URL_DEFAULT || 'http://127.0.0.1:3747' };
    }

    const config = {
      ..._pendingListenerId,
      label:      label || _pendingListenerId.selector,
      mode,
      calltoType,
      linkTarget,
    };

    const savedLabel = config.label;
    closeListenModal();

    const result = await browser.runtime.sendMessage({ type: 'START_LISTENER', config });
    if (result?.ok) {
      showToast(`⦿ Listener active → ${savedLabel}`, 'ok', 3000);
    } else {
      showToast(`✗ Listener failed to start`, 'err', 3000);
    }
  }

  // ── Listener modal link-type selection ────────────────────────────────────
  document.querySelectorAll('.lm-link-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.lm-link-opt').forEach(o => o.classList.remove('selected'));
      document.querySelectorAll('.lm-url-row').forEach(r => r.classList.remove('show'));
      opt.classList.add('selected');
      _lmLinkType = opt.dataset.lmLink;
      const rowMap = { bridge: '__g-lm-bridge-row', callto: '__g-lm-callto-row', url: '__g-lm-url-row' };
      const rowId = rowMap[_lmLinkType];
      if (rowId) document.getElementById(rowId).classList.add('show');
    });
  });

  document.getElementById('__g-lm-btn-confirm').addEventListener('click', commitListener);
  document.getElementById('__g-lm-btn-cancel').addEventListener('click',  closeListenModal);
  document.getElementById('__g-listen-modal-close').addEventListener('click', closeListenModal);

  // ── Listener log helpers ──────────────────────────────────────────────────
  function showListenerLog(listenerId) {
    const section  = document.getElementById('__g-lm-log-section');
    const list     = document.getElementById('__g-lm-log-list');
    const countEl  = document.getElementById('__g-lm-log-count');
    if (!section || !list) return;

    const entries = _listenerLog[listenerId] || [];
    section.style.display = 'block';
    countEl.textContent   = entries.length + ' event' + (entries.length !== 1 ? 's' : '');

    list.innerHTML = entries.slice(-40).reverse().map(e => {
      const t   = new Date(e.ts).toTimeString().slice(0, 8);
      const typ = e.type || 'event';
      const val = (e.text || e.value || '').slice(0, 60).replace(/</g, '&lt;');
      return `<div><span style="color:rgba(0,255,163,0.4)">${t}</span> <span style="color:rgba(0,212,255,0.6)">${typ}</span>${val ? ' · ' + val : ''}</div>`;
    }).join('') || '<div style="color:rgba(255,255,255,0.2)">No events yet</div>';
  }

  document.getElementById('__g-lm-log-export')?.addEventListener('click', () => {
    const lid     = _pendingListenerId?.selector || 'listener';
    const entries = _listenerLog[Object.keys(_listenerLog).pop()] || [];
    const blob    = new Blob([JSON.stringify({ listenerId: lid, entries }, null, 2)], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = 'guardian-listener-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('✓ Log exported', 'ok', 2000);
  });

  document.getElementById('__g-lm-log-clear')?.addEventListener('click', () => {
    const lid = Object.keys(_listenerLog).pop();
    if (lid) _listenerLog[lid] = [];
    showListenerLog(lid);
    showToast('Log cleared', 'ok', 1500);
  });

  // Refresh log display on every modal open
  const _origOpenListenModal = openListenModal;
  // (openListenModal is defined as function, will pick up showListenerLog via closure)

  // ── DOM Listener attachment (content side) ────────────────────────────────
  function attachListenerDOM(listenerId, selector, xpath, mode) {
    // Find element
    let target = null;
    try { target = document.querySelector(selector); } catch {}
    if (!target && xpath) {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        target = r.singleNodeValue;
      } catch {}
    }
    if (!target) {
      browser.runtime.sendMessage({
        type: 'LISTENER_EVENT',
        listenerId,
        eventData: { type: 'error', reason: `Element not found: ${selector}`, ts: Date.now() },
      });
      return false;
    }

    const badge = document.createElement('div');
    badge.className = 'g-listener-badge';
    badge.textContent = `⦿ ${listenerId.slice(-6)}`;
    // Position badge near element
    const rect = target.getBoundingClientRect();
    badge.style.cssText = `top:${rect.top + window.scrollY - 22}px;left:${rect.left + window.scrollX}px;`;
    document.body.appendChild(badge);

    let observer = null;

    function emit(data) {
      // Record to local log ring buffer
      if (!_listenerLog[listenerId]) _listenerLog[listenerId] = [];
      const entry = { ...data, ts: Date.now(), selector, url: window.location.href };
      _listenerLog[listenerId].push(entry);
      if (_listenerLog[listenerId].length > LISTENER_LOG_MAX) _listenerLog[listenerId].shift();
      // Cap total listener keys to 20 — remove oldest when exceeded
      const keys = Object.keys(_listenerLog);
      if (keys.length > 20) delete _listenerLog[keys[0]];
      // Forward to background
      browser.runtime.sendMessage({ type: 'LISTENER_EVENT', listenerId, eventData: entry }).catch(() => {});
    }

    if (mode === 'mutation' || mode === 'chat') {
      observer = new MutationObserver(mutations => {
        for (const m of mutations) {
          const text = target.innerText?.trim() || target.value || '';
          emit({ type: 'mutation', mutationType: m.type, text: text.slice(0, 2000), addedNodes: m.addedNodes.length, removedNodes: m.removedNodes.length });
        }
      });
      observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: false });
    }

    if (mode === 'input') {
      const handler = () => {
        emit({ type: 'input', value: (target.value || target.innerText || '').slice(0, 2000) });
      };
      target.addEventListener('input',  handler);
      target.addEventListener('change', handler);
      observer = { disconnect: () => { target.removeEventListener('input', handler); target.removeEventListener('change', handler); } };
    }

    activeListeners.set(listenerId, { observer, target, badge });
    return true;
  }

  function detachListenerDOM(listenerId) {
    const entry = activeListeners.get(listenerId);
    if (!entry) return;
    entry.observer?.disconnect();
    entry.badge?.remove();
    activeListeners.delete(listenerId);
  }

  // ── Button wiring ─────────────────────────────────────────────────────────
  document.getElementById('__g-popup-close').addEventListener('click', closeCalltoPopup);
  document.getElementById('__g-btn-cancel').addEventListener('click',  closeCalltoPopup);

  document.getElementById('__g-btn-add').addEventListener('click', commitCallto);

  // LISTEN button: opens the listener config modal with the current element.
  // It does NOT commit a callto. Callto popup stays open so user can still ADD TO INDEX.
  document.getElementById('__g-btn-listen').addEventListener('click', () => {
    if (!_currentFp) return;
    // Stash fingerprint for the listener modal
    _pendingListenerId = {
      selector: _currentFp.selector,
      xpath:    _currentFp.xpath,
      url:      window.location.href,
    };
    // Get position from callto popup for placement
    const popupRect = popup.getBoundingClientRect();
    openListenModal(_currentFp, popupRect.right + 8, popupRect.top);
  });

  document.getElementById('__g-ct-regen').addEventListener('click', () => {
    _calltoId = genCalltoId();
    document.getElementById('__g-ct-id').textContent = _calltoId;
  });

  document.getElementById('__g-btn-pick').addEventListener('click', () => {
    closeCalltoPopup(true);
    setTimeout(() => startPicker(pickerMode), 80);
  });

  // ── Zoom controls ─────────────────────────────────────────────────────────
  // Navigate element tree without re-picking. Updates _currentEl + _currentFp.

  function _zoomDepthLabel(el) {
    // Build a compact breadcrumb: body > div#app > section > button
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 5) {
      let label = node.tagName.toLowerCase();
      if (node.id) label += '#' + node.id.slice(0, 12);
      else if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/)[0];
        if (cls) label += '.' + cls.slice(0, 12);
      }
      parts.unshift(label);
      node = node.parentElement;
    }
    return parts.join(' › ');
  }

  function _zoomTo(el) {
    if (!el || el === document || el === document.body) return;
    _currentEl = el;
    _currentFp = fingerprint(el);
    _calltoId  = genCalltoId();

    // Update popup fields only — NEVER modify page element styles
    const selEl = document.getElementById('__g-ct-sel');
    const idEl  = document.getElementById('__g-ct-id');
    const depEl = document.getElementById('__g-zoom-depth');
    if (selEl) selEl.textContent = _currentFp.selector.length > 40
      ? '…' + _currentFp.selector.slice(-40) : _currentFp.selector;
    if (idEl)  idEl.textContent  = _calltoId;
    if (depEl) depEl.textContent = _zoomDepthLabel(el);

    // Use the existing selection box (selBox) to highlight — not el.style
    const r = el.getBoundingClientRect();
    if (selBox) {
      selBox.style.left   = (r.left   + window.scrollX) + 'px';
      selBox.style.top    = (r.top    + window.scrollY) + 'px';
      selBox.style.width  = r.width  + 'px';
      selBox.style.height = r.height + 'px';
      selBox.style.display = 'block';
    }

    // Nearby suggestions
    _renderNearbySuggestions(el);
  }

  function _renderNearbySuggestions(el) {
    const nearbyRow   = document.getElementById('__g-nearby-row');
    const nearbyChips = document.getElementById('__g-nearby-chips');
    if (!nearbyRow || !nearbyChips) return;

    const INTERACTIVE_TAGS = new Set(['a','button','input','select','textarea','label','summary','details']);
    const rect  = el.getBoundingClientRect();
    const found = [];

    // Check siblings, parent's siblings, parent's children
    const candidates = [
      ...(el.parentElement ? [...el.parentElement.children] : []),
      ...(el.parentElement?.parentElement ? [...el.parentElement.parentElement.querySelectorAll('a,button,input,select,textarea')] : []),
    ];

    for (const c of candidates) {
      if (c === el) continue;
      if (found.length >= 5) break;
      const cr = c.getBoundingClientRect();
      // Within 120px
      const dist = Math.hypot(cr.left - rect.left, cr.top - rect.top);
      if (dist < 120 || INTERACTIVE_TAGS.has(c.tagName.toLowerCase())) {
        const tag  = c.tagName.toLowerCase();
        const id   = c.id ? '#' + c.id : '';
        const cls  = c.className && typeof c.className === 'string' ? '.' + c.className.trim().split(/\s+/)[0] : '';
        const text = (c.textContent || '').trim().slice(0, 14);
        if (tag || text) found.push({ el: c, label: (tag + id + cls + (text ? ' "' + text + '"' : '')).slice(0, 28) });
      }
    }

    if (!found.length) { nearbyRow.style.display = 'none'; return; }

    nearbyRow.style.display = 'block';
    nearbyChips.innerHTML = found.map((f, i) =>
      `<div class="__g-nearby-chip" data-nearby-idx="${i}" title="${f.label}">${f.label}</div>`
    ).join('');

    // Use a single delegated listener — set via onclick attribute to avoid accumulation
    nearbyChips.querySelectorAll('.__g-nearby-chip').forEach((chip, i) => {
      chip.dataset.nearbyIdx = i;
    });
    // Replace any previous delegated handler (not addEventListener which stacks)
    nearbyChips.onclick = (ev) => {
      const chip = ev.target.closest('.__g-nearby-chip');
      if (chip) _zoomTo(found[parseInt(chip.dataset.nearbyIdx, 10)].el);
    };
  }

  // Wire zoom buttons
  document.getElementById('__g-zoom-parent').addEventListener('click', () => {
    if (_currentEl?.parentElement && _currentEl.parentElement !== document.body)
      _zoomTo(_currentEl.parentElement);
  });
  document.getElementById('__g-zoom-child').addEventListener('click', () => {
    const child = _currentEl?.firstElementChild;
    if (child) _zoomTo(child);
  });
  document.getElementById('__g-zoom-prev').addEventListener('click', () => {
    const prev = _currentEl?.previousElementSibling;
    if (prev) _zoomTo(prev);
  });
  document.getElementById('__g-zoom-next').addEventListener('click', () => {
    const next = _currentEl?.nextElementSibling;
    if (next) _zoomTo(next);
  });


  // ── Cookie capture ────────────────────────────────────────────────────────
  function captureCookies() {
    browser.runtime.sendMessage({ type: 'COOKIES_CAPTURE', cookies: document.cookie, url: window.location.href });
    showToast('🍪 cookies captured');
  }

  // ── Site modules ──────────────────────────────────────────────────────────
  const MODULES = [
    typeof InstagramModule !== 'undefined' && new InstagramModule(typeof URCK !== 'undefined' ? URCK : null),
    typeof ThreadsModule   !== 'undefined' && new ThreadsModule(typeof URCK !== 'undefined' ? URCK : null),
    typeof ChatGPTModule   !== 'undefined' && new ChatGPTModule(typeof URCK !== 'undefined' ? URCK : null),
    typeof ClaudeModule    !== 'undefined' && new ClaudeModule(typeof URCK !== 'undefined' ? URCK : null),
  ].filter(Boolean);

  for (const mod of MODULES) {
    if (mod.domains && mod.domains.some(d => HOST === d || HOST.endsWith('.' + d))) {
      mod.activate(); mod.attach();
    }
  }

  // ── Message listener ──────────────────────────────────────────────────────
  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'START_PICKER':     startPicker('callto');           break;
      case 'START_PICKER_LISTEN': startPicker('listener');      break;
      case 'STOP_PICKER':      stopPicker();                    break;
      case 'CAPTURE_COOKIES':  captureCookies();                break;
      case 'GLOBAL_KILLSWITCH': triggerKillswitch(msg.reason, false);  break;  // notify=false: background already handled broadcast

      case 'ATTACH_LISTENER': {
        const ok = attachListenerDOM(msg.listenerId, msg.selector, msg.xpath, msg.mode);
        return Promise.resolve({ ok });
      }
      case 'STOP_LISTENER': {
        detachListenerDOM(msg.listenerId);
        return Promise.resolve({ ok: true });
      }
      case 'PING': return Promise.resolve({ pong: true, url: window.location.href });
    }
  });

  // ── Tab navigation URCK event ─────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    browser.runtime.sendMessage({
      type: 'URCK_EVENT', eventType: 'guardian.tab.navigate',
      payload: { url: window.location.href }, meta: { url: window.location.href },
    }).catch(() => {});
  });

})();
