// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// modules/base-module.js — shared Guardian module interface

class GuardianModule {
  constructor(name, domains, urck) {
    this.name    = name;
    this.domains = domains; // array of hostnames
    this.urck    = urck;
    this.active  = false;
  }

  activate()   { this.active = true;  }
  deactivate() { this.active = false; }

  emit(type, payload, meta = {}) {
    if (!this.active) return;
    // In content script context: relay to background via runtime message
    // (background has the authoritative URCK kernel)
    browser.runtime.sendMessage({
      type:      'URCK_EVENT',
      eventType: type,
      payload,
      meta: {
        ...meta,
        source: this.name,
        url:    window.location.href,
      },
    }).catch(() => {});
  }

  // Override in subclass
  attach()  {}
  detach()  {}
}
