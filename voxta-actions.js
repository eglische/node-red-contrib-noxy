const sessionState = require('./lib-session-state');

// Global merged action registry across all voxta-actions nodes.
// Each node stores its own actions under its own key. When pushing to Voxta,
// we merge all entries so multiple nodes don't overwrite each other.
const ALL_ACTIONS_KEY = 'voxtaActionsAll';

function getNodeActions(RED, nodeId, sessionId) {
    const nodeKey = 'voxtaActions_' + nodeId;
    const registry = RED.nodes.getNode(nodeId)?.context()?.get(nodeKey) || {};
    return registry[sessionId] || {};
}

function setNodeActions(RED, nodeId, sessionId, actions) {
    const node = RED.nodes.getNode(nodeId);
    if (!node) { return; }
    const nodeKey = 'voxtaActions_' + nodeId;
    const registry = node.context().get(nodeKey) || {};
    registry[sessionId] = actions;
    node.context().set(nodeKey, registry);
}

function deleteNodeActions(RED, nodeId, sessionId) {
    const node = RED.nodes.getNode(nodeId);
    if (!node) { return; }
    const nodeKey = 'voxtaActions_' + nodeId;
    const registry = node.context().get(nodeKey) || {};
    delete registry[sessionId];
    node.context().set(nodeKey, registry);
}

function getAllNodeIds(RED) {
    const ids = [];
    RED.nodes.eachNode((n) => {
        if (n.type === 'actions') {
            ids.push(n.id);
        }
    });
    return ids;
}

function buildMergedSessionState(RED, sessionId) {
    const merged = {};
    for (const nodeId of getAllNodeIds(RED)) {
        const nodeActions = getNodeActions(RED, nodeId, sessionId);
        Object.assign(merged, nodeActions);
    }
    return merged;
}

