// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// modules/instagram.js — Guardian site module
// Targets: instagram.com — DMs, posts

class InstagramModule extends GuardianModule {
  constructor(urck) {
    super('instagram', ['instagram.com', 'www.instagram.com'], urck);
    this._dmObserver = null;
  }

  attach() {
    this._dmObserver = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          // DM message detection
          const msgs = node.querySelectorAll?.('[class*="message"]') || [];
          for (const msg of msgs) {
            const text = msg.innerText?.trim();
            if (!text || text.length < 2) continue;

            const isOwn = msg.querySelector('[class*="outgoing"]') !== null;
            this.emit('guardian.ig.dm', {
              text,
              direction: isOwn ? 'sent' : 'received',
              timestamp: Date.now(),
              url:       window.location.href,
              threadId:  this._getThreadId(),
            });
          }

          // Post detection — feed articles
          const posts = node.querySelectorAll?.('article[role="presentation"]') || [];
          for (const post of posts) {
            const caption  = post.querySelector('span[class]')?.innerText?.trim();
            const username = post.querySelector('a[href*="/"]')?.innerText?.trim();
            if (caption || username) {
              this.emit('guardian.ig.post', {
                caption:  caption?.slice(0, 500),
                username,
                timestamp: Date.now(),
                url:       window.location.href,
              });
            }
          }
        }
      }
    });

    this._dmObserver.observe(document.body, { childList: true, subtree: true });
  }

  _getThreadId() {
    const match = window.location.pathname.match(/\/direct\/t\/(\d+)/);
    return match ? match[1] : null;
  }

  detach() {
    this._dmObserver?.disconnect();
    this._dmObserver = null;
  }
}
