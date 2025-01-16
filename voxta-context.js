module.exports = function (RED) {
    function VoxtaContextNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.contexts = config.contexts || [];

        node.on('input', function (msg) {
            if (typeof msg.payload !== 'string') {
                return;
            }
            
            let incomingText = msg.payload.trim();
            let disableContext = incomingText.endsWith("!");
            if (disableContext) {
                incomingText = incomingText.slice(0, -1);
            }
            
            let matchingContext = node.contexts.find(ctx => ctx.Name === incomingText);
            if (matchingContext) {
                msg.payload = {
                    ContextKey: matchingContext.Name,
                    Contexts: [{
                        Name: matchingContext.Name,
                        Text: matchingContext.Text,
                        Disabled: disableContext
                    }]
                };
                if (matchingContext.SetFlags && matchingContext.SetFlags.length > 0) {
                    msg.payload.SetFlags = matchingContext.SetFlags;
                }
                node.send(msg);
            }
        });

        node.on('close', function () {
            node.contexts = [];
        });

        node.on('editprepare', function () {
            let dropdown = $("#node-input-contextKey");
            dropdown.empty();
            node.contexts.forEach((context, index) => {
                dropdown.append(new Option(context.Name, index));
            });
            
            dropdown.on("change", function () {
                let selectedIndex = dropdown.prop("selectedIndex");
                if (selectedIndex >= 0) {
                    $("#node-input-contextName").val(node.contexts[selectedIndex].Name);
                    $("#node-input-contextText").val(node.contexts[selectedIndex].Text);
                    $("#node-input-enabled").prop("checked", !node.contexts[selectedIndex].Disabled);
                    $("#node-input-setFlags").val(node.contexts[selectedIndex].SetFlags ? node.contexts[selectedIndex].SetFlags.join(', ') : "");
                }
            });
            
            $("#node-input-contextName").on("input", function () {
                let selectedIndex = dropdown.prop("selectedIndex");
                if (selectedIndex >= 0) {
                    node.contexts[selectedIndex].Name = $(this).val();
                }
            });
            
            $("#node-input-contextText").on("input", function () {
                let selectedIndex = dropdown.prop("selectedIndex");
                if (selectedIndex >= 0) {
                    node.contexts[selectedIndex].Text = $(this).val();
                }
            });
            
            $("#node-input-enabled").on("change", function () {
                let selectedIndex = dropdown.prop("selectedIndex");
                if (selectedIndex >= 0) {
                    node.contexts[selectedIndex].Disabled = !$(this).prop("checked");
                }
            });
            
            $("#node-input-setFlags").on("input", function () {
                let selectedIndex = dropdown.prop("selectedIndex");
                if (selectedIndex >= 0) {
                    node.contexts[selectedIndex].SetFlags = $(this).val().split(',').map(f => f.trim()).filter(f => f);
                }
            });
        });

        node.on('editsave', function () {
            let updatedContexts = [];
            $("#node-input-contextKey option").each(function (index) {
                updatedContexts.push(node.contexts[index]);
            });
            node.contexts = updatedContexts;
            node.context().contexts = updatedContexts;
            node.dirty = true;
            node.changed();
        });
    }

    RED.nodes.registerType("voxta-context", VoxtaContextNode, {
        category: "Voxta",
        defaults: {
            name: { value: "" },
            contexts: { value: [] }
        }
    });
};
