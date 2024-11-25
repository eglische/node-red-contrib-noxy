module.exports = function(RED) {
    function NoxySequencerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.sequence = config.sequence || [];
        node.outputs = 1;  // Use a single output port
        let isStopped = false;  // State to determine if the sequence should stop
        let currentSequence = null; // Store current sequence for cancellation

        // Helper function to get a random delay between `from` and `to`
        function getRandomDelay(from, to) {
            return Math.floor(Math.random() * (to - from + 1)) + from;
        }

        // Function to handle execution of the sequence
        async function executeSequence(msg, send, done) {
            isStopped = false;  // Reset the stop state at the start of the sequence
            node.status({ fill: "green", shape: "dot", text: "running" });  // Indicate running status

            try {
                for (let i = 0; i < node.sequence.length; i++) {
                    if (isStopped) {
                        node.status({ fill: "red", shape: "ring", text: "stopped" });  // Indicate stopped status
                        return; // Exit the sequence immediately without completing
                    }

                    const entry = node.sequence[i];

                    if (entry.type === 'output') {
                        // Create a copy of the message with the new payload value
                        const outputMsg = { ...msg, payload: entry.value };
                        send(outputMsg);
                    } else if (entry.type === 'delay') {
                        let delayTime;

                        // Determine if the delay is fixed or random
                        if (entry.from && entry.to && entry.from !== entry.to) {
                            // Random delay between `from` and `to`
                            if (entry.unit === 'ms') {
                                delayTime = getRandomDelay(Number(entry.from), Number(entry.to));
                            } else if (entry.unit === 'seconds') {
                                delayTime = getRandomDelay(Number(entry.from) * 1000, Number(entry.to) * 1000);
                            } else if (entry.unit === 'minutes') {
                                delayTime = getRandomDelay(Number(entry.from) * 60000, Number(entry.to) * 60000);
                            }
                        } else {
                            // Fixed delay, either `from` is used, or `to` if `from` is not provided
                            const fixedValue = entry.from || entry.to;
                            if (entry.unit === 'ms') {
                                delayTime = Number(fixedValue);
                            } else if (entry.unit === 'seconds') {
                                delayTime = Number(fixedValue) * 1000;
                            } else if (entry.unit === 'minutes') {
                                delayTime = Number(fixedValue) * 60000;
                            }
                        }

                        // Await delay using the calculated delay time
                        if (delayTime && delayTime > 0) {
                            await new Promise((resolve, reject) => {
                                currentSequence = setTimeout(() => {
                                    if (isStopped) {
                                        reject("Sequence stopped");
                                    } else {
                                        resolve();
                                    }
                                }, delayTime);
                            });
                        }
                    }
                }
                // Signal completion of the sequence
                node.status({ fill: "blue", shape: "dot", text: "finished" });  // Indicate finished status
                done();
            } catch (error) {
                if (error === "Sequence stopped") {
                    done();
                } else {
                    node.status({ fill: "red", shape: "ring", text: "error" });
                    done(error);
                }
            }
        }

        // Handle input messages
        node.on('input', function(msg, send, done) {
            // Ensure send and done exist (for Node-RED 1.0 compatibility)
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            if (typeof msg.payload === 'string' && msg.payload === 'stop!') {
                // Handle stop message
                isStopped = true;
                if (currentSequence) {
                    clearTimeout(currentSequence); // Cancel any ongoing delay
                    currentSequence = null;
                }
                node.status({ fill: "red", shape: "ring", text: "stopped by user" });
                done();
            } else {
                // Execute the sequence, and handle any errors properly
                executeSequence(msg, send, done).catch(err => {
                    node.status({ fill: "red", shape: "ring", text: "error" });
                    done(err);
                });
            }
        });
    }

    // Register the node with Node-RED
    RED.nodes.registerType("noxy-sequencer", NoxySequencerNode);
};
