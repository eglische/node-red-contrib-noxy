const fs = require('fs');
const path = require('path');

module.exports = function (RED) {
    function VoxtaKeysNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const keyMappings = {
            modifiers: [
                { name: "L_CTRL", vk: [0xA2] },
                { name: "R_CTRL", vk: [0xA3] },
                { name: "L_ALT", vk: [0xA4] },
                { name: "R_ALT", vk: [0xA5] },
                { name: "L_SHIFT", vk: [0xA0] },
                { name: "R_SHIFT", vk: [0xA1] },
                { name: "CTRL", vk: [0x11] },
                { name: "ALT", vk: [0x12] },
                { name: "SHIFT", vk: [0x10] },
                { name: "CTRL + ALT", vk: [0x11, 0x12] },
                { name: "CTRL + SHIFT", vk: [0x11, 0x10] },
                { name: "ALT + SHIFT", vk: [0x12, 0x10] },
                { name: "CTRL + ALT + SHIFT", vk: [0x11, 0x12, 0x10] }
            ],
            mainKeys: [
                { name: "A", vk: 0x41 },
                { name: "B", vk: 0x42 },
                { name: "C", vk: 0x43 },
                { name: "Num0", vk: 0x60 },
                { name: "Num1", vk: 0x61 },
                { name: "F1", vk: 0x70 },
                { name: "F2", vk: 0x71 },
                { name: "Delete", vk: 0x2E },
                { name: "ArrowUp", vk: 0x26 },
                { name: "ArrowDown", vk: 0x28 },
                { name: "ArrowLeft", vk: 0x25 },
                { name: "ArrowRight", vk: 0x27 }
            ]
        };

        function getKeyCode(modifiers, key) {
            // Convert single vk to an array if it's not already
            const modifierCodes = modifiers
                .split(" + ")
                .map(mod => keyMappings.modifiers.find(m => m.name === mod)?.vk)
                .flat();
        
            const keyCode = keyMappings.mainKeys.find(k => k.name === key)?.vk;
        
            if (!keyCode) {
                throw new Error(`Invalid key: ${key}`);
            }
        
            if (!modifierCodes || modifierCodes.includes(undefined)) {
                throw new Error(`Invalid modifier(s): ${modifiers}`);
            }
        
            return [...modifierCodes, keyCode].map(code => `0x${code.toString(16).toUpperCase()}`);
        }
        
        
        
        

        function processPayload(payload) {
            const triggers = payload.split(/[;,]/).map(t => t.trim());
            const results = [];

            triggers.forEach(trigger => {
                const matchingRow = config.keys.find(row => row.trigger === trigger);

                if (matchingRow) {
                    try {
                        const result = getKeyCode(matchingRow.modifiers, matchingRow.key);
                        results.push(`[${result.join(', ')}]`);
                    } catch (error) {
                        node.error(`Error processing trigger "${trigger}": ${error.message}`);
                    }
                } else {
                    node.error(`No match found for trigger: ${trigger}`);
                }
            });

            return results;
        }

        this.on('input', function (msg) {
            try {
                const payload = msg.payload.toString();
                const outputs = processPayload(payload);

                outputs.forEach((output, index) => {
                    setTimeout(() => {
                        node.send({ payload: output });
                    }, index * 100); // 100ms delay between messages
                });
            } catch (error) {
                node.error(`Error processing input: ${error.message}`);
            }
        });

        this.on('close', function () {
            // Cleanup if needed
        });
    }

    RED.nodes.registerType('voxta-keys', VoxtaKeysNode);

    // Log to confirm registration
    console.log('Voxta Keys Node Registered');
};
