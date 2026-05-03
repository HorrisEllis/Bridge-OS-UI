// Copyright (c) 2024-2026 James Brooks (Erosmancer). All rights reserved.
// Bridge OS — Proprietary Software. See LICENSE for terms.
// rheon.world · github.com/HorrisEllis/Bridge-v2
const fs = require('fs');
const path = require('path');

// Ensure this points to your preferred data directory
const STORAGE_DIR = path.join(__dirname, '../../data');
const KERNEL_FILE = path.join(STORAGE_DIR, 'causal_kernel.json');

module.exports = {
    log(type, content, author = 'nexus-cli') {
        // Ensure data directory exists
        if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

        const entry = {
            id: `k-${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: type, // 'idea', 'command', 'chat'
            author: author,
            content: content
        };

        let history = [];
        if (fs.existsSync(KERNEL_FILE)) {
            try {
                history = JSON.parse(fs.readFileSync(KERNEL_FILE, 'utf8'));
            } catch (e) {
                history = [];
            }
        }

        history.push(entry);
        fs.writeFileSync(KERNEL_FILE, JSON.stringify(history, null, 2));
        return entry;
    },

    getRecent(limit = 10) {
        if (!fs.existsSync(KERNEL_FILE)) return [];
        const history = JSON.parse(fs.readFileSync(KERNEL_FILE, 'utf8'));
        return history.slice(-limit);
    }
};