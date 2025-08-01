const fs = require('fs');

module.exports = function (RED) {
    function VoxtaActionsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve actions directly from config
        let actions = config.actions || [];

        function findAction(ref) {
            const refInt = parseInt(ref, 10);
            return actions.find(a => a.name === ref || a.index === ref || a.index === refInt);
        }

        function findActionsByLayer(layer) {
            return actions.filter(a => a.layer === layer);
        }

        function sendActions(actionsToSend) {
            actionsToSend.forEach((action, idx) => {
                const output = {
                    Action: "add",
                    Name: action.name,
                    Description: action.description,
                    Layer: action.layer || "default",
                    Timing: action.timing || "AfterAssistantMessage",
                    SetFlags: action.setFlags || [],
                    Secret: action.secret || "",
                    Note: action.note || "",
                    CancelReply: !!action.cancelReply,
                };
                
                if (Array.isArray(action.arguments)) {
                    const validArgs = action.arguments.filter(arg => arg.name && arg.name.trim());
                    if (validArgs.length > 0) {
                        output.Arguments = validArgs.map(arg => ({
                            name: arg.name.trim(),
                            type: "String",
                            required: true,
                            description: arg.description?.trim() || ""
                        }));
                    }
                }

                setTimeout(() => {
                    node.send({ payload: output });
                }, idx * 50); // 50ms delay between messages
            });
        }

        this.on('input', function (msg) {
            const input = msg.payload.toString().trim();
            const isRemove = input.endsWith('!');
            const ref = isRemove ? input.slice(0, -1) : input;

            // Handle layer-wide actions
            if (findActionsByLayer(ref).length > 0) {
                const layerActions = findActionsByLayer(ref);
                if (isRemove) {
                    layerActions.forEach((action, idx) => {
                        const output = {
                            Action: "remove",
                            Name: action.name,
                        };
                        setTimeout(() => {
                            node.send({ payload: output });
                        }, idx * 50); // 50ms delay between removals
                    });
                } else {
                    sendActions(layerActions);
                }
                return;
            }

            // Handle individual action
            const action = findAction(ref);
            if (!action) {
                console.error(`[ERROR] No action found for input: ${ref}`);
                return;
            }

            if (isRemove) {
                const output = {
                    Action: "remove",
                    Name: action.name,
                };
                node.send({ payload: output });
            } else {
                sendActions([action]);
            }
        });

        this.on('editprepare', function () {
            // Update node name dynamically based on selected dropdown
            const dropdown = document.getElementById('node-input-actionDropdown');
            dropdown.addEventListener('change', () => {
                const selectedIndex = dropdown.selectedIndex;
                if (actions[selectedIndex]) {
                    const selectedAction = actions[selectedIndex];
                    document.getElementById('node-input-name').value = selectedAction.name || '';
                }
            });
        });

        this.on('close', function () {
            actions = [];
        });
    }

    RED.nodes.registerType('voxta-actions', VoxtaActionsNode);

    // Log to confirm registration
    console.log('Noxy Actions Registered V1.0.4');
};
