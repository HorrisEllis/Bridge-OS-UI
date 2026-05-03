// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// modules/threads.js — Guardian site module
// Targets: threads.net — posts and replies

class ThreadsModule extends GuardianModule {
  constructor(urck) {
    super('threads', ['threads.net', 'www.threads.net'], urck);
    this._observer = null;
  }

  attach() {
    this._observer = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          const posts = node.querySelectorAll?.('article, [data-pressable-container]') || [];
          for (const post of posts) {
            const text     = post.querySelector('span[dir="auto"]')?.innerText?.trim();
            const username = post.querySelector('a[href*="@"]')?.innerText?.trim();
            if (!text && !username) continue;

            this.emit('guardian.threads.post', {
              text:      text?.slice(0, 1000),
              username,
              timestamp: Date.now(),
              url:       window.location.href,
              isReply:   window.location.pathname.includes('/post/'),
            });
          }
        }
      }
    });

    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  detach() {
    this._observer?.disconnect();
    this._observer = null;
  }
}
