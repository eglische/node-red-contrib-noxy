module.exports = function (RED) {
    function VoxtaMessagesNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Retrieve messages from the config
        let messages = config.messages || [];
        let currentIndex = 0; // Track current index for "next" and "previous" commands

        function findMessage(ref) {
            const refInt = parseInt(ref, 10);
            return messages.find(m => m.index === ref || m.shortRef === ref || m.index === refInt);
        }

        function formatOutput(message) {
            const output = [];

            function addMessage(msg) {
                const prefix = msg.flag ? `/${msg.flag}` : '';
                output.push(`${prefix} ${msg.content}`);
                if (msg.additionalMessages) {
                    msg.additionalMessages.forEach(additionalRef => {
                        const additional = findMessage(additionalRef);
                        if (additional) addMessage(additional);
                    });
                }
            }

            addMessage(message);
            return output;
        }

        // Handle incoming messages
        this.on('input', function (msg) {
            const input = msg.payload.toString().trim().toLowerCase();
            let message;

            if (input === 'random') {
                const randomIndex = Math.floor(Math.random() * messages.length);
                message = messages[randomIndex];
            } else if (input === 'next') {
                if (currentIndex < messages.length) {
                    message = messages[currentIndex];
                    currentIndex = Math.min(currentIndex + 1, messages.length - 1);
                }
            } else if (input === 'previous') {
                if (currentIndex > 0) {
                    message = messages[currentIndex];
                    currentIndex = Math.max(currentIndex - 1, 0);
                }
            } else {
                message = findMessage(input);
            }

            if (message) {
                const output = formatOutput(message);
                output.forEach((line, index) => {
                    setTimeout(() => node.send({ payload: line }), index * 50);
                });
            } else {
                console.error(`[ERROR] No message found for input: ${input}`);
            }
        });

        // Listen for updates from the editor
        this.on('update', function (updatedConfig) {
            if (updatedConfig.messages) {
                messages = updatedConfig.messages;
                console.log('Node messages updated dynamically.');
            }
        });

        this.on('close', function () {
            messages = []; // Clear messages on close
        });
    }

    RED.nodes.registerType('voxta-messages', VoxtaMessagesNode);
};
