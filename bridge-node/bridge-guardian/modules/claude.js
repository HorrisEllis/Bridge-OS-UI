// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
// modules/claude.js — Guardian site module
// Targets: claude.ai

class ClaudeModule extends GuardianModule {
  constructor(urck) {
    super('claude', ['claude.ai'], urck);
    this._observer = null;
    this._lastText  = null;
  }

  attach() {
    this._observer = new MutationObserver(() => {
      // Claude uses .font-claude-message for AI responses
      const responses = document.querySelectorAll('.font-claude-message, [data-is-streaming]');
      const last = responses[responses.length - 1];
      if (!last) return;

      const text = last.innerText?.trim();
      if (text && text !== this._lastText && text.length > 10) {
        this._lastText = text;
        this.emit('guardian.chat.response', {
          text:           text.slice(0, 2000),
          role:           'assistant',
          provider:       'claude',
          conversationId: window.location.pathname.split('/').pop(),
          timestamp:      Date.now(),
        });
      }

      // Also capture user messages
      const userMsgs = document.querySelectorAll('[data-testid="user-message"]');
      const lastUser = userMsgs[userMsgs.length - 1];
      if (lastUser) {
        const userText = lastUser.innerText?.trim();
        if (userText && userText !== this._lastUserText && userText.length > 1) {
          this._lastUserText = userText;
          this.emit('guardian.chat.message', {
            text:           userText.slice(0, 2000),
            role:           'user',
            provider:       'claude',
            conversationId: window.location.pathname.split('/').pop(),
            timestamp:      Date.now(),
          });
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
