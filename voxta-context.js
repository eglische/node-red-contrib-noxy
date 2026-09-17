const sessionState = require('./lib-session-state');

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

    function normalizeAutoRemove(source, fallback = {}) {
        const rawEnabled = source?.autoRemove
            ?? source?.AutoRemove
            ?? source?.autoRemoveEnabled
            ?? source?.AutoRemoveEnabled
            ?? fallback.autoRemove;
        const seconds = toOptionalNumber(
            source?.autoRemoveSeconds
            ?? source?.AutoRemoveSeconds
            ?? source?.removeAfterSeconds
            ?? source?.RemoveAfterSeconds
            ?? fallback.autoRemoveSeconds
        );
        const enabled = rawEnabled === undefined || rawEnabled === null || rawEnabled === ''
            ? Number.isFinite(seconds) && seconds > 0
            : toBoolean(rawEnabled);
        const rawMessageEnabled = source?.autoRemoveByMessages
            ?? source?.AutoRemoveByMessages
            ?? source?.autoRemoveMessagesEnabled
            ?? source?.AutoRemoveMessagesEnabled
            ?? fallback.autoRemoveByMessages;
        const messageCountValue = toOptionalNumber(
            source?.autoRemoveMessages
            ?? source?.AutoRemoveMessages
            ?? source?.removeAfterMessages
            ?? source?.RemoveAfterMessages
            ?? fallback.autoRemoveMessages
        );
        const messageCount = Number.isFinite(messageCountValue) && messageCountValue > 0
            ? Math.max(1, Math.floor(messageCountValue))
            : null;
        const messageEnabled = rawMessageEnabled === undefined || rawMessageEnabled === null || rawMessageEnabled === ''
            ? messageCount !== null
            : toBoolean(rawMessageEnabled);
        return {
            autoRemove: enabled,
            autoRemoveSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
            autoRemoveByMessages: messageEnabled,
            autoRemoveMessages: messageCount
        };
    }

    function normalizeContext(context) {
        const name = String(context?.name || context?.Name || '').trim();
        const text = String(context?.text || context?.Text || '').trim();
        if (!name || !text) {
            return null;
        }

        const autoRemove = normalizeAutoRemove(context);
        return {
            type: 'context',
            name,
            text,
            disabled: toBoolean(context?.disabled ?? context?.Disabled),
            setFlags: Array.isArray(context?.setFlags || context?.SetFlags)
                ? (context.setFlags || context.SetFlags).map((value) => String(value).trim()).filter(Boolean)
                : String(context?.setFlags || context?.SetFlags || '').split(',').map((value) => value.trim()).filter(Boolean),
            autoRemove: autoRemove.autoRemove,
            autoRemoveSeconds: autoRemove.autoRemoveSeconds,
            autoRemoveByMessages: autoRemove.autoRemoveByMessages,
            autoRemoveMessages: autoRemove.autoRemoveMessages
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
            mutualExclusive: toBoolean(group?.mutualExclusive ?? group?.MutualExclusive),
            autoInjectSeconds: toOptionalNumber(group?.autoInjectSeconds ?? group?.AutoInjectSeconds),
            uiCollapsed: toBoolean(group?.uiCollapsed ?? group?.UiCollapsed),
            uiOptionsCollapsed: toBoolean(group?.uiOptionsCollapsed ?? group?.UiOptionsCollapsed),
            items: normalizeEntries(group?.items || group?.contexts || [])
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
                return normalizeContext(entry);
            })
            .filter(Boolean);
    }

    function flattenEntries(entries, groupStack = [], contextList = [], groupIndex = new Map()) {
        for (const entry of entries) {
            if (entry.type === 'group') {
                const nextGroups = [...groupStack, {
                    id: entry.id,
                    name: entry.name,
                    mutualExclusive: !!entry.mutualExclusive,
                    autoInjectSeconds: entry.autoInjectSeconds,
                    uiOptionsCollapsed: !!entry.uiOptionsCollapsed
                }];
                flattenEntries(entry.items || [], nextGroups, contextList, groupIndex);
                continue;
            }

            const context = {
                ...entry,
                groups: [...groupStack]
            };
            contextList.push(context);

            for (const group of groupStack) {
                const existing = groupIndex.get(group.name) || [];
                existing.push(context);
                groupIndex.set(group.name, existing);
            }
        }

        return { contextList, groupIndex };
    }

    function parseContextReference(rawValue) {
        const text = String(rawValue || '').trim();
        if (!text) {
            return { name: '', disabled: false };
        }
        if (text.startsWith('!')) {
            return { name: text.slice(1).trim(), disabled: true };
        }
        if (text.endsWith('!')) {
            return { name: text.slice(0, -1).trim(), disabled: true };
        }
        return { name: text, disabled: false };
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isConnectionConnected(connection) {
        return connection && connection.state === 'Connected';
    }

    async function waitForConnectionReady(node, timeoutMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const connection = node.connectionConfig?.connection;
            const currentState = sessionState.getState(node.client);
            if (isConnectionConnected(connection) && currentState.connected !== false) {
                return true;
            }
            await delay(250);
        }
        return false;
    }

    function isDisconnectedStateError(error) {
        return typeof error?.message === 'string'
            && error.message.includes("Cannot send data if the connection is not in the 'Connected' State");
    }

    function VoxtaContextNode(config) {
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
        node.contextKey = config.contextKey || '';
        node.contextText = config.contextText || '';
        node.setFlags = config.setFlags || '';
        node.disabled = config.disabled === true || config.disabled === 'true';
        node.sessionId = config.sessionId || '';
        node.charId = config.charId || '';
        node.contextEntries = normalizeEntries(config.contexts);
        const flattened = flattenEntries(node.contextEntries);
        node.contexts = flattened.contextList;
        node.groupIndex = flattened.groupIndex;
        node.connectionConfig = null;

        const autoInjectTimers = {};
        const autoRemoveTimers = new Map();
        const autoRemoveMessageCounters = new Map();
        const pendingReplyInjects = new Map();
        let autoRemoveSequence = 0;
        const sessionCharacterMatch = {}; // sessionId -> bool: whether charId gate passed

        const getCurrentChatCharacters = (payload) => {
            const chars = (Array.isArray(payload?.characters) ? payload.characters : [])
                .map((c) => String(c?.name || c?.Name || '').trim().toLowerCase())
                .filter(Boolean);
            return chars;
        };

        const isCharacterAllowed = (chatCharacters) => {
            const filter = String(node.charId || '').trim();
            if (!filter) { return true; }
            const allowed = filter.split(/[,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
            return allowed.some((name) => chatCharacters.includes(name));
        };

        const resolveConnectionConfig = () => {
            node.connectionConfig = RED.nodes.getNode(node.client);
            if (!node.connectionConfig) {
                node.status({ fill: 'red', shape: 'ring', text: 'missing signalr client' });
                return null;
            }
            return node.connectionConfig;
        };

        const clearAutoInjectTimer = (sessionId, groupName) => {
            if (autoInjectTimers[sessionId]?.[groupName]) {
                clearTimeout(autoInjectTimers[sessionId][groupName]);
                delete autoInjectTimers[sessionId][groupName];
            }
            if (autoInjectTimers[sessionId] && Object.keys(autoInjectTimers[sessionId]).length === 0) {
                delete autoInjectTimers[sessionId];
            }
        };

        const findExclusiveGroup = (contexts) => contexts.find((context) =>
            Array.isArray(context.groups) && context.groups.some((group) => group.mutualExclusive)
        )?.groups?.slice().reverse().find((group) => group.mutualExclusive) || null;

        const buildTriggeredContexts = (contexts, parsedName, parsedDisabled) => {
            if (contexts.length === 0) {
                return [];
            }

            const exclusiveGroup = findExclusiveGroup(contexts);
            if (!exclusiveGroup) {
                return contexts.map((context) => ({
                    name: context.name,
                    text: context.text,
                    disabled: parsedDisabled ? true : !!context.disabled
                }));
            }

            const groupContexts = node.groupIndex.get(exclusiveGroup.name) || contexts;
            const explicitName = parsedName.startsWith('group:') ? parsedName.slice(6).trim() : parsedName;
            const targetName = contexts.some((context) => context.name === explicitName)
                ? explicitName
                : (groupContexts[0]?.name || '');

            return groupContexts.map((context) => ({
                name: context.name,
                text: context.text,
                disabled: parsedDisabled ? true : context.name !== targetName
            }));
        };

        const findContextsByReference = (reference) => {
            const ref = String(reference || '').trim();
            if (!ref) {
                return [];
            }

            const explicitGroup = ref.startsWith('group:') ? ref.slice(6).trim() : null;
            if (!explicitGroup) {
                const byName = node.contexts.find((context) => context.name === ref);
                if (byName) {
                    return [byName];
                }
            }

            const byGroup = node.groupIndex.get(explicitGroup || ref);
            if (byGroup?.length) {
                return byGroup;
            }

            return [];
        };

        const buildContextOperationFromReference = (reference, sessionId) => {
            const parsed = parseContextReference(reference);
            const contexts = findContextsByReference(parsed.name);
            if (contexts.length === 0) {
                throw new Error(`No configured context or group found for "${reference}"`);
            }

            const explicitGroup = parsed.name.startsWith('group:') ? parsed.name.slice(6).trim() : '';
            const exclusiveGroup = findExclusiveGroup(contexts);
            const mergedFlags = [...new Set(contexts.flatMap((context) => context.setFlags || []))];
            const payloadContexts = buildTriggeredContexts(contexts, parsed.name, parsed.disabled);
            const payload = {
                $type: 'updateContext',
                sessionId,
                contextKey: explicitGroup || exclusiveGroup?.name || (contexts.length === 1 ? contexts[0].name : parsed.name),
                contexts: payloadContexts
            };
            if (mergedFlags.length > 0) {
                payload.setFlags = mergedFlags;
            }

            const removals = payloadContexts.flatMap((payloadContext) => {
                if (payloadContext.disabled) {
                    return [];
                }
                const configured = contexts.find((context) => context.name === payloadContext.name);
                const timeEnabled = configured?.autoRemove
                    && Number.isFinite(configured.autoRemoveSeconds)
                    && configured.autoRemoveSeconds > 0;
                const messageEnabled = configured?.autoRemoveByMessages
                    && Number.isFinite(configured.autoRemoveMessages)
                    && configured.autoRemoveMessages > 0;
                if (!timeEnabled && !messageEnabled) {
                    return [];
                }
                return [{
                    identity: payloadContext.name || payload.contextKey,
                    name: payloadContext.name || '',
                    text: payloadContext.text,
                    seconds: timeEnabled ? configured.autoRemoveSeconds : null,
                    messages: messageEnabled ? configured.autoRemoveMessages : null
                }];
            });
            return { payload, removals };
        };

        const sendPayload = async (payload) => {
            const ready = await waitForConnectionReady(node);
            if (!ready) {
                throw new Error('SignalR client is not connected yet');
            }

            try {
                await node.connectionConfig.connection.invoke('SendMessage', payload);
            } catch (error) {
                if (!isDisconnectedStateError(error)) {
                    throw error;
                }

                const retryReady = await waitForConnectionReady(node, 5000);
                if (!retryReady) {
                    throw new Error('SignalR client stayed disconnected while sending context');
                }
                await node.connectionConfig.connection.invoke('SendMessage', payload);
            }
        };

        const timerFieldNames = [
            'autoRemove', 'AutoRemove', 'autoRemoveEnabled', 'AutoRemoveEnabled',
            'autoRemoveSeconds', 'AutoRemoveSeconds', 'removeAfterSeconds', 'RemoveAfterSeconds',
            'autoRemoveByMessages', 'AutoRemoveByMessages', 'autoRemoveMessagesEnabled', 'AutoRemoveMessagesEnabled',
            'autoRemoveMessages', 'AutoRemoveMessages', 'removeAfterMessages', 'RemoveAfterMessages'
        ];

        const hasTimerFields = (source) => source && timerFieldNames.some((name) =>
            Object.prototype.hasOwnProperty.call(source, name)
        );

        const normalizeFlags = (value) => {
            if (!value) {
                return [];
            }
            return Array.isArray(value)
                ? value.map((item) => String(item).trim()).filter(Boolean)
                : String(value).split(',').map((item) => item.trim()).filter(Boolean);
        };

        const buildDynamicContextOperation = (msg, source, sessionId) => {
            const container = Array.isArray(source) ? { contexts: source } : (source || {});
            if (container.$type && container.$type !== 'updateContext') {
                throw new Error(`Unsupported context message type "${container.$type}"`);
            }

            const reference = String(container.reference || container.ref || '').trim();
            if (reference) {
                const operation = buildContextOperationFromReference(reference, sessionId);
                const overrideSource = hasTimerFields(container) ? container : (hasTimerFields(msg) ? msg : null);
                if (overrideSource) {
                    const override = normalizeAutoRemove(overrideSource);
                    operation.removals = operation.payload.contexts.flatMap((context) => {
                        const timeEnabled = override.autoRemove
                            && Number.isFinite(override.autoRemoveSeconds)
                            && override.autoRemoveSeconds > 0;
                        const messageEnabled = override.autoRemoveByMessages
                            && Number.isFinite(override.autoRemoveMessages)
                            && override.autoRemoveMessages > 0;
                        if (context.disabled || (!timeEnabled && !messageEnabled)) {
                            return [];
                        }
                        return [{
                            identity: context.name || operation.payload.contextKey,
                            name: context.name || '',
                            text: context.text,
                            seconds: timeEnabled ? override.autoRemoveSeconds : null,
                            messages: messageEnabled ? override.autoRemoveMessages : null
                        }];
                    });
                }
                return operation;
            }

            let rawContexts = container.contexts || container.Contexts;
            if (!Array.isArray(rawContexts)) {
                const nested = container.context || container.Context;
                rawContexts = nested && typeof nested === 'object' ? [nested] : [container];
            }

            const contextKey = String(
                msg.contextKey
                || container.contextKey
                || container.ContextKey
                || container.key
                || container.Key
                || container.name
                || container.Name
                || node.contextKey
                || rawContexts[0]?.name
                || rawContexts[0]?.Name
                || ''
            ).trim();
            if (!contextKey) {
                throw new Error('Dynamic JSON requires contextKey (or name)');
            }

            const msgTimer = normalizeAutoRemove(msg);
            const defaultTimer = normalizeAutoRemove(container, msgTimer);
            const payloadContexts = [];
            const removals = [];

            rawContexts.forEach((rawContext, index) => {
                if (!rawContext || typeof rawContext !== 'object') {
                    throw new Error(`Dynamic context at index ${index} must be an object`);
                }
                const name = String(rawContext.name || rawContext.Name || rawContext.contextName || rawContext.ContextName || '').trim();
                const text = String(
                    rawContext.text
                    ?? rawContext.Text
                    ?? rawContext.contextText
                    ?? rawContext.ContextText
                    ?? (rawContexts.length === 1 ? (container.text ?? container.Text ?? container.contextText ?? container.ContextText ?? msg.contextText ?? node.contextText ?? '') : '')
                ).trim();
                if (!text) {
                    throw new Error(`Dynamic context${name ? ` "${name}"` : ` at index ${index}`} requires text`);
                }

                const disabled = toBoolean(rawContext.disabled ?? rawContext.Disabled ?? container.disabled ?? container.Disabled ?? msg.disabled ?? node.disabled);
                const outgoing = { text, disabled };
                if (name) {
                    outgoing.name = name;
                }
                payloadContexts.push(outgoing);

                const timer = normalizeAutoRemove(rawContext, defaultTimer);
                const timeEnabled = timer.autoRemove
                    && Number.isFinite(timer.autoRemoveSeconds)
                    && timer.autoRemoveSeconds > 0;
                const messageEnabled = timer.autoRemoveByMessages
                    && Number.isFinite(timer.autoRemoveMessages)
                    && timer.autoRemoveMessages > 0;
                if (!disabled && (timeEnabled || messageEnabled)) {
                    removals.push({
                        identity: name || contextKey,
                        name,
                        text,
                        seconds: timeEnabled ? timer.autoRemoveSeconds : null,
                        messages: messageEnabled ? timer.autoRemoveMessages : null
                    });
                }
            });

            const payload = {
                $type: 'updateContext',
                sessionId,
                contextKey,
                contexts: payloadContexts
            };
            const contextFlags = rawContexts.flatMap((context) => normalizeFlags(context?.setFlags || context?.SetFlags));
            const flags = normalizeFlags(
                msg.setFlags
                ?? container.setFlags
                ?? container.SetFlags
                ?? (contextFlags.length > 0 ? contextFlags : node.setFlags)
            );
            if (flags.length > 0) {
                payload.setFlags = [...new Set(flags)];
            }
            return { payload, removals };
        };

        const autoRemoveTimerKey = (sessionId, contextKey, identity) => JSON.stringify([
            String(sessionId), String(contextKey), String(identity)
        ]);

        const cancelAutoRemoveTimer = (sessionId, contextKey, identity) => {
            const key = autoRemoveTimerKey(sessionId, contextKey, identity);
            const existing = autoRemoveTimers.get(key);
            if (existing) {
                clearTimeout(existing.timer);
                autoRemoveTimers.delete(key);
            }
            autoRemoveMessageCounters.delete(key);
        };

        const cancelAutoRemoveTimersForSession = (sessionId) => {
            for (const [key, entry] of autoRemoveTimers.entries()) {
                if (entry.sessionId === sessionId) {
                    clearTimeout(entry.timer);
                    autoRemoveTimers.delete(key);
                }
            }
            for (const [key, entry] of autoRemoveMessageCounters.entries()) {
                if (entry.sessionId === sessionId) {
                    autoRemoveMessageCounters.delete(key);
                }
            }
            for (const [key, entry] of pendingReplyInjects.entries()) {
                if (entry.sessionId === sessionId) {
                    pendingReplyInjects.delete(key);
                }
            }
        };

        const removeExpiredContext = async (key, token, removal, reason) => {
            const timerEntry = autoRemoveTimers.get(key);
            const messageEntry = autoRemoveMessageCounters.get(key);
            const current = timerEntry || messageEntry;
            if (!current || current.token !== token) {
                return;
            }

            if (timerEntry?.timer) {
                clearTimeout(timerEntry.timer);
            }
            autoRemoveTimers.delete(key);
            autoRemoveMessageCounters.delete(key);

            const removalContext = {
                text: removal.text,
                disabled: true
            };
            if (removal.name) {
                removalContext.name = removal.name;
            }
            try {
                await sendPayload({
                    $type: 'updateContext',
                    sessionId: removal.sessionId,
                    contextKey: removal.contextKey,
                    contexts: [removalContext]
                });
                node.status({ fill: 'grey', shape: 'dot', text: `removed ${removal.identity} (${reason})` });
            } catch (error) {
                node.warn(`Context auto-remove failed for ${removal.identity}: ${error.message}`);
            }
        };

        const scheduleAutoRemovals = (sessionId, payload, removals) => {
            for (const context of payload.contexts || []) {
                cancelAutoRemoveTimer(sessionId, payload.contextKey, context.name || payload.contextKey);
            }

            for (const removal of removals || []) {
                const key = autoRemoveTimerKey(sessionId, payload.contextKey, removal.identity);
                const token = ++autoRemoveSequence;
                const scheduled = {
                    token,
                    sessionId,
                    contextKey: payload.contextKey,
                    identity: removal.identity,
                    name: removal.name,
                    text: removal.text
                };

                if (Number.isFinite(removal.seconds) && removal.seconds > 0) {
                    const delayMs = Math.round(removal.seconds * 1000);
                    const timer = setTimeout(() => {
                        removeExpiredContext(key, token, scheduled, 'time');
                    }, delayMs);
                    autoRemoveTimers.set(key, { ...scheduled, timer });
                }
                if (Number.isFinite(removal.messages) && removal.messages > 0) {
                    autoRemoveMessageCounters.set(key, {
                        ...scheduled,
                        remainingMessages: Math.max(1, Math.floor(removal.messages))
                    });
                }

                const expiryLabels = [];
                if (Number.isFinite(removal.seconds) && removal.seconds > 0) {
                    expiryLabels.push(`${removal.seconds}s`);
                }
                if (Number.isFinite(removal.messages) && removal.messages > 0) {
                    expiryLabels.push(`${Math.floor(removal.messages)} msg`);
                }
                node.status({ fill: 'yellow', shape: 'dot', text: `remove ${removal.identity} in ${expiryLabels.join(' or ')}` });
            }
        };

        const advanceMessageExpirations = (sessionId) => {
            for (const [key, entry] of [...autoRemoveMessageCounters.entries()]) {
                if (entry.sessionId !== sessionId) {
                    continue;
                }
                entry.remainingMessages -= 1;
                if (entry.remainingMessages <= 0) {
                    removeExpiredContext(key, entry.token, entry, 'message');
                } else {
                    autoRemoveMessageCounters.set(key, entry);
                }
            }

            // Advance pending reply-based auto-injects
            for (const [key, pending] of [...pendingReplyInjects.entries()]) {
                if (pending.sessionId !== sessionId) {
                    continue;
                }
                pending.remainingMessages -= 1;
                if (pending.remainingMessages <= 0) {
                    pendingReplyInjects.delete(key);
                    const operation = (() => {
                        try {
                            return buildContextOperationFromReference(pending.contextName, sessionId);
                        } catch (error) {
                            node.warn(`Failed to build reply-inject payload for ${pending.contextName}: ${error.message}`);
                            return null;
                        }
                    })();
                    if (!operation) {
                        continue;
                    }
                    sendPayload(operation.payload)
                        .then(() => {
                            node.status({ fill: 'green', shape: 'dot', text: `autoinject ${pending.contextName}` });
                        })
                        .catch((error) => {
                            node.warn(`Reply-inject failed for ${pending.contextName}: ${error.message}`);
                        });
                } else {
                    pendingReplyInjects.set(key, pending);
                }
            }
        };

        const scheduleAutoInjectsForSession = (sessionId) => {
            if (sessionCharacterMatch[sessionId] === false) {
                return; // gated out by character filter
            }

            // --- Group-level auto-inject (existing) ---
            const seenGroups = new Set();
            for (const context of node.contexts) {
                for (const group of context.groups || []) {
                    if (seenGroups.has(group.name)) {
                        continue;
                    }
                    seenGroups.add(group.name);

                    if (!Number.isFinite(group.autoInjectSeconds) || group.autoInjectSeconds <= 0) {
                        continue;
                    }

                    clearAutoInjectTimer(sessionId, group.name);
                    if (!autoInjectTimers[sessionId]) {
                        autoInjectTimers[sessionId] = {};
                    }

                    autoInjectTimers[sessionId][group.name] = setTimeout(() => {
                        const operation = (() => {
                            try {
                                return buildContextOperationFromReference(`group:${group.name}`, sessionId);
                            } catch (error) {
                                node.warn(`Failed to build autoinject payload for group ${group.name}: ${error.message}`);
                                return null;
                            }
                        })();

                        if (!operation) {
                            clearAutoInjectTimer(sessionId, group.name);
                            return;
                        }

                        sendPayload(operation.payload)
                            .then(() => {
                                node.status({ fill: 'green', shape: 'dot', text: `autoinject ${group.name}` });
                                scheduleAutoRemovals(sessionId, operation.payload, operation.removals);
                            })
                            .catch((error) => {
                                node.warn(`Autoinject failed for group ${group.name}: ${error.message}`);
                            })
                            .finally(() => {
                                clearAutoInjectTimer(sessionId, group.name);
                            });
                    }, Math.round(group.autoInjectSeconds * 1000));
                }
            }

            // --- Per-context auto-inject (new) ---
            // A standalone context (no group) auto-injects when either the
            // "By time" or "By replies" checkbox is enabled.
            //
            // By time:   inject after autoRemoveSeconds delay, then KEEP the
            //            context (no auto-remove).
            // By replies: inject after autoRemoveMessages assistant replies,
            //             then KEEP the context.
            // Both unchecked: no auto-inject.
            const seenContexts = new Set();
            for (const context of node.contexts) {
                // Skip contexts that belong to a group — those are handled above
                if ((context.groups || []).length > 0) {
                    continue;
                }
                // Skip disabled contexts
                if (context.disabled) {
                    continue;
                }

                const timeEnabled = context.autoRemove
                    && Number.isFinite(context.autoRemoveSeconds)
                    && context.autoRemoveSeconds > 0;
                const replyEnabled = context.autoRemoveByMessages
                    && Number.isFinite(context.autoRemoveMessages)
                    && context.autoRemoveMessages > 0;

                if (!timeEnabled && !replyEnabled) {
                    continue;
                }

                const timerKey = `ctx:${context.name}`;
                if (seenContexts.has(timerKey)) {
                    continue;
                }
                seenContexts.add(timerKey);

                clearAutoInjectTimer(sessionId, timerKey);
                if (!autoInjectTimers[sessionId]) {
                    autoInjectTimers[sessionId] = {};
                }

                if (timeEnabled) {
                    // Inject after a delay, context stays — no removal
                    autoInjectTimers[sessionId][timerKey] = setTimeout(() => {
                        const operation = (() => {
                            try {
                                return buildContextOperationFromReference(context.name, sessionId);
                            } catch (error) {
                                node.warn(`Failed to build autoinject payload for context ${context.name}: ${error.message}`);
                                return null;
                            }
                        })();

                        if (!operation) {
                            clearAutoInjectTimer(sessionId, timerKey);
                            return;
                        }

                        sendPayload(operation.payload)
                            .then(() => {
                                node.status({ fill: 'green', shape: 'dot', text: `autoinject ${context.name}` });
                            })
                            .catch((error) => {
                                node.warn(`Autoinject failed for context ${context.name}: ${error.message}`);
                            })
                            .finally(() => {
                                clearAutoInjectTimer(sessionId, timerKey);
                            });
                    }, Math.round(context.autoRemoveSeconds * 1000));
                }

                if (replyEnabled) {
                    // Store pending reply-count injection; injected after N replies
                    pendingReplyInjects.set(autoRemoveTimerKey(sessionId, 'ctx', context.name), {
                        sessionId,
                        contextName: context.name,
                        remainingMessages: Math.max(1, Math.floor(context.autoRemoveMessages))
                    });
                    node.status({ fill: 'yellow', shape: 'ring', text: `inject ${context.name} after ${context.autoRemoveMessages} replies` });
                }
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

            const fallbackState = sessionState.getState(node.client);
            const currentSessionId = node.sessionId || fallbackState.sessionId;
            if (currentSessionId && payload.sessionId && payload.sessionId !== currentSessionId) {
                return;
            }

            if (payload.$type === 'chatStarted') {
                const sessionId = payload.sessionId || currentSessionId;
                if (sessionId) {
                    const chatCharacters = getCurrentChatCharacters(payload);
                    sessionCharacterMatch[sessionId] = isCharacterAllowed(chatCharacters);
                    if (sessionCharacterMatch[sessionId]) {
                        scheduleAutoInjectsForSession(sessionId);
                    }
                }
            } else if (payload.$type === 'chatClosed') {
                const sessionId = payload.sessionId || currentSessionId;
                if (sessionId) {
                    Object.keys(autoInjectTimers[sessionId] || {}).forEach((groupName) => clearAutoInjectTimer(sessionId, groupName));
                    cancelAutoRemoveTimersForSession(sessionId);
                    delete sessionCharacterMatch[sessionId]; // reprime gate for next chat
                }
            } else if (payload.$type === 'replyEnd') {
                const sessionId = payload.sessionId || currentSessionId;
                if (sessionId) {
                    advanceMessageExpirations(sessionId);
                }
            }
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

                let source = msg.payload;
                let isReference = typeof source === 'string';
                if (isReference) {
                    const trimmed = source.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        try {
                            source = JSON.parse(trimmed);
                            isReference = false;
                        } catch (error) {
                            throw new Error(`Invalid context JSON: ${error.message}`);
                        }
                    }
                }

                const fallbackState = sessionState.getState(node.client);
                const sourceSessionId = source && typeof source === 'object'
                    ? (source.sessionId || source.SessionId)
                    : '';
                const sessionId = msg.sessionId || sourceSessionId || node.sessionId || fallbackState.sessionId;
                if (!sessionId) {
                    throw new Error('Session ID required');
                }

                // Respect explicit character data, then the chatStarted cache, then client state.
                const sourceCharacters = getCurrentChatCharacters(source && typeof source === 'object' ? source : msg);
                const stateCharacters = getCurrentChatCharacters(fallbackState);
                const characterAllowed = sourceCharacters.length > 0
                    ? isCharacterAllowed(sourceCharacters)
                    : Object.prototype.hasOwnProperty.call(sessionCharacterMatch, sessionId)
                        ? sessionCharacterMatch[sessionId]
                        : isCharacterAllowed(stateCharacters);
                if (!characterAllowed) {
                    throw new Error('Context filtered out by character restriction');
                }

                const operation = isReference
                    ? buildContextOperationFromReference(source, sessionId)
                    : buildDynamicContextOperation(msg, source && typeof source === 'object' ? source : {}, sessionId);

                await sendPayload(operation.payload);
                node.status({ fill: 'green', shape: 'dot', text: operation.payload.contextKey });
                scheduleAutoRemovals(sessionId, operation.payload, operation.removals);
                send({
                    ...msg,
                    payload: operation.payload,
                    topic: 'updateContext',
                    autoRemoveScheduled: operation.removals.length
                });
                done();
            } catch (error) {
                node.status({ fill: 'red', shape: 'ring', text: 'context failed' });
                done(error);
            }
        });

        node.on('close', (done) => {
            if (_linkEvent && _linkHandler) { RED.events.removeListener(_linkEvent, _linkHandler); }

            clearInterval(readinessTimer);
            clearInterval(listenerTimer);
            Object.keys(autoInjectTimers).forEach((sessionId) => {
                Object.keys(autoInjectTimers[sessionId] || {}).forEach((groupName) => clearAutoInjectTimer(sessionId, groupName));
            });
            for (const entry of autoRemoveTimers.values()) {
                clearTimeout(entry.timer);
            }
            autoRemoveTimers.clear();
            autoRemoveMessageCounters.clear();
            pendingReplyInjects.clear();
            Object.keys(sessionCharacterMatch).forEach((k) => delete sessionCharacterMatch[k]);
            if (node.connectionConfig?.connection) {
                node.connectionConfig.connection.off('ReceiveMessage', onReceiveMessage);
            }
            done();
        });
    }


RED.nodes.registerType('context', VoxtaContextNode);
};
