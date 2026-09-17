const sessionState = require('./lib-session-state');

module.exports = function (RED) {
    function VoxtaLinkNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.targets = config.targets || []; // array of {id, name, type}
        node.name = config.name || '';

        // Build a set of target node IDs for quick lookup
        const targetIds = new Set(node.targets.map(function (t) { return t.id; }));

        node.on('input', function (msg, send, done) {
            // Forward to output (passthrough)
            send(msg);

            // Relay to each selected target via RED.events
            targetIds.forEach(function (targetId) {
                const event = "node:" + targetId;
                try {
                    // Clone the message for each target so they don't share references
                    const cloned = RED.util.cloneMessage(msg);
                    RED.events.emit(event, cloned);
                } catch (e) {
                    node.error("Failed to relay to " + targetId + ": " + e.message);
                }
            });

            if (done) done();
        });

        node.on('close', function () {
            node.status({});
        });

        // Update status to show how many targets are linked
        if (targetIds.size > 0) {
            node.status({ fill: 'blue', shape: 'dot', text: targetIds.size + ' target(s)' });
        } else {
            node.status({ fill: 'grey', shape: 'ring', text: 'no targets' });
        }
    }

    RED.nodes.registerType('link', VoxtaLinkNode);

    // Proxy: returns all Voxta nodes with linkTarget enabled
    RED.httpAdmin.get('/link/targets', function (req, res) {
        const targets = [];
        RED.nodes.eachNode(function (n) {
            if (n.linkTarget === true || n.linkTarget === 'true') {
                targets.push({
                    id: n.id,
                    name: n.name || n.type,
                    type: n.type
                });
            }
        });
        res.json({ targets: targets });
    });
};