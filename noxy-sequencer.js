module.exports = function(RED) {
    function NoxySequencer(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.sequence = config.sequence;
        let stop = false;

        node.on('input', async function(msg) {
            if (typeof msg.payload === "string" && msg.payload.toLowerCase() === "stop!") {
                stop = true;
                node.status({ fill: "red", shape: "ring", text: "Stopped" });
                return; // Stop the sequence
            }

            stop = false; // Reset stop flag for new sequence
            await executeSequence(node.sequence);
        });

        async function executeSequence(sequence) {
            for (let i = 0; i < sequence.length; i++) {
                if (stop) {
                    node.status({ fill: "red", shape: "ring", text: "Stopped" });
                    return;
                }

                const element = sequence[i];
                let msg = { payload: "" };

                switch (element.type) {
                    case "output":
                        // Handling different types of output
                        if (element.outputType && element.value) {
                            switch (element.outputType) {
                                case "string":
                                    msg.payload = String(element.value);
                                    break;
                                case "number":
                                    msg.payload = parseFloat(element.value);
                                    if (isNaN(msg.payload)) {
                                        node.error(`Invalid number: ${element.value}`, msg);
                                        continue; // Skip invalid value
                                    }
                                    break;
                                case "boolean":
                                    msg.payload = (element.value.toLowerCase() === "true");
                                    break;
                                case "json":
                                    try {
                                        msg.payload = JSON.parse(element.value);
                                    } catch (e) {
                                        node.error(`Invalid JSON: ${element.value}`, msg);
                                        continue; // Skip invalid JSON
                                    }
                                    break;
                                default:
                                    node.error(`Unsupported output type: ${element.outputType}`, msg);
                                    continue;
                            }

                            // Debug logging for verification
                            console.log(`Sending payload: ${msg.payload} of type ${element.outputType}`);
                            
                            // Send the message to the specific output port
                            node.send([msg]);
                            node.status({ fill: "green", shape: "dot", text: `Executing Index ${i + 1}` });
                        }
                        break;

                    case "delay":
                        const fromDelay = parseFloat(element.from);
                        const toDelay = parseFloat(element.to);

                        if (isNaN(fromDelay) && isNaN(toDelay)) {
                            node.error(`Invalid delay values: from=${element.from}, to=${element.to}`);
                            continue;
                        }

                        let delay;
                        if (!isNaN(fromDelay) && !isNaN(toDelay)) {
                            // If both from and to are provided, randomize between them
                            delay = fromDelay === toDelay ? fromDelay : (Math.random() * (toDelay - fromDelay)) + fromDelay;
                        } else if (!isNaN(fromDelay)) {
                            // If only from is provided, use it as a fixed delay
                            delay = fromDelay;
                        } else {
                            node.error(`Invalid delay configuration: from=${element.from}, to=${element.to}`);
                            continue;
                        }

                        let delayMs;
                        switch (element.unit) {
                            case "ms":
                                delayMs = delay;
                                break;
                            case "seconds":
                                delayMs = delay * 1000;
                                break;
                            case "minutes":
                                delayMs = delay * 60 * 1000;
                                break;
                            default:
                                node.error(`Unsupported delay unit: ${element.unit}`);
                                continue;
                        }

                        delayMs = Math.floor(delayMs); // Convert to an integer number of milliseconds

                        node.status({ fill: "blue", shape: "ring", text: `Wait for ${delayMs} ms` });
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        break;

                    default:
                        node.error(`Unknown element type: ${element.type}`);
                        continue;
                }
            }

            node.status({ fill: "grey", shape: "dot", text: "Sequence completed" });
        }

        // Load saved configuration when the UI is opened
        node.on('close', function() {
            node.status({});
        });
    }

    RED.nodes.registerType("noxy-sequencer", NoxySequencer);
};
