const http = require('http');
const https = require('https');
const sessionState = require('./lib-session-state');

const KEEP_TOKEN = '[KEEP]';

const DEFAULT_PROMPT = `You are the director of an ongoing Voxta chat. You have access to the complete cached chat snapshot: prompt, transcript, and current situation.

Your job is to provide short-lived steering context for the character — an emotion, thought, intention, mood shift, or direction that enriches the next reply. This is not dialogue. It is inner guidance the character can internalise.

Guidelines:
- Generate fresh context when the situation changes meaningfully: a new emotion arises, the user's intent shifts, tension escalates or resolves, or the character's focus changes.
- If the current context is still appropriate and nothing warrants a change, output exactly [KEEP] and nothing else.
- Do not repeat facts already obvious from the transcript. Do not parrot what the user said. Offer something the character would think or feel that adds depth.
- Keep it concise: one to three sentences. Plain text only. No JSON, no markdown, no headers, no labels.
- Write from the character's inner perspective or as a stage direction — whichever feels natural for the moment.`;

module.exports = function (RED) {
    function toBoolean(value, fallback = false) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }
        return value === true || value === 1 || value === '1' || value === 'true';
    }

    function positiveNumber(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function positiveInteger(value, fallback) {
        return Math.max(1, Math.floor(positiveNumber(value, fallback)));
    }

    function isConnected(connection) {
        if (!connection) {
            return false;
        }
        if (connection.state === undefined || connection.state === null) {
            return true;
        }
        return String(connection.state).toLowerCase() === 'connected';
    }

    function VoxtaDirectorNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.client = config.client || '';
        node.legacyConfigNodeId = config.configNode || '';
        node.enabled = toBoolean(config.enabled, true);
        node.prompt = String(config.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
        node.inferenceMode = String(config.inferenceMode || 'voxta').trim() || 'voxta';
        node.serviceType = String(config.serviceType || 'TextGen').trim() || 'TextGen';
        node.directEndpoint = String(config.directEndpoint || '').trim();
        node.directModel = String(config.directModel || '').trim();
        node.directApiKey = String(config.directApiKey || '').trim();
        node.maxTokens = positiveInteger(config.maxTokens, 300);
        node.timeoutSeconds = positiveNumber(config.timeoutSeconds, 60);
        node.contextKey = String(config.contextKey || 'NoxyDirector').trim() || 'NoxyDirector';
        node.contextName = String(config.contextName || 'Director').trim() || 'Director';
        node.inferOnChatStart = toBoolean(config.inferOnChatStart, true);
        node.inferOnReplyEnd = toBoolean(config.inferOnReplyEnd, true);
        node.triggerDelayMs = Math.max(0, Number(config.triggerDelayMs) || 500);

        const scheduledTriggers = new Map();
        const activeContexts = new Map();
        const inFlight = new Map();
        let sequence = 0;
        let attachedConnection = null;
        let closed = false;

        const resolveConfigNode = () => {
            const legacyNode = node.legacyConfigNodeId
                ? RED.nodes.getNode(node.legacyConfigNodeId)
                : null;
            if (legacyNode && typeof legacyNode.getChatSnapshot === 'function') {
                return legacyNode;
            }

            let matched = null;
            RED.nodes.eachNode((candidate) => {
                if (matched || candidate.type !== 'config') {
                    return;
                }
                const candidateClient = candidate.client || candidate.connection || '';
                if (candidateClient !== node.client) {
                    return;
                }
                const runtimeNode = RED.nodes.getNode(candidate.id);
                if (runtimeNode && typeof runtimeNode.getChatSnapshot === 'function') {
                    matched = runtimeNode;
                }
            });
            return matched;
        };

        const resolveConnectionConfig = () => {
            const selectedClient = node.client ? RED.nodes.getNode(node.client) : null;
            if (selectedClient) {
                return selectedClient;
            }
            const configNode = resolveConfigNode();
            return configNode?.connectionConfig || (configNode?.client ? RED.nodes.getNode(configNode.client) : null);
        };

        const resolveSessionId = (source = {}) => {
            const configNode = resolveConfigNode();
            const payload = source && typeof source.payload === 'object' ? source.payload : {};
            const direct = source.sessionId || payload.sessionId;
            if (direct) {
                return String(direct);
            }
            const clientId = node.client || configNode?.client;
            if (clientId) {
                return sessionState.getState(clientId).sessionId;
            }
            return null;
        };

        const waitForSnapshot = async (sessionId, timeoutMs = 8000) => {
            const deadline = Date.now() + timeoutMs;
            while (!closed && Date.now() <= deadline) {
                const configNode = resolveConfigNode();
                if (!configNode) {
                    throw new Error('Director cannot find a Config flow node linked to the selected Voxta client');
                }
                const snapshot = typeof configNode.getChatSnapshot === 'function'
                    ? configNode.getChatSnapshot(sessionId)
                    : configNode.currentChatSnapshot;
                if (snapshot && (!sessionId || !snapshot.sessionId || snapshot.sessionId === sessionId)) {
                    return snapshot;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`No cached chat snapshot is available${sessionId ? ` for ${sessionId}` : ''}`);
        };

        const buildGenerationRequest = (snapshot) => {
            const snapshotJson = JSON.stringify(snapshot, null, 2);
            const hasPlaceholder = node.prompt.includes('{{snapshot}}');
            const renderedPrompt = node.prompt
                .split('{{snapshot}}').join(snapshotJson)
                .split('{{sessionId}}').join(String(snapshot.sessionId || ''));
            const prompt = hasPlaceholder
                ? [{ role: 'System', value: renderedPrompt }]
                : [
                    { role: 'System', value: renderedPrompt },
                    { role: 'User', value: `Cached chat snapshot:\n${snapshotJson}` }
                ];
            return {
                serviceType: node.serviceType,
                maxTokens: node.maxTokens,
                prompt
            };
        };

        const interpretResult = (rawText) => {
            const text = String(rawText || '').trim();
            if (!text) {
                return { keep: true, text: '' };
            }
            if (text === KEEP_TOKEN || text === `[${KEEP_TOKEN}]`) {
                return { keep: true, text: '' };
            }
            const cleaned = text
                .replace(/^```(?:text|plain)?\s*/i, '')
                .replace(/\s*```$/, '')
                .trim();
            if (!cleaned || cleaned === KEEP_TOKEN || cleaned === `[${KEEP_TOKEN}]`) {
                return { keep: true, text: '' };
            }
            return { keep: false, text: cleaned };
        };

        const requestDirectGeneration = (promptMessages, onRequest) => new Promise((resolve, reject) => {
            const endpoint = node.directEndpoint;
            if (!endpoint) {
                reject(new Error('Direct OpenAI endpoint is not configured'));
                return;
            }
            let parsedUrl;
            try {
                parsedUrl = new URL(endpoint);
            } catch {
                reject(new Error(`Invalid direct endpoint URL: ${endpoint}`));
                return;
            }
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const messages = promptMessages.map((msg) => ({
                role: String(msg.role || 'system').toLowerCase(),
                content: msg.value || msg.text || ''
            }));
            const body = JSON.stringify({
                model: node.directModel || undefined,
                messages,
                max_tokens: node.maxTokens,
                stream: true,
                temperature: 0.8
            });
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            if (node.directApiKey) {
                headers['Authorization'] = `Bearer ${node.directApiKey}`;
            }
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname.replace(/\/$/, '') + '/chat/completions',
                method: 'POST',
                headers
            };

            const request = transport.request(options, (response) => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    let errorBody = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => { errorBody += chunk; });
                    response.on('end', () => reject(new Error(`Direct endpoint returned HTTP ${response.statusCode}: ${errorBody.slice(0, 500)}`)));
                    return;
                }

                response.setEncoding('utf8');
                let buffer = '';
                let generatedText = '';
                let inThinking = false;
                // Build tags at runtime to avoid character mangling in source
                const OPEN_THINK = String.fromCharCode(60, 116, 104, 105, 110, 107, 62);
                const CLOSE_THINK = String.fromCharCode(60, 47, 116, 104, 105, 110, 107, 62);

                const consumeEvent = (block) => {
                    const data = block
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trimStart())
                        .join('\n')
                        .trim();
                    if (!data || data === '[DONE]') {
                        return;
                    }
                    let event;
                    try {
                        event = JSON.parse(data);
                    } catch (error) {
                        throw new Error(`Invalid SSE payload from direct endpoint: ${data.slice(0, 300)}`);
                    }
                    if (event.error) {
                        const msg = typeof event.error === 'string' ? event.error : (event.error.message || JSON.stringify(event.error));
                        throw new Error(`Direct endpoint error: ${msg}`);
                    }
                    const delta = event.choices?.[0]?.delta;
                    if (delta && typeof delta.content === 'string') {
                        let chunk = delta.content;
                        // Strip <think>...</think> blocks from thinking models
                        while (chunk.length > 0) {
                            if (inThinking) {
                                const closeIdx = chunk.indexOf(CLOSE_THINK);
                                if (closeIdx === -1) {
                                    // Entire chunk is inside thinking — discard
                                    break;
                                }
                                // Skip past closing tag
                                chunk = chunk.slice(closeIdx + CLOSE_THINK.length);
                                inThinking = false;
                            } else {
                                const openIdx = chunk.indexOf(OPEN_THINK);
                                if (openIdx === -1) {
                                    generatedText += chunk;
                                    break;
                                }
                                // Keep text before <think>
                                generatedText += chunk.slice(0, openIdx);
                                chunk = chunk.slice(openIdx + OPEN_THINK.length);
                                inThinking = true;
                            }
                        }
                    }
                };

                response.on('data', (chunk) => {
                    buffer += chunk;
                    const blocks = buffer.split(/\r?\n\r?\n/);
                    buffer = blocks.pop() || '';
                    try {
                        blocks.forEach(consumeEvent);
                    } catch (error) {
                        request.destroy(error);
                    }
                });
                response.on('end', () => {
                    try {
                        if (buffer.trim()) {
                            consumeEvent(buffer);
                        }
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    const result = generatedText.trim();
                    if (!result) {
                        reject(new Error('Direct endpoint returned no usable text'));
                        return;
                    }
                    resolve(result);
                });
                response.on('error', reject);
            });

            onRequest(request);
            request.setTimeout(Math.round(node.timeoutSeconds * 1000), () => {
                request.destroy(new Error(`Direct endpoint timed out after ${node.timeoutSeconds}s`));
            });
            request.on('error', reject);
            request.write(body);
            request.end();
        });
        const requestGeneration = (body, onRequest) => new Promise((resolve, reject) => {
            const connectionConfig = resolveConnectionConfig();
            if (!connectionConfig?.host || !connectionConfig?.port) {
                reject(new Error('Director cannot resolve the Voxta HTTP endpoint from the selected Voxta client'));
                return;
            }

            const transport = connectionConfig.secure ? https : http;
            const encoded = JSON.stringify(body);
            const options = {
                hostname: connectionConfig.host,
                port: connectionConfig.port,
                path: '/api/text/generate',
                method: 'POST',
                headers: {
                    Accept: 'text/event-stream',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(encoded)
                }
            };
            if (connectionConfig.secure) {
                options.rejectUnauthorized = false;
            }

            const request = transport.request(options, (response) => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    let errorBody = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => { errorBody += chunk; });
                    response.on('end', () => reject(new Error(`Voxta text generation returned HTTP ${response.statusCode}: ${errorBody.slice(0, 500)}`)));
                    return;
                }

                response.setEncoding('utf8');
                let buffer = '';
                let generatedText = '';

                const consumeEvent = (block) => {
                    const data = block
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trimStart())
                        .join('\n')
                        .trim();
                    if (!data || data === '[DONE]') {
                        return;
                    }
                    let event;
                    try {
                        event = JSON.parse(data);
                    } catch (error) {
                        throw new Error(`Invalid SSE payload from Voxta: ${data.slice(0, 300)}`);
                    }
                    if (event.error) {
                        const msg = typeof event.error === 'string' ? event.error : (event.error.message || JSON.stringify(event.error));
                        throw new Error(`Voxta backend error: ${msg}`);
                    }
                    if (!event.thinking && typeof event.text === 'string') {
                        generatedText += event.text;
                    }
                };

                response.on('data', (chunk) => {
                    buffer += chunk;
                    const blocks = buffer.split(/\r?\n\r?\n/);
                    buffer = blocks.pop() || '';
                    try {
                        blocks.forEach(consumeEvent);
                    } catch (error) {
                        request.destroy(error);
                    }
                });
                response.on('end', () => {
                    try {
                        if (buffer.trim()) {
                            consumeEvent(buffer);
                        }
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    const result = generatedText.trim();
                    if (!result) {
                        reject(new Error('Voxta text generation returned no usable text'));
                        return;
                    }
                    resolve(result);
                });
                response.on('error', reject);
            });

            onRequest(request);
            request.setTimeout(Math.round(node.timeoutSeconds * 1000), () => {
                request.destroy(new Error(`Voxta text generation timed out after ${node.timeoutSeconds}s`));
            });
            request.on('error', reject);
            request.write(encoded);
            request.end();
        });

        const waitForConnection = async (timeoutMs = 5000) => {
            const deadline = Date.now() + timeoutMs;
            while (!closed && Date.now() <= deadline) {
                const connection = resolveConnectionConfig()?.connection;
                if (isConnected(connection) && typeof connection.invoke === 'function') {
                    return connection;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error('Director SignalR connection is not ready');
        };

        const sendContext = async (payload) => {
            const connection = await waitForConnection();
            await connection.invoke('SendMessage', payload);
        };

        const clearActiveContext = (sessionId) => {
            const active = activeContexts.get(sessionId);
            activeContexts.delete(sessionId);
            return active;
        };

        const disableActiveContext = async (sessionId, reason) => {
            const active = clearActiveContext(sessionId);
            if (!active) {
                return;
            }
            await sendContext({
                $type: 'updateContext',
                sessionId,
                contextKey: active.contextKey,
                contexts: [{
                    name: active.contextName,
                    text: active.text,
                    disabled: true
                }]
            });
            node.status({ fill: 'grey', shape: 'dot', text: `cleared (${reason})` });
        };

        const injectDirection = async (sessionId, text) => {
            const previous = clearActiveContext(sessionId);
            const payload = {
                $type: 'updateContext',
                sessionId,
                contextKey: node.contextKey,
                contexts: [{
                    name: node.contextName,
                    text,
                    disabled: false
                }]
            };
            await sendContext(payload);

            activeContexts.set(sessionId, {
                sessionId,
                contextKey: node.contextKey,
                contextName: node.contextName,
                text
            });
            return payload;
        };

        const runInference = async (source = {}, trigger = 'input') => {
            if (!node.enabled) {
                node.status({ fill: 'grey', shape: 'ring', text: 'disabled' });
                return null;
            }
            const sessionId = resolveSessionId(source);
            if (!sessionId) {
                throw new Error('Director requires an active session ID');
            }

            const snapshot = await waitForSnapshot(sessionId);
            const token = ++sequence;
            const previous = inFlight.get(sessionId);
            if (previous?.request) {
                previous.request.destroy(new Error('Director inference superseded'));
            }

            node.status({ fill: 'yellow', shape: 'dot', text: 'inferring' });
            let requestHandle = null;
            const genRequest = buildGenerationRequest(snapshot);
            const generation = node.inferenceMode === 'direct'
                ? requestDirectGeneration(genRequest.prompt, (request) => {
                    requestHandle = request;
                    inFlight.set(sessionId, { token, request });
                })
                : requestGeneration(genRequest, (request) => {
                    requestHandle = request;
                    inFlight.set(sessionId, { token, request });
                });

            let rawText;
            try {
                rawText = await generation;
            } catch (error) {
                if (inFlight.get(sessionId)?.token !== token) {
                    return null;
                }
                inFlight.delete(sessionId);
                throw error;
            }
            if (inFlight.get(sessionId)?.token !== token || requestHandle === null) {
                return null;
            }
            inFlight.delete(sessionId);

            const result = interpretResult(rawText);

            if (result.keep) {
                node.status({ fill: 'blue', shape: 'dot', text: 'context kept' });
                const output = {
                    payload: null,
                    topic: 'director',
                    sessionId,
                    director: {
                        trigger,
                        action: 'keep',
                        serviceType: node.serviceType,
                        contextKey: node.contextKey,
                        contextName: node.contextName
                    }
                };
                node.send(output);
                return output;
            }

            const contextUpdate = await injectDirection(sessionId, result.text);
            node.status({ fill: 'green', shape: 'dot', text: 'context injected' });
            const output = {
                payload: result.text,
                topic: 'director',
                sessionId,
                director: {
                    trigger,
                    action: 'replace',
                    serviceType: node.serviceType,
                    contextKey: node.contextKey,
                    contextName: node.contextName
                },
                contextUpdate
            };
            node.send(output);
            return output;
        };

        const scheduleInference = (sessionId, trigger) => {
            const existing = scheduledTriggers.get(sessionId);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                scheduledTriggers.delete(sessionId);
                runInference({ sessionId }, trigger).catch((error) => {
                    node.status({ fill: 'red', shape: 'ring', text: 'inference failed' });
                    node.error(error);
                });
            }, node.triggerDelayMs);
            scheduledTriggers.set(sessionId, timer);
        };

        const onReceiveMessage = (payload) => {
            if (!payload?.$type) {
                return;
            }
            const sessionId = resolveSessionId(payload);
            if (payload.$type === 'chatClosed') {
                if (sessionId) {
                    const scheduled = scheduledTriggers.get(sessionId);
                    if (scheduled) clearTimeout(scheduled);
                    scheduledTriggers.delete(sessionId);
                    clearActiveContext(sessionId);
                    const activeRequest = inFlight.get(sessionId)?.request;
                    if (activeRequest) activeRequest.destroy(new Error('Chat closed'));
                    inFlight.delete(sessionId);
                }
                return;
            }
            if (!node.enabled || !sessionId) {
                return;
            }
            if (payload.$type === 'replyEnd') {
                if (node.inferOnReplyEnd && !closed) {
                    scheduleInference(sessionId, 'replyEnd');
                }
            } else if (payload.$type === 'chatStarted' && node.inferOnChatStart) {
                scheduleInference(sessionId, 'chatStarted');
            }
        };

        const attachListener = () => {
            const connection = resolveConnectionConfig()?.connection;
            if (!connection || connection === attachedConnection) {
                return;
            }
            if (attachedConnection?.off) {
                attachedConnection.off('ReceiveMessage', onReceiveMessage);
            } else if (attachedConnection?.removeListener) {
                attachedConnection.removeListener('ReceiveMessage', onReceiveMessage);
            }
            attachedConnection = connection;
            attachedConnection.on('ReceiveMessage', onReceiveMessage);
        };

        attachListener();
        const listenerTimer = setInterval(attachListener, 1000);
        node.status(node.enabled
            ? { fill: 'green', shape: 'ring', text: 'ready' }
            : { fill: 'grey', shape: 'ring', text: 'disabled' });

        node.on('input', async (msg, send, done) => {
            try {
                await runInference(msg, 'input');
                done();
            } catch (error) {
                node.status({ fill: 'red', shape: 'ring', text: 'inference failed' });
                done(error);
            }
        });

        node.on('close', (done) => {
            closed = true;
            clearInterval(listenerTimer);
            for (const timer of scheduledTriggers.values()) clearTimeout(timer);
            scheduledTriggers.clear();
            activeContexts.clear();
            for (const entry of inFlight.values()) {
                if (entry.request) entry.request.destroy(new Error('Director node closed'));
            }
            inFlight.clear();
            if (attachedConnection?.off) {
                attachedConnection.off('ReceiveMessage', onReceiveMessage);
            } else if (attachedConnection?.removeListener) {
                attachedConnection.removeListener('ReceiveMessage', onReceiveMessage);
            }
            attachedConnection = null;
            done();
        });
    }

    RED.nodes.registerType('director', VoxtaDirectorNode);
};
