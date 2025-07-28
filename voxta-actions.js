module.exports = function (RED) {
    function VoxtaActionsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

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
                    Arguments: action.arguments || []
                };

                setTimeout(() => {
                    node.send({ payload: output });
                }, idx * 50);
            });
        }

        this.on('input', function (msg) {
            const input = msg.payload.toString().trim();
            const isRemove = input.endsWith('!');
            const ref = isRemove ? input.slice(0, -1) : input;

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
                        }, idx * 50);
                    });
                } else {
                    sendActions(layerActions);
                }
                return;
            }

            const action = findAction(ref);
            if (!action) {
                node.error(`[ERROR] No action found for input: ${ref}`);
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

        // Removed on('editprepare') - UI logic moved to HTML side

        this.on('close', function () {
            actions = [];
        });
    }

    RED.nodes.registerType('voxta-actions', VoxtaActionsNode);
    console.log('Voxta Actions Node Registered');
};