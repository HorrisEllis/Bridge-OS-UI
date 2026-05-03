// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
/**
 * BRIDGE OS — MODULE/OLLAMA
 * Local Neural Engine Driver (v4.0)
 */

'use strict';
const http = require('http');

const Ollama = {
    model: 'deepseek-r1:8b',
    endpoint: 'http://localhost:11434/api/generate',

    start(bus) {
        // Main prompt listener
        bus.on('ollama:ask', async (data, streamCallback) => {
            const payload = JSON.stringify({
                model: this.model,
                system: data.system || "You are a Bridge OS Node Assistant.",
                prompt: data.prompt,
                stream: true
            });

            const req = http.request(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                res.on('data', (chunk) => {
                    try {
                        const json = JSON.parse(chunk.toString());
                        if (json.response) {
                            streamCallback(json.response);
                        }
                        if (json.done) {
                            process.stdout.write('\n'); // Close the stream line
                            bus.emit('cli:prompt_refresh'); 
                        }
                    } catch (e) {
                        // Handle potential partial JSON chunks in stream
                    }
                });
            });

            req.on('error', (e) => {
                streamCallback(`\x1b[31m[ENGINE_OFFLINE]\x1b[0m Ensure Ollama is running: ${e.message}`);
            });

            req.write(payload);
            req.end();
        });
    }
};

module.exports = Ollama;