// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
const http = require('http');

/**
 * NEXUS OLLAMA BRIDGE
 * Context-aware LLM interface for the Sovereign Node
 */
module.exports = {
    async query(prompt, model = 'deepseek-coder-v2:16b-lite-instruct-q4_K_M') {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                model: model,
                prompt: prompt,
                stream: false
            });

            const options = {
                hostname: '127.0.0.1',
                port: 11434,
                path: '/api/generate',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = http.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(new Error("Failed to parse Ollama response"));
                    }
                });
            });

            req.on('error', (e) => reject(e));
            req.write(data);
            req.end();
        });
    }
};