module.exports = function (RED) {
    function toBoolean(value) {
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    function toOptionalNumber(value) {
        if (value === '' || value === null || value === undefined) {
            return null;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeArguments(argumentsValue) {
        if (!Array.isArray(argumentsValue)) {
            return [];
        }

        return argumentsValue
            .map((argument) => ({
                name: String(argument?.name || '').trim(),
                type: String(argument?.type || 'String').trim() || 'String',
                description: String(argument?.description || '').trim(),
                required: argument?.required !== false
            }))
            .filter((argument) => argument.name);
    }

    function normalizeAction(action) {
        const name = String(action?.name || action?.Name || '').trim();
        if (!name) {
            return null;
        }

        const setFlags = Array.isArray(action?.setFlags)
            ? action.setFlags
            : String(action?.setFlags || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);
        return {
            type: 'action',
            name,
            description: String(action?.description || action?.Description || '').trim(),
            layer: String(action?.layer || action?.Layer || 'default').trim() || 'default',
            timing: String(action?.timing || action?.Timing || 'AfterAssistantMessage').trim() || 'AfterAssistantMessage',
            secret: String(action?.secret || action?.Secret || '').trim(),
            note: String(action?.note || action?.Note || '').trim(),
            cancelReply: action?.cancelReply === true || action?.CancelReply === true,
            setFlags,
            arguments: normalizeArguments(action?.arguments || action?.Arguments),
            onceOnly: toBoolean(action?.onceOnly ?? action?.OnceOnly),
            groupOnce: toBoolean(action?.groupOnce ?? action?.GroupOnce),
            layerOnce: toBoolean(action?.layerOnce ?? action?.LayerOnce),
            cooldownEnabled: toBoolean(action?.cooldownEnabled ?? action?.CooldownEnabled),
            cooldownFrom: toOptionalNumber(action?.cooldownFrom ?? action?.CooldownFrom),
            cooldownTo: toOptionalNumber(action?.cooldownTo ?? action?.CooldownTo),
            uiCollapsed: toBoolean(action?.uiCollapsed ?? action?.UiCollapsed),
            uiSettingsCollapsed: toBoolean(action?.uiSettingsCollapsed ?? action?.UiSettingsCollapsed),
            executionMode: String(action?.executionMode || 'output').trim() || 'output',
            autoInject: toBoolean(action?.autoInject ?? action?.AutoInject),
            characters: String(action?.characters || action?.Characters || '').trim(),
            autoCallEnabled: toBoolean(action?.autoCallEnabled ?? action?.AutoCallEnabled),
            autoCallType: String(action?.autoCallType || action?.AutoCallType || 'action').trim() || 'action',
            autoCallTarget: String(action?.autoCallTarget || action?.AutoCallTarget || '').trim(),
            autoCallDelayFrom: toOptionalNumber(action?.autoCallDelayFrom ?? action?.AutoCallDelayFrom),
            autoCallDelayTo: toOptionalNumber(action?.autoCallDelayTo ?? action?.AutoCallDelayTo),
            dashboardWidget: action?.dashboardWidget ? {
                id: String(action.dashboardWidget.id || '').trim(),
                type: String(action.dashboardWidget.type || '').trim(),
                label: String(action.dashboardWidget.label || '').trim(),
                tabName: String(action.dashboardWidget.tabName || '').trim(),
                groupName: String(action.dashboardWidget.groupName || '').trim(),
                onValue: String(action.dashboardWidget.onValue || '').trim() || undefined,
                offValue: String(action.dashboardWidget.offValue || '').trim() || undefined
            } : null
        };
    }

    function normalizeGroup(group) {
        const name = String(group?.name || group?.groupName || '').trim();
        if (!name) {
            return null;
        }

        return {
            type: 'group',
            id: String(group?.id || group?.groupId || '').trim() || `group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            name,
            uiCollapsed: toBoolean(group?.uiCollapsed ?? group?.UiCollapsed),
            items: normalizeEntries(group?.items || group?.actions || [])
        };
    }

    function normalizeEntries(entries) {
        if (!Array.isArray(entries)) {
            return [];
        }

        return entries
            .map((entry) => {
                if (entry?.type === 'group' || Array.isArray(entry?.items)) {
                    return normalizeGroup(entry);
                }
                return normalizeAction(entry);
            })
            .filter(Boolean);
    }

    function flattenEntries(entries, groupStack = [], actionList = [], groupIndex = new Map()) {
        for (const entry of entries) {
            if (entry.type === 'group') {
                const nextGroups = [...groupStack, { id: entry.id, name: entry.name }];
                flattenEntries(entry.items || [], nextGroups, actionList, groupIndex);
                continue;
            }

            const action = {
                ...entry,
                groups: [...groupStack]
            };
            actionList.push(action);

            for (const group of groupStack) {
                const existing = groupIndex.get(group.name) || [];
                existing.push(action);
                groupIndex.set(group.name, existing);
            }
        }

        return { actionList, groupIndex };
    }

    function toScenarioAction(action) {
        return {
            name: action.name,
            description: action.description,
            layer: action.layer,
            finalLayer: false,
            timing: action.timing,
            disabled: false,
            cancelReply: !!action.cancelReply,
            arguments: action.arguments,
            effect: {
                secret: action.secret,
                note: action.note,
                setFlags: action.setFlags
            }
        };
    }

    function parseTrigger(rawValue, fallbackMode) {
        const text = String(rawValue || '').trim();
        if (!text) {
            return { mode: fallbackMode || 'add', ref: '' };
        }

        if (text.startsWith('!')) {
            return { mode: 'remove', ref: text.slice(1).trim() };
        }

        if (text.endsWith('!')) {
            return { mode: 'remove', ref: text.slice(0, -1).trim() };
        }

        return { mode: fallbackMode || 'add', ref: text };
    }

    function getTriggeredActionName(payload) {
        return String(
            payload?.value ||
            payload?.name ||
            payload?.action ||
            payload?.Name ||
            ''
        ).trim();
    }

    function VoxtaActionsNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // === Link call target support ===
        var _linkEvent = null;
        var _linkHandler = null;
        (function setupLinkTargetSupport() {
            if (config.linkTarget) {
                _linkEvent = "node:" + node.id;
                _linkHandler = function(msg) {
                    msg._event = _linkEvent;
                    node.receive(msg);
                };
                RED.events.on(_linkEvent, _linkHandler);
            }
        })();
        node.client = config.client || config.connection;
        node.sessionId = config.sessionId || '';
        node.charId = config.charId || '';
        node.defaultMode = config.defaultMode || 'add';
        node.actionEntries = normalizeEntries(config.actions);
        const flattened = flattenEntries(node.actionEntries);
        node.actions = flattened.actionList;
        node.groupIndex = flattened.groupIndex;
        node.connectionConfig = null;

        // Dashboard integration: acquire node-red-dashboard for internal widget triggering
        let uiDashboard = null;
        try {
            const dashboardPath = require('path').join(RED.settings.userDir, 'node_modules', 'node-red-dashboard', 'ui');
            uiDashboard = require(dashboardPath)(RED);
        } catch (e) {
            // Dashboard not available — internal trigger silently disabled
        }

        const restoreTimers = {};
        const sessionCharacterMatch = {}; // sessionId -> bool: cached charId gate result

        const resolveConnectionConfig = () => {
            node.connectionConfig = RED.nodes.getNode(node.client);
            if (!node.connectionConfig) {
                node.status({ fill: 'red', shape: 'ring', text: 'missing signalr client' });
                return null;
            }
            return node.connectionConfig;
        };

        const updateStatus = (text, fill = 'green', shape = 'dot') => {
            node.status({ fill, shape, text });
        };

        // Per-node session action store
        const getNodeSessionActions = (sessionId) => {
            const registry = node.context().get('voxtaActions_' + node.id) || {};
            return registry[sessionId] || {};
        };
        const setNodeSessionActions = (sessionId, actions) => {
            const registry = node.context().get('voxtaActions_' + node.id) || {};
            registry[sessionId] = actions;
            node.context().set('voxtaActions_' + node.id, registry);
        };
        const deleteNodeSessionActions = (sessionId) => {
            const registry = node.context().get('voxtaActions_' + node.id) || {};
            delete registry[sessionId];
            node.context().set('voxtaActions_' + node.id, registry);
        };

        // Read this node's own actions
        const getSessionState = (sessionId) => getNodeSessionActions(sessionId);

        // Save this node's own actions (does NOT overwrite other nodes)
        const saveSessionState = (sessionId, actionsByName) => {
            setNodeSessionActions(sessionId, actionsByName);
        };

        const clearSessionState = (sessionId) => {
            deleteNodeSessionActions(sessionId);
        };

        // Build the full merged list of actions from ALL voxta-actions nodes for a session
        const buildMergedSessionState = (sessionId) => {
            const merged = {};
            RED.nodes.eachNode((n) => {
                if (n.type === 'actions') {
                    const nodeRegistry = RED.nodes.getNode(n.id)?.context()?.get('voxtaActions_' + n.id) || {};
                    if (nodeRegistry[sessionId]) {
                        Object.assign(merged, nodeRegistry[sessionId]);
                    }
                }
            });
            return merged;
        };

        const pushActions = async (connectionConfig, sessionId, sessionActions) => {
            const payload = {
                $type: 'updateContext',
                sessionId,
                contextKey: 'Actions',
                actions: Object.values(sessionActions)
            };
            await connectionConfig.connection.invoke('SendMessage', payload);
            return payload;
        };

        const clearRestoreTimer = (sessionId, key) => {
            if (restoreTimers[sessionId]?.[key]) {
                clearTimeout(restoreTimers[sessionId][key]);
                delete restoreTimers[sessionId][key];
            }
            if (restoreTimers[sessionId] && Object.keys(restoreTimers[sessionId]).length === 0) {
                delete restoreTimers[sessionId];
            }
        };

        const clearTimersForMatches = (sessionId, matches) => {
            for (const action of matches) {
                clearRestoreTimer(sessionId, `action:${action.name}`);
                for (const group of action.groups || []) {
                    clearRestoreTimer(sessionId, `group:${group.name}`);
                }
                clearRestoreTimer(sessionId, `layer:${action.layer}`);
            }
        };

        const findByReference = (reference) => {
            const ref = String(reference || '').trim();
            if (!ref) {
                return [];
            }

            const explicitGroup = ref.startsWith('group:') ? ref.slice(6).trim() : null;
            if (!explicitGroup) {
                const byName = node.actions.find((action) => action.name === ref);
                if (byName) {
                    return [byName];
                }
            }

            const byGroup = node.groupIndex.get(explicitGroup || ref);
            if (byGroup?.length) {
                return byGroup;
            }

            const byLayer = node.actions.filter((action) => action.layer === ref);
            if (byLayer.length > 0) {
                return byLayer;
            }

            return [];
        };

        const scheduleRestore = (sessionId, match, mode, groupName) => {
            if (!match.cooldownEnabled) {
                return;
            }

            const fromSeconds = match.cooldownFrom ?? match.cooldownTo;
            const toSeconds = match.cooldownTo ?? match.cooldownFrom;
            if (!Number.isFinite(fromSeconds) || fromSeconds < 0) {
                return;
            }

            const minimum = Math.min(fromSeconds, toSeconds ?? fromSeconds);
            const maximum = Math.max(fromSeconds, toSeconds ?? fromSeconds);
            const delaySeconds = minimum === maximum
                ? minimum
                : minimum + Math.random() * (maximum - minimum);
            const timerKey = mode === 'group'
                ? `group:${groupName}`
                : mode === 'layer'
                    ? `layer:${match.layer}`
                    : `action:${match.name}`;

            clearRestoreTimer(sessionId, timerKey);
            if (!restoreTimers[sessionId]) {
                restoreTimers[sessionId] = {};
            }

            restoreTimers[sessionId][timerKey] = setTimeout(async () => {
                try {
                    const connectionConfig = resolveConnectionConfig();
                    if (!connectionConfig?.connection) {
                        return;
                    }

                    const sessionActions = { ...getSessionState(sessionId) };
                    const actionsToRestore = mode === 'group'
                        ? (node.groupIndex.get(groupName) || [])
                        : mode === 'layer'
                            ? node.actions.filter((action) => action.layer === match.layer)
                            : [match];

                    for (const action of actionsToRestore) {
                        sessionActions[action.name] = toScenarioAction(action);
                    }

                    saveSessionState(sessionId, sessionActions);
                    const mergedRestore = buildMergedSessionState(sessionId);
                    await pushActions(connectionConfig, sessionId, mergedRestore);
                    updateStatus(`restored ${mode === 'group' ? groupName : mode === 'layer' ? match.layer : match.name}`);
                } catch (error) {
                    node.warn(`Failed to restore action state: ${error.message}`);
                } finally {
                    clearRestoreTimer(sessionId, timerKey);
                }
            }, Math.round(delaySeconds * 1000));
        };

        const triggerDashboardWidget = (action, payload) => {
            if (!uiDashboard || !action.dashboardWidget) {
                return;
            }
            const widget = action.dashboardWidget;
            let value;
            if (widget.type === 'ui_button') {
                value = true;
            } else if (widget.type === 'ui_switch') {
                const raw = String(payload?.value || '').toLowerCase().trim();
                const isOn = !(raw === 'off' || raw === 'false' || raw === '0');
                value = isOn ? (widget.onValue !== undefined ? widget.onValue : true) : (widget.offValue !== undefined ? widget.offValue : false);
            } else if (widget.type === 'ui_slider') {
                // payload.value holds the ACTION NAME, not the numeric slider value.
                // The actual value comes from payload.arguments[].value (a string).
                // Fall back through: argument value → payload.value → 0
                // Coerce strings to numbers so "150" becomes 150, not NaN.
                if (Array.isArray(payload?.arguments) && payload.arguments.length > 0) {
                    const arg = payload.arguments[0];
                    const raw = arg?.value ?? arg?.Value;
                    value = Number(raw);
                    if (!Number.isFinite(value)) {
                        value = 0;
                    }
                } else {
                    value = Number(payload?.value) || 0;
                }
            } else {
                value = true;
            }
            try {
                uiDashboard.ev.emit('update-value', {
                    id: widget.id,
                    value: value,
                    socketid: 'voxta-internal'
                });
            } catch (error) {
                node.warn('Widget trigger failed for ' + widget.id + ': ' + error.message);
            }
        };

        const resolveAutoCallTargets = (target, targetType) => {
            const targetStr = String(target || '').trim();
            if (!targetStr) { return []; }

            // Support comma-separated multiple targets
            const targetList = targetStr.split(',').map((t) => t.trim()).filter(Boolean);
            if (!targetList.length) { return []; }

            // Collect matching actions from ALL enabled action nodes
            const matches = [];
            const seen = new Set(); // deduplicate by action name

            RED.nodes.eachNode((n) => {
                if (n.type !== 'actions') { return; }
                // Skip disabled nodes (d === true)
                if (n.d === true) { return; }
                // Skip nodes in disabled flows (tab has disabled=true)
                if (n.z) {
                    const flowNode = RED.nodes.getNode(n.z);
                    if (flowNode && flowNode.disabled === true) { return; }
                }

                const otherNode = RED.nodes.getNode(n.id);
                if (!otherNode || !otherNode.actions) { return; }

                for (const targetItem of targetList) {
                    if (targetType === 'action') {
                        const found = otherNode.actions.find((a) => a.name === targetItem);
                        if (found && !seen.has(found.name)) {
                            seen.add(found.name);
                            matches.push({ action: found, nodeId: n.id });
                        }
                    } else if (targetType === 'group') {
                        const groupActions = otherNode.groupIndex?.get(targetItem);
                        if (groupActions?.length) {
                            for (const a of groupActions) {
                                if (!seen.has(a.name)) {
                                    seen.add(a.name);
                                    matches.push({ action: a, nodeId: n.id });
                                }
                            }
                        }
                    } else if (targetType === 'layer') {
                        const layerActions = otherNode.actions.filter((a) => a.layer === targetItem);
                        for (const a of layerActions) {
                            if (!seen.has(a.name)) {
                                seen.add(a.name);
                                matches.push({ action: a, nodeId: n.id });
                            }
                        }
                    }
                }
            });
            return matches;
        };

        const executeAutoCall = async (sessionId, match) => {
            if (!match.autoCallEnabled || !match.autoCallTarget) { return; }

            // Check if delay is configured
            const fromSec = match.autoCallDelayFrom;
            const toSec = match.autoCallDelayTo;
            const hasDelay = (fromSec != null && fromSec > 0) || (toSec != null && toSec > 0);

            if (hasDelay) {
                const minSec = Math.min(fromSec ?? toSec ?? 0, toSec ?? fromSec ?? 0);
                const maxSec = Math.max(fromSec ?? toSec ?? 0, toSec ?? fromSec ?? 0);
                const delaySec = minSec === maxSec
                    ? minSec
                    : minSec + Math.random() * (maxSec - minSec);
                const delayMs = Math.round(delaySec * 1000);
                updateStatus(`auto-call in ${delaySec.toFixed(1)}s…`);

                // Store timer so it can be cancelled on chatClosed
                if (!node.autoCallTimers) { node.autoCallTimers = {}; }
                if (node.autoCallTimers[sessionId]) { clearTimeout(node.autoCallTimers[sessionId]); }
                node.autoCallTimers[sessionId] = setTimeout(async () => {
                    delete node.autoCallTimers[sessionId];
                    try {
                        await doAutoCallInject(sessionId, match);
                    } catch (err) {
                        node.warn(`Auto-call delayed failed: ${err.message}`);
                    }
                }, delayMs);
            } else {
                await doAutoCallInject(sessionId, match);
            }
        };

        const doAutoCallInject = async (sessionId, match) => {
            const connectionConfig = resolveConnectionConfig();
            if (!connectionConfig?.connection) { return; }

            const targets = resolveAutoCallTargets(match.autoCallTarget, match.autoCallType);
            if (!targets.length) {
                node.warn(`Auto-call: no matches for ${match.autoCallType}:${match.autoCallTarget}`);
                return;
            }

            // Inject each target action into the session
            const sessionActions = { ...getSessionState(sessionId) };
            for (const { action: targetAction, nodeId: targetNodeId } of targets) {
                // Respect character gate
                const chatCharacters = getCurrentChatCharacters(sessionState.getState(node.client));
                if (!isCharacterAllowed(targetAction, chatCharacters)) { continue; }
                sessionActions[targetAction.name] = toScenarioAction(targetAction);
            }

            saveSessionState(sessionId, sessionActions);
            const merged = buildMergedSessionState(sessionId);
            await pushActions(connectionConfig, sessionId, merged);
            const count = targets.length;
            updateStatus(`auto-called ${count} action(s) via ${match.autoCallType}:${match.autoCallTarget}`);
        };

        const handleTriggeredAction = async (payload) => {
            const fallbackState = sessionState.getState(node.client);
            const sessionId = payload.sessionId || node.sessionId || fallbackState.sessionId;
            if (!sessionId) {
                return;
            }

            const actionName = getTriggeredActionName(payload);
            const match = node.actions.find((action) => action.name === actionName);
            if (!match) {
                return;
            }

            const groupName = match.groups?.length ? match.groups[match.groups.length - 1].name : null;
            const mode = match.groupOnce && groupName
                ? 'group'
                : match.layerOnce
                    ? 'layer'
                    : match.onceOnly
                        ? 'action'
                        : null;
            if (!mode) {
                // No auto-remove mode, but still check auto-call
                if (match.autoCallEnabled && match.autoCallTarget) {
                    const sessionId2 = sessionId;
                    executeAutoCall(sessionId2, match).catch((err) =>
                        node.warn(`Auto-call failed: ${err.message}`)
                    );
                }
                return;
            }

            const matches = mode === 'group'
                ? (node.groupIndex.get(groupName) || [])
                : mode === 'layer'
                    ? node.actions.filter((action) => action.layer === match.layer)
                    : [match];

            const sessionActions = { ...getSessionState(sessionId) };
            let changed = false;
            for (const action of matches) {
                if (sessionActions[action.name]) {
                    delete sessionActions[action.name];
                    changed = true;
                }
            }

            if (!changed) {
                return;
            }

            const connectionConfig = resolveConnectionConfig();
            if (!connectionConfig?.connection) {
                return;
            }

            saveSessionState(sessionId, sessionActions);
            const mergedTriggered = buildMergedSessionState(sessionId);
            await pushActions(connectionConfig, sessionId, mergedTriggered);
            scheduleRestore(sessionId, match, mode, groupName);

            // Auto-call: inject defined secondary actions/groups/layers
            if (match.autoCallEnabled && match.autoCallTarget) {
                executeAutoCall(sessionId, match).catch((err) =>
                    node.warn(`Auto-call failed: ${err.message}`)
                );
            }
        };

        if (!resolveConnectionConfig()) {
            node.status({ fill: 'yellow', shape: 'ring', text: 'waiting for signalr client' });
        }

        const readinessTimer = setInterval(() => {
            if (resolveConnectionConfig()) {
                node.status({ fill: 'green', shape: 'ring', text: 'ready' });
                clearInterval(readinessTimer);
            }
        }, 1500);

        const onReceiveMessage = (payload) => {
            if (!payload || !payload.$type) {
                return;
            }
            // Auto-inject actions when a chat starts
            if (payload.$type === 'chatStarted') {
                const sessionId = payload.sessionId || payload.SessionId;
                if (!sessionId) {
                    return;
                }

                // Evaluate and cache gate result for this session
                const chatCharacters = getCurrentChatCharacters(payload);
                sessionCharacterMatch[sessionId] = (() => {
                    const filter = String(node.charId || '').trim();
                    if (!filter) { return true; }
                    const allowed = filter.split(/[,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
                    return allowed.some((name) => chatCharacters.includes(name));
                })();
                if (!sessionCharacterMatch[sessionId]) {
                    return;
                }
                const autoActions = node.actions.filter((a) => {
                    if (!a.autoInject) { return false; }
                    return isCharacterAllowed(a, chatCharacters);
                });
                if (!autoActions.length) {
                    return;
                }
                const connectionConfig = resolveConnectionConfig();
                if (!connectionConfig?.connection) {
                    return;
                }
                const sessionActions = { ...getSessionState(sessionId) };
                for (const action of autoActions) {
                    sessionActions[action.name] = toScenarioAction(action);
                }
                saveSessionState(sessionId, sessionActions);
                const mergedAutoInject = buildMergedSessionState(sessionId);
                pushActions(connectionConfig, sessionId, mergedAutoInject)
                    .then(() => updateStatus(`auto-injected ${autoActions.length} action(s)`))
                    .catch((err) => node.warn(`Auto-inject failed: ${err.message}`));
                return;
            }
            if (payload.$type === 'chatClosed') {
                const sessionId = payload.sessionId || payload.SessionId;
                if (sessionId) {
                    delete sessionCharacterMatch[sessionId]; // reprime gate for next chat
                }
                return;
            }
            if (payload.$type !== 'action' && payload.$type !== 'appTrigger') {
                return;
            }
            const fallbackState = sessionState.getState(node.client);
            const currentSessionId = node.sessionId || fallbackState.sessionId;
            if (currentSessionId && payload.sessionId && payload.sessionId !== currentSessionId) {
                return;
            }

            const actionName = getTriggeredActionName(payload);
            const match = node.actions.find((action) => action.name === actionName);
            const executionMode = match ? (match.executionMode || 'output') : 'output';

            // Legacy actions (no dashboardWidget) always send output.
            // Widget-linked actions send output only when mode !== internal.
            const sendOutput = !match || !match.dashboardWidget || executionMode !== 'internal';

            // Trigger linked dashboard widget when mode !== output-only
            const triggerWidget = match && match.dashboardWidget && executionMode !== 'output';

            if (triggerWidget) {
                triggerDashboardWidget(match, payload);
            }

            if (sendOutput) {
                node.send({
                    topic: payload.$type,
                    event: payload.$type,
                    payload,
                    sessionId: payload.sessionId || currentSessionId,
                    voxta: payload,
                    voxtaState: { ...fallbackState }
                });
            }

            handleTriggeredAction(payload).catch((error) => {
                node.warn(`Failed to process triggered action lifecycle: ${error.message}`);
            });
        };

        const listenerTimer = setInterval(() => {
            if (node.connectionConfig?.connection) {
                node.connectionConfig.connection.off('ReceiveMessage', onReceiveMessage);
                node.connectionConfig.connection.on('ReceiveMessage', onReceiveMessage);
                clearInterval(listenerTimer);
            }
        }, 1500);

        node.on('input', async (msg, send, done) => {
            try {
                const connectionConfig = resolveConnectionConfig();
                if (!connectionConfig?.connection) {
                    throw new Error('SignalR client not available');
                }

                const fallbackState = sessionState.getState(node.client);
                const sessionId = msg.sessionId || msg.voxtaState?.sessionId || msg.payload?.sessionId || node.sessionId || fallbackState.sessionId;
                if (!sessionId) {
                    throw new Error('Session ID required');
                }

                const inputMode = msg.mode || msg.actionMode || msg.payload?.mode || msg.payload?.Action || node.defaultMode;
                const triggerValue = msg.action || msg.payload?.action || msg.payload?.name || msg.payload?.Name || msg.payload;
                const { mode, ref } = parseTrigger(triggerValue, inputMode === 'remove' ? 'remove' : 'add');
                if (!ref) {
                    throw new Error('Action name, group, or layer required');
                }

                if (msg.reset === true || msg.payload?.reset === true) {
                    Object.keys(restoreTimers[sessionId] || {}).forEach((key) => clearRestoreTimer(sessionId, key));
                    clearSessionState(sessionId);
                    const payload = { $type: 'updateContext', sessionId, contextKey: 'Actions', actions: [] };
                    await connectionConfig.connection.invoke('SendMessage', payload);
                    updateStatus('actions cleared');
                    send({ ...msg, topic: 'voxta-actions', payload, sessionId, mode: 'reset', actionNames: [] });
                    done();
                    return;
                }

                const matches = findByReference(ref);
                if (matches.length === 0) {
                    throw new Error(`No configured action, group, or layer found for "${ref}"`);
                }
                // Filter out actions that don't match the character filter
                // Character gate for manual inject
                const chatCharacters = getCurrentChatCharacters(msg.payload);
                let gateOk = true;
                if (chatCharacters.length === 0 && sessionCharacterMatch[sessionId] !== undefined) {
                    gateOk = sessionCharacterMatch[sessionId];
                } else if (chatCharacters.length > 0) {
                    const filter = String(node.charId || '').trim();
                    if (filter) {
                        const allowed = filter.split(/[,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
                        gateOk = allowed.some((name) => chatCharacters.includes(name));
                    }
                }
                if (!gateOk) {
                    throw new Error(`Action "${ref}" filtered out by character restriction`);
                }
                const allowedMatches = matches.filter((a) => isCharacterAllowed(a, chatCharacters));
                if (allowedMatches.length === 0) {
                    throw new Error(`Action "${ref}" filtered out by character restriction`);
                }

                const changedNames = [];
                clearTimersForMatches(sessionId, allowedMatches);

                // Load current merged state, apply this node's changes, save back
                const mergedActions = { ...getSessionState(sessionId) };
                if (mode === 'remove') {
                    for (const action of allowedMatches) {
                        if (mergedActions[action.name]) {
                            delete mergedActions[action.name];
                            changedNames.push(action.name);
                        }
                    }
                } else {
                    for (const action of allowedMatches) {
                        mergedActions[action.name] = toScenarioAction(action);
                        changedNames.push(action.name);
                    }
                }

                saveSessionState(sessionId, mergedActions);
                const mergedManual = buildMergedSessionState(sessionId);
                const payload = await pushActions(connectionConfig, sessionId, mergedManual);
                updateStatus(`${mode}: ${changedNames.join(', ') || ref}${matches.length !== allowedMatches.length ? ' (filtered)' : ''}`);
                send({
                    ...msg,
                    topic: 'voxta-actions',
                    payload,
                    sessionId,
                    mode,
                    actionNames: changedNames,
                    registeredActions: Object.keys(sessionActions)
                });
                done();
            } catch (error) {
                updateStatus('action failed', 'red', 'ring');
                done(error);
            }
        });

        // Character filtering helpers
        const getCurrentChatCharacters = (payload) => {
            const chars = (Array.isArray(payload?.characters) ? payload.characters : [])
                .map((c) => String(c?.name || c?.Name || '').trim().toLowerCase())
                .filter(Boolean);
            return chars;
        };

        const isCharacterAllowed = (action, chatCharacters) => {
            // Check node-level global filter first
            const globalFilter = String(node.charId || '').trim();
            if (globalFilter) {
                const globalAllowed = globalFilter.split(/[,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
                if (!globalAllowed.some((name) => chatCharacters.includes(name))) {
                    return false;
                }
            }
            // Check per-action filter
            const actionFilter = String(action?.characters || '').trim();
            if (!actionFilter) { return true; }
            const actionAllowed = actionFilter.split(/[,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
            return actionAllowed.some((name) => chatCharacters.includes(name));
        };

        node.on('close', (done) => {
            if (_linkEvent && _linkHandler) { RED.events.removeListener(_linkEvent, _linkHandler); }

            clearInterval(readinessTimer);
            clearInterval(listenerTimer);
            Object.keys(restoreTimers).forEach((sessionId) => {
                Object.keys(restoreTimers[sessionId] || {}).forEach((key) => clearRestoreTimer(sessionId, key));
            });
                            Object.keys(sessionCharacterMatch).forEach((k) => delete sessionCharacterMatch[k]);
                // Cancel any pending auto-call timers
                if (node.autoCallTimers) {
                    Object.keys(node.autoCallTimers).forEach((k) => {
                        clearTimeout(node.autoCallTimers[k]);
                        delete node.autoCallTimers[k];
                    });
                }
            if (node.connectionConfig?.connection) {
                node.connectionConfig.connection.off('ReceiveMessage', onReceiveMessage);
            }
            done();
        });
    }


RED.nodes.registerType('actions', VoxtaActionsNode);
};
