// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
'use strict';
/**
 * bridge-cli/index.js
 * Command interface to the sovereign node.
 * Routes natural language and structured commands through bridge-node intent router.
 * Serves Nexus-Chat.html at GET /cli
 */

const path = require('path');
const fs   = require('fs');

const HTML_PATH = path.join(__dirname, 'Nexus-Chat.html');

function createCLIRouter({ busEmit = null, intentParser = null, intentRouter = null } = {}) {

    function route(method, urlParts, body, req, res) {
        const _json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        const _html = (html) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); };

        // GET /cli — serve the chat UI
        if (method === 'GET' && !urlParts[1]) {
            if (fs.existsSync(HTML_PATH)) {
                return _html(fs.readFileSync(HTML_PATH, 'utf8'));
            }
            return _html('<h1>bridge-cli</h1><p>Nexus-Chat.html not found. Place it at bridge-cli/Nexus-Chat.html</p>');
        }

        // POST /cli/command — execute a command string
        if (method === 'POST' && urlParts[1] === 'command') {
            const { command, sessionId } = body || {};
            if (!command) return _json(400, { ok: false, error: 'command required' });

            busEmit?.('cli:command', { command, sessionId: sessionId || null }, 'INFO');

            // If intent router is wired, route the command
            if (intentParser && intentRouter) {
                try {
                    const intent = intentParser.parse(command);
                    const result = intentRouter.route(intent);
                    return _json(200, { ok: true, intent, result });
                } catch (e) {
                    return _json(500, { ok: false, error: e.message });
                }
            }

            // Fallback: echo
            return _json(200, { ok: true, command, status: 'received', note: 'intent router not wired' });
        }

        return null;
    }

    return { route };
}

module.exports = { createCLIRouter };
