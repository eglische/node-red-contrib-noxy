const http = require('http');
const https = require('https');
const sessionState = require('./lib-session-state');

module.exports = function (RED) {
    function VoxtaEventsNode(config) {
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
        node.eventFilter = (config.eventFilter || '').trim();
        node.outputMode = config.outputMode || 'split';
        node.connectionConfig = RED.nodes.getNode(node.client);

        if (!node.connectionConfig) {
            node.status({ fill: 'red', shape: 'ring', text: 'missing signalr client' });
            return;
        }

        const matches = (eventName) => {
            if (!node.eventFilter) {
                return true;
            }
            return node.eventFilter
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
                .includes(eventName);
        };

        const currentState = sessionState.getState(node.client);
        let authInFlight = false;

        const updateStatus = (text, fill = 'green', shape = 'dot') => {
            node.status({ fill, shape, text });
        };

        const sendMessage = (message) => node.connectionConfig.connection.invoke('SendMessage', message);

        // Output 4 chat-state cache. Kept on the node so a later feature can consume it
        // without changing the stable payload contract of outputs 1-3.
        const chatSnapshots = new Map();
        const snapshotRefreshTimers = new Map();
        node.chatSnapshots = chatSnapshots;
        node.currentChatSnapshot = null;
        node.lastChatSnapshot = null;
        node.getChatSnapshot = (sessionId) => cloneJson(chatSnapshots.get(sessionId || currentState.sessionId) || null);

        function cloneJson(value) {
            if (value === undefined) return undefined;
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (_) {
                return value;
            }
        }

        const getConnectionAddress = () => {
            const connection = RED.nodes.getNode(node.client) || node.connectionConfig || {};
            return {
                host: connection.host || '127.0.0.1',
                port: Number(connection.port) || (connection.secure ? 443 : 80),
                secure: connection.secure === true || connection.secure === 'true',
            };
        };

        const requestJson = (path) => new Promise((resolve, reject) => {
            const address = getConnectionAddress();
            const transport = address.secure ? https : http;
            const request = transport.get({
                hostname: address.host,
                port: address.port,
                path,
                headers: { Accept: 'application/json' },
                timeout: 5000,
            }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`Voxta API ${path} returned ${response.statusCode}`));
                        return;
                    }
                    try {
                        resolve(body ? JSON.parse(body) : null);
                    } catch (error) {
                        reject(new Error(`Voxta API ${path} returned invalid JSON: ${error.message}`));
                    }
                });
            });
            request.on('timeout', () => request.destroy(new Error(`Voxta API ${path} timed out`)));
            request.on('error', reject);
        });

        const safeRequestJson = async (path) => {
            try {
                return await requestJson(path);
            } catch (error) {
                node.debug?.(`chat snapshot: ${error.message}`);
                return null;
            }
        };

        const normalizeTranscript = (messages) => (Array.isArray(messages) ? messages : []).map((message) => ({
            messageId: message.messageId || message.id || null,
            index: message.index ?? message.messageIndex ?? null,
            conversationIndex: message.conversationIndex ?? null,
            role: message.role || null,
            speaker: message.name || message.senderName || null,
            senderId: message.senderId || null,
            text: message.text ?? message.value ?? '',
            timestamp: message.timestamp || null,
            chatTime: message.chatTime ?? null,
            isSecret: String(message.role || '').toLowerCase() === 'secret',
        }));

        const buildBaseSnapshot = (message) => {
            const sessionId = message.sessionId || message.SessionId || currentState.sessionId || null;
            const chatId = message.chatId || message.ChatId || currentState.chatId || null;
            const messages = cloneJson(message.messages || []);
            return {
                schema: 'noxy.chat-snapshot.v1',
                sessionId,
                chatId,
                loadedAt: new Date().toISOString(),
                chatConfiguration: {
                    user: cloneJson(message.user || null),
                    characters: cloneJson(message.characters || []),
                    narrator: cloneJson(message.narrator || null),
                    scenario: cloneJson(message.scenario || null),
                    augmentations: cloneJson(message.augmentations || []),
                    services: cloneJson(message.services || null),
                },
                situation: cloneJson(message.context || null),
                messages,
                transcript: normalizeTranscript(messages),
                variables: {},
                flags: [],
                promptSources: {
                    profile: null,
                    scenario: null,
                    characters: [],
                    narrator: null,
                    activeContext: cloneJson(message.context || null),
                },
                systemPrompt: {
                    available: false,
                    source: 'promptSources',
                    text: null,
                    messages: [],
                    promptMessages: [],
                    diagnosticId: null,
                    note: 'Voxta has not exposed a rendered TextGen prompt for this chat yet; promptSources contains every currently retrievable source component.',
                },
            };
        };

        const selectMatchingDiagnostic = (diagnostics, snapshot) => {
            const candidates = Array.isArray(diagnostics?.textGen) ? diagnostics.textGen : [];
            if (!candidates.length) return null;
            const transcriptTexts = (snapshot.transcript || [])
                .map((entry) => String(entry.text || '').trim())
                .filter((text) => text.length >= 12);
            let best = null;
            for (const candidate of candidates) {
                let score = 0;
                for (const promptMessage of candidate.messages || []) {
                    const value = String(promptMessage.value ?? promptMessage.text ?? '').trim();
                    if (!value) continue;
                    for (const text of transcriptTexts) {
                        if (value.includes(text) || text.includes(value)) {
                            score += Math.min(text.length, 500);
                            break;
                        }
                    }
                }
                const timestamp = Date.parse(candidate.timestamp || '') || 0;
                if (!best || score > best.score || (score === best.score && timestamp > best.timestamp)) {
                    best = { candidate, score, timestamp };
                }
            }
            return best?.score > 0 ? best.candidate : null;
        };

        const enrichSnapshot = async (snapshot) => {
            if (!snapshot) return null;
            const chatId = snapshot.chatId;
            const scenarioId = snapshot.chatConfiguration?.scenario?.id;
            const characterInfos = Array.isArray(snapshot.chatConfiguration?.characters)
                ? snapshot.chatConfiguration.characters
                : [];
            const narratorInfo = snapshot.chatConfiguration?.narrator;

            const [inspect, profile, scenario, diagnostics, characterDefinitions, narratorDefinition] = await Promise.all([
                chatId ? safeRequestJson(`/api/chats/${encodeURIComponent(chatId)}/inspect`) : Promise.resolve(null),
                safeRequestJson('/api/profile'),
                scenarioId ? safeRequestJson(`/api/scenarios/${encodeURIComponent(scenarioId)}`) : Promise.resolve(null),
                safeRequestJson('/api/diagnostics'),
                Promise.all(characterInfos.map(async (info) => ({
                    participant: cloneJson(info),
                    definition: info?.id
                        ? await safeRequestJson(`/api/characters/${encodeURIComponent(info.id)}`)
                        : null,
                }))),
                narratorInfo?.id
                    ? safeRequestJson(`/api/characters/${encodeURIComponent(narratorInfo.id)}`)
                    : Promise.resolve(null),
            ]);

            if (Array.isArray(inspect?.messages)) {
                snapshot.messages = cloneJson(inspect.messages);
                snapshot.transcript = normalizeTranscript(snapshot.messages);
            }
            snapshot.variables = cloneJson(inspect?.variables || snapshot.variables || {});
            snapshot.flags = cloneJson(inspect?.flags || snapshot.flags || []);
            snapshot.promptSources.profile = cloneJson(profile);
            snapshot.promptSources.scenario = cloneJson(scenario);
            snapshot.promptSources.characters = cloneJson(characterDefinitions);
            snapshot.promptSources.narrator = cloneJson(narratorDefinition);
            snapshot.promptSources.activeContext = cloneJson(snapshot.situation);

            const diagnostic = selectMatchingDiagnostic(diagnostics, snapshot);
            if (diagnostic) {
                const promptMessages = cloneJson(diagnostic.messages || []);
                const systemMessages = promptMessages.filter((entry) => String(entry.role || '').toLowerCase() === 'system');
                snapshot.systemPrompt = {
                    available: systemMessages.length > 0,
                    source: 'voxtaDiagnostics',
                    text: systemMessages.map((entry) => entry.value ?? entry.text ?? '').filter(Boolean).join('\n\n') || null,
                    messages: systemMessages,
                    promptMessages,
                    diagnosticId: diagnostic.id || null,
                    timestamp: diagnostic.timestamp || null,
                    serviceName: diagnostic.serviceName || null,
                    note: systemMessages.length
                        ? 'Canonical rendered prompt observed by Voxta TextGen diagnostics.'
                        : 'A matching TextGen request was found, but it contained no system-role message.',
                };
            }
            snapshot.refreshedAt = new Date().toISOString();
            return snapshot;
        };

        const sendSnapshotOutput = (snapshot, lifecycleEvent, lifecycle) => {
            const payload = cloneJson(snapshot);
            payload.event = lifecycleEvent;
            payload.lifecycle = lifecycle;
            payload.emittedAt = new Date().toISOString();
            node.send([null, null, null, {
                topic: 'voxta/chatSnapshot',
                event: lifecycleEvent,
                sessionId: payload.sessionId,
                chatId: payload.chatId,
                payload,
                voxta: payload,
            }]);
        };

        const loadAndEmitSnapshot = async (message) => {
            const snapshot = buildBaseSnapshot(message);
            if (!snapshot.sessionId) return;
            chatSnapshots.set(snapshot.sessionId, snapshot);
            node.currentChatSnapshot = snapshot;
            try {
                await sendMessage({ $type: 'inspect', sessionId: snapshot.sessionId, enabled: true });
            } catch (error) {
                node.debug?.(`chat snapshot: inspector mode unavailable: ${error.message}`);
            }
            await enrichSnapshot(snapshot);
            if (chatSnapshots.get(snapshot.sessionId) !== snapshot) return;
            node.currentChatSnapshot = snapshot;
            sendSnapshotOutput(snapshot, 'chatStartedOrResumed', 'loaded');
        };

        const refreshCachedSnapshot = async (sessionId) => {
            const snapshot = chatSnapshots.get(sessionId);
            if (!snapshot) return;
            await enrichSnapshot(snapshot);
            if (chatSnapshots.get(sessionId) === snapshot) {
                node.currentChatSnapshot = snapshot;
            }
        };

        const scheduleSnapshotRefresh = (sessionId) => {
            if (!sessionId || !chatSnapshots.has(sessionId)) return;
            if (snapshotRefreshTimers.has(sessionId)) clearTimeout(snapshotRefreshTimers.get(sessionId));
            snapshotRefreshTimers.set(sessionId, setTimeout(() => {
                snapshotRefreshTimers.delete(sessionId);
                refreshCachedSnapshot(sessionId).catch((error) => node.debug?.(`chat snapshot refresh failed: ${error.message}`));
            }, 250));
        };

        const flushAndEmitSnapshot = async (message) => {
            const sessionId = message.sessionId || message.SessionId || currentState.sessionId;
            let snapshot = chatSnapshots.get(sessionId);
            if (!snapshot) {
                snapshot = buildBaseSnapshot(message);
            }
            if (message.chatId || message.ChatId) snapshot.chatId = message.chatId || message.ChatId;
            await enrichSnapshot(snapshot);
            sendSnapshotOutput(snapshot, 'chatClosed', 'flushed');
            node.lastChatSnapshot = snapshot;
            if (chatSnapshots.get(sessionId) === snapshot) chatSnapshots.delete(sessionId);
            if (node.currentChatSnapshot === snapshot) node.currentChatSnapshot = null;
            if (snapshotRefreshTimers.has(sessionId)) {
                clearTimeout(snapshotRefreshTimers.get(sessionId));
                snapshotRefreshTimers.delete(sessionId);
            }
        };

        const authenticate = () => {
            if (authInFlight || !node.connectionConfig?.connection) {
                return;
            }
            authInFlight = true;
            updateStatus('authenticating', 'yellow', 'ring');
            sendMessage({
                $type: 'authenticate',
                client: 'Voxta.NoxyRed',
                clientVersion: '1.0.0',
                scope: ['role:app', 'role:inspector'],
                capabilities: {
                    audioOutput: 'Url',
                    audioInput: 'WebSocketStream'
                }
            }).catch((error) => {
                authInFlight = false;
                node.error(error);
                updateStatus('auth failed', 'red', 'ring');
            });
        };

        const emitEvent = (eventName, payload) => {
            if (!matches(eventName)) {
                return;
            }

            const msg = {
                topic: eventName,
                event: eventName,
                payload,
                voxta: payload,
                sessionId: payload?.sessionId || payload?.SessionId || currentState.sessionId,
                chatId: payload?.chatId || payload?.ChatId || currentState.chatId,
                characterId: payload?.senderId || payload?.SenderId || currentState.characterId,
                voxtaState: { ...currentState }
            };

            if (node.outputMode === 'split') {
                if (eventName === 'replyChunk' || eventName === 'replyStart' || eventName === 'replyEnd' || eventName === 'replyGenerating') {
                    node.send([msg, null, null]);
                } else if (eventName === 'action' || eventName === 'appTrigger') {
                    node.send([null, msg, null]);
                } else {
                    node.send([null, null, msg]);
                }
                return;
            }

            node.send([msg, null, null]);
        };

        const onOpened = () => {
            currentState.connected = true;
            currentState.authenticated = false;
            sessionState.updateState(node.client, { connected: true, authenticated: false });
            updateStatus('connected', 'yellow', 'ring');
            authenticate();
        };

        const onError = (event) => {
            updateStatus('error', 'red', 'ring');
            node.error(event?.err || event);
        };

        const onClosed = () => {
            currentState.connected = false;
            currentState.authenticated = false;
            authInFlight = false;
            sessionState.updateState(node.client, { connected: false, authenticated: false });
            updateStatus('disconnected', 'red', 'ring');
        };

        const onReceiveMessage = (payload) => {
            if (!payload || !payload.$type) {
                return;
            }

            if (payload.$type === 'welcome') {
                authInFlight = false;
                currentState.authenticated = true;
                sessionState.updateState(node.client, { authenticated: true });
                if (currentState.sessionId && currentState.chatId) {
                    sendMessage({
                        $type: 'subscribeToChat',
                        sessionId: currentState.sessionId,
                        chatId: currentState.chatId
                    }).catch((error) => node.error(error));
                }
            } else if (payload.$type === 'chatsSessionsUpdated') {
                const first = Array.isArray(payload.sessions) ? payload.sessions[0] : null;
                if (first) {
                    currentState.sessionId = first.sessionId || currentState.sessionId;
                    currentState.chatId = first.chatId || currentState.chatId;
                    sessionState.updateState(node.client, {
                        sessionId: currentState.sessionId,
                        chatId: currentState.chatId
                    });
                    sendMessage({
                        $type: 'subscribeToChat',
                        sessionId: first.sessionId,
                        chatId: first.chatId
                    }).catch((error) => node.error(error));
                }
            } else if (payload.$type === 'chatStarted') {
                currentState.sessionId = payload.sessionId || currentState.sessionId;
                currentState.chatId = payload.chatId || currentState.chatId;
                const firstCharacter = Array.isArray(payload.characters) ? payload.characters[0] : null;
                currentState.characterId = firstCharacter?.id || firstCharacter?.Id || currentState.characterId;
                currentState.characterName = firstCharacter?.name || firstCharacter?.Name || currentState.characterName;
                sessionState.updateState(node.client, {
                    sessionId: currentState.sessionId,
                    chatId: currentState.chatId,
                    characterId: currentState.characterId,
                    characterName: currentState.characterName
                });
                loadAndEmitSnapshot(payload).catch((error) => node.error(`chat snapshot load failed: ${error.message}`));
            } else if (payload.$type === 'chatClosed') {
                flushAndEmitSnapshot(payload).catch((error) => node.error(`chat snapshot flush failed: ${error.message}`));
                currentState.chatId = null;
                currentState.characterId = null;
                currentState.characterName = null;
                sessionState.updateState(node.client, {
                    chatId: null,
                    characterId: null,
                    characterName: null
                });
            } else if (payload.$type === 'contextUpdated') {
                const snapshot = chatSnapshots.get(payload.sessionId || currentState.sessionId);
                if (snapshot) {
                    snapshot.situation = cloneJson(payload);
                    snapshot.promptSources.activeContext = cloneJson(payload);
                    node.currentChatSnapshot = snapshot;
                }
            } else if (payload.$type === 'replyEnd' || payload.$type === 'messageUpdated') {
                scheduleSnapshotRefresh(payload.sessionId || currentState.sessionId);
            } else if (payload.$type === 'error' && typeof payload.message === 'string' && payload.message.includes('authenticate first')) {
                authInFlight = false;
                currentState.authenticated = false;
                sessionState.updateState(node.client, { authenticated: false });
                authenticate();
            }

            const statusLabel = currentState.characterName
                ? `${payload.$type} · ${currentState.characterName}`
                : payload.$type;
            updateStatus(statusLabel, 'green', 'dot');
            emitEvent(payload.$type, payload);
        };

        node.connectionConfig.on('opened', onOpened);
        node.connectionConfig.on('erro', onError);
        node.connectionConfig.on('closed', onClosed);

        if (node.connectionConfig.connection) {
            node.connectionConfig.connection.on('ReceiveMessage', onReceiveMessage);
        }

        node.on('close', (done) => {
            if (_linkEvent && _linkHandler) { RED.events.removeListener(_linkEvent, _linkHandler); }
            if (node.connectionConfig) {
                node.connectionConfig.removeListener('opened', onOpened);
                node.connectionConfig.removeListener('erro', onError);
                node.connectionConfig.removeListener('closed', onClosed);
                if (node.connectionConfig.connection) {
                    node.connectionConfig.connection.off('ReceiveMessage', onReceiveMessage);
                }
            }
            for (const timer of snapshotRefreshTimers.values()) clearTimeout(timer);
            snapshotRefreshTimers.clear();
            chatSnapshots.clear();
            node.currentChatSnapshot = null;
            done();
        });
    }

    // Proxy: fetch characters from Voxta REST API for the editor character chip UI
    RED.httpAdmin.get('/voxta-config/characters', function (req, res) {
        const clientId = req.query.clientId;
        if (!clientId) { res.status(400).json({ error: 'Missing clientId' }); return; }
        const cc = RED.nodes.getNode(clientId);
        if (!cc) { res.status(404).json({ error: 'SignalR client not found' }); return; }
        const host = cc.host;
        const port = cc.port;
        const secure = cc.secure;
        const proto = secure ? https : http;
        const options = { hostname: host, port: port, path: '/api/characters', method: 'GET', headers: { 'Accept': 'application/json' } };
        if (secure) options.rejectUnauthorized = false;
        const r = proto.request(options, function (resp) {
            let body = '';
            resp.on('data', function (c) { body += c; });
            resp.on('end', function () {
                if (resp.statusCode >= 200 && resp.statusCode < 300) {
                    try {
                        const d = JSON.parse(body);
                        const chars = (d.characters || d || []).map(function (c) {
                            return { id: c.id, name: c.name, notes: c.creatorNotes || "" };
                        });
                        res.json(chars);
                    } catch (e) { res.status(502).json({ error: 'Invalid JSON from Voxta' }); }
                } else { res.status(resp.statusCode).json({ error: 'Voxta returned ' + resp.statusCode }); }
            });
        });
        r.on('error', function (err) { res.status(503).json({ error: 'Cannot reach Voxta: ' + err.message }); });
        r.end();
    });

RED.nodes.registerType('config', VoxtaEventsNode);
};
