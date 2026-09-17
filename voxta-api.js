const http = require('http');
const https = require('https');
const sessionState = require('./lib-session-state');

module.exports = function (RED) {
    function VoxtaApiNode(config) {
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
        node.configId = config.configId || '';
        node.configName = config.configName || '';
        node.serviceName = config.serviceName || 'SpeechToText';
        node.action = config.action || 'toggle';
        node.moduleId = config.moduleId || '';
        node.presetId = config.presetId || '';
        node.toggleMode = config.toggleMode || 'flip';
        node.chatTargetType = config.chatTargetType || 'character';
        node.chatTarget = config.chatTarget || '';
        node.chatEphemeral = config.chatEphemeral === true || config.chatEphemeral === 'true';
        node.name = config.name || '';

        // Internal state for toggleMic (flip mode tracks current mute state)
        node._micMutedState = false;
        node._explicitMicMuted = false;

        // Cached labeled tree from SignalR configuration message
        node._cachedConfig = null;     // { configurations: [...], moduleLabels: {...} }

        node.connectionConfig = null;

        function resolveConnection() {
            if (node.connectionConfig) return node.connectionConfig;
            node.connectionConfig = RED.nodes.getNode(node.client);
            return node.connectionConfig || null;
        }

        // Derive REST endpoint from signalr-client config
        function getRestInfo() {
            const cc = resolveConnection();
            if (!cc) {
                node.status({ fill: 'red', shape: 'ring', text: 'no voxta client' });
                return null;
            }
            const host = cc.host;
            const port = cc.port;
            const secure = cc.secure;
            return { host, port, secure, proto: secure ? https : http };
        }

        function httpRequest(restInfo, method, path, body) {
            return new Promise((resolve, reject) => {
                const options = {
                    hostname: restInfo.host,
                    port: restInfo.port,
                    path: path,
                    method: method,
                    headers: {}
                };
                if (restInfo.secure) options.rejectUnauthorized = false;
                if (body) {
                    const data = JSON.stringify(body);
                    options.headers['Content-Type'] = 'application/json';
                    options.headers['Content-Length'] = Buffer.byteLength(data);
                }
                const req = restInfo.proto.request(options, (res) => {
                    let respBody = '';
                    res.on('data', (c) => respBody += c);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try { resolve(respBody ? JSON.parse(respBody) : {}); }
                            catch (e) { resolve({ _raw: respBody }); }
                        } else {
                            reject(new Error(method + ' ' + path + ' failed: ' + res.statusCode + ' ' + respBody.substring(0, 200)));
                        }
                    });
                });
                req.on('error', reject);
                if (body) req.write(JSON.stringify(body));
                req.end();
            });
        }

        function collectionItems(response, key) {
            if (Array.isArray(response)) return response;
            if (response && Array.isArray(response[key])) return response[key];
            if (response && Array.isArray(response.items)) return response.items;
            return [];
        }

        function resolveByIdOrName(items, value, kind) {
            const target = String(value || '').trim();
            if (!target) throw new Error('No ' + kind + ' target specified');
            const direct = items.find((item) => item && item.id === target);
            if (direct) return direct;
            const matches = items.filter((item) => item && typeof item.name === 'string' && item.name.toLowerCase() === target.toLowerCase());
            if (matches.length === 1) return matches[0];
            if (matches.length > 1) throw new Error('Multiple ' + kind + ' entries named "' + target + '"; use its UUID');
            throw new Error(kind + ' not found: "' + target + '"');
        }

        async function waitForChatStarted(connection, chatId, timeoutMs) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const cleanup = () => {
                    clearTimeout(timer);
                    if (connection && typeof connection.off === 'function') connection.off('ReceiveMessage', handler);
                };
                const finish = (callback, value) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    callback(value);
                };
                const handler = (payload) => {
                    if (!payload || payload.$type !== 'chatStarted' || payload.chatId !== chatId) return;
                    if (!payload.sessionId) {
                        finish(reject, new Error('Voxta started chat "' + chatId + '" without a session ID'));
                        return;
                    }
                    finish(resolve, payload);
                };
                const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for Voxta to start chat "' + chatId + '"')), timeoutMs || 15000);
                connection.on('ReceiveMessage', handler);
            });
        }

        async function executeStartChat(msgOverride) {
            const restInfo = getRestInfo();
            const cc = resolveConnection();
            if (!restInfo || !cc || !cc.connection) throw new Error('No Voxta SignalR connection available');

            const request = (msgOverride && typeof msgOverride === 'object' && !Array.isArray(msgOverride)) ? msgOverride : { target: msgOverride };
            const targetType = String(request.targetType || node.chatTargetType || 'character').toLowerCase();
            if (targetType !== 'character' && targetType !== 'scenario') throw new Error('targetType must be "character" or "scenario"');
            const target = request.target || request.targetId || request.id || node.chatTarget;

            const charactersResponse = await httpRequest(restInfo, 'GET', '/api/characters');
            const characterItems = collectionItems(charactersResponse, 'characters');
            const resolveCharacter = (value) => resolveByIdOrName(characterItems, value, 'character').id;

            let scenarioId;
            let roles = {};
            let characterIds = [];

            if (targetType === 'character') {
                characterIds.push(resolveCharacter(target));
            } else {
                const scenariosResponse = await httpRequest(restInfo, 'GET', '/api/scenarios');
                const scenarioSummary = resolveByIdOrName(collectionItems(scenariosResponse, 'scenarios'), target, 'scenario');
                const scenario = await httpRequest(restInfo, 'GET', '/api/scenarios/' + encodeURIComponent(scenarioSummary.id));
                scenarioId = scenario.id || scenarioSummary.id;
                for (const role of (scenario.roles || [])) {
                    if (role && role.enabledOnStart && role.defaultCharacterId) {
                        roles[role.name] = role.defaultCharacterId;
                    }
                }
                characterIds.push(...Object.values(roles));
            }

            const requestedCharacters = Array.isArray(request.characters) ? request.characters : [];
            characterIds.push(...requestedCharacters.map(resolveCharacter));

            if (request.roles && typeof request.roles === 'object' && !Array.isArray(request.roles)) {
                for (const [roleName, character] of Object.entries(request.roles)) {
                    roles[roleName] = resolveCharacter(character);
                }
                characterIds.push(...Object.values(roles));
            }

            characterIds = [...new Set(characterIds.filter(Boolean))];
            if (!characterIds.length) {
                throw new Error('The selected scenario has no enabled default characters. Provide msg.payload.characters or msg.payload.roles.');
            }

            const created = await httpRequest(restInfo, 'POST', '/api/chats', {
                characters: characterIds,
                roles: Object.keys(roles).length ? roles : undefined,
                scenario: scenarioId,
                client: request.client || 'Voxta.NoxyRed',
                ephemeral: request.ephemeral === undefined ? node.chatEphemeral : request.ephemeral === true
            });
            const chatId = created && created.id;
            if (!chatId) throw new Error('Voxta created a chat without returning an ID');

            const started = waitForChatStarted(cc.connection, chatId, request.timeoutMs);
            await cc.connection.invoke('SendMessage', {
                $type: 'resumeChat',
                chatId,
                contexts: Array.isArray(request.contexts) ? request.contexts : undefined,
                actions: Array.isArray(request.actions) ? request.actions : undefined,
                flags: Array.isArray(request.flags) ? request.flags : undefined
            });
            const session = await started;
            await cc.connection.invoke('SendMessage', { $type: 'subscribeToChat', sessionId: session.sessionId });

            return {
                action: 'startChat',
                targetType,
                target,
                chatId,
                sessionId: session.sessionId,
                characters: characterIds,
                scenarioId: scenarioId || null,
                ephemeral: request.ephemeral === undefined ? node.chatEphemeral : request.ephemeral === true
            };
        }

        // Listen for SignalR configuration messages to cache labels
        // PASSIVE ONLY — never send authenticate or any other message.
        // The voxta-events node handles authentication on the shared connection.
        function setupSignalRListener() {
            const cc = resolveConnection();
            if (!cc || !cc.connection) return;

            // Guard against double-registration on reconnect
            if (node._listenerRegistered) return;
            node._listenerRegistered = true;

            cc.connection.on('ReceiveMessage', function (payload) {
                if (!payload || !payload.$type) return;

                // Only cache configuration messages — ignore everything else
                if (payload.$type !== 'configuration') return;

                // Cache the labeled tree
                const configurations = (payload.configurations || []).map(function (c) {
                    return { id: c.id, name: c.name, services: c.services || {} };
                });

                const moduleLabels = {};
                const svcDefs = payload.services || {};
                Object.keys(svcDefs).forEach(function (sname) {
                    moduleLabels[sname] = {};
                    (svcDefs[sname] || []).forEach(function (mod) {
                        const presets = (mod.serviceSettingsList || []).map(function (p) {
                            return { id: p.id, label: p.label || p.defaultLabel || p.id.substring(0, 8) };
                        });
                        moduleLabels[sname][mod.id] = {
                            label: mod.userLabel || mod.name || mod.id.substring(0, 8),
                            serviceName: mod.name || '',
                            presets: presets
                        };
                    });
                });

                node._cachedConfig = { configurations: configurations, moduleLabels: moduleLabels };
                node.status({ fill: 'green', shape: 'dot', text: node.serviceName || 'ready' });
            });
        }

        // Wait for connection, then setup passive listener (listen only, never send)
        function waitForConnection() {
            const cc = resolveConnection();
            if (!cc) {
                node.status({ fill: 'grey', shape: 'ring', text: 'waiting for client...' });
                setTimeout(waitForConnection, 2000);
                return;
            }
            if (cc.connection) {
                setupSignalRListener();
            }
            // On reconnect, the signalr-client creates a NEW connection object,
            // so we need to re-register our handler. The 'opened' event fires on each reconnect.
            cc.on('opened', function () {
                node._listenerRegistered = false;
                setupSignalRListener();
            });
        }

        waitForConnection();
        node.status({ fill: 'grey', shape: 'ring', text: 'connecting...' });

        // Toggle microphone mute via SignalR (server-side state, not REST)
        async function executeToggleMic(msgOverride) {
            const cc = resolveConnection();
            if (!cc || !cc.connection) throw new Error('No SignalR connection available');
            if (!node.configId) throw new Error('No configuration ID set. Press Discover first.');

            // Get the active session ID from the shared session state
            const state = sessionState.getState(node.client);
            const sessionId = state.sessionId;
            if (!sessionId) throw new Error('No active chat session — start a chat in Voxta first');

            // Determine target muted state
            let targetMuted;
            if (node.toggleMode === 'set') {
                // Use explicit value from msg.payload (already parsed in input handler)
                targetMuted = node._explicitMicMuted;
            } else {
                // Flip mode: toggle current state
                targetMuted = !node._micMutedState;
            }

            // Do not use `toggleVoiceEnabled`: it gates chat voice and can affect TTS.
            // In Voxta 1.9.1 the actual mic button is browser-local: it calls
            // setMicMuted(), persists `audioState.micMuted` in localStorage, and calls
            // AudioInputService.setMuted(). The server exposes no matching client $type.
            throw new Error('Browser mic mute has no Voxta server $type in this version; a browser-side bridge is required.');
        }

        async function executeAction(msgOverride) {
            // toggleMic uses SignalR, not REST — no config needed
            if (node.action === 'toggleMic') {
                return await executeToggleMic(msgOverride);
            }

            // Chat lifecycle is independent of the shared service configuration.
            if (node.action === 'startChat') {
                return await executeStartChat(msgOverride);
            }

            if (!node.configId) throw new Error('No configuration ID set. Press Discover first.');
            const restInfo = getRestInfo();
            if (!restInfo) throw new Error('No Voxta client connected');

            const config = await httpRequest(restInfo, 'GET', '/api/configurations/' + node.configId);
            const svc = config.services && config.services[node.serviceName];
            if (!svc) throw new Error('Service "' + node.serviceName + '" not found');

            const result = { service: node.serviceName, configId: node.configId, configName: config.name || '', action: node.action };

            if (node.action === 'toggle') {
                const current = svc.disabled || false;
                let newVal = node.toggleMode === 'set' ? node._explicitValue : !current;
                svc.disabled = newVal;
                result.oldDisabled = current;
                result.newDisabled = newVal;
            } else if (node.action === 'switchModule') {
                // Resolve target module: from msg.payload (name or UUID) or from configured moduleId
                let targetModule = msgOverride || node.moduleId;
                if (!targetModule) throw new Error('No module specified (set in node or send in msg.payload)');

                // If it's a UUID that exists in modules, use directly
                if (svc.modules && svc.modules[targetModule]) {
                    // UUID match — keep existing preset
                } else {
                    // Try to match by label/name using cached config
                    const resolved = resolveModuleName(node.serviceName, targetModule, svc);
                    if (!resolved) throw new Error('Module not found: "' + targetModule + '" in ' + node.serviceName);
                    targetModule = resolved;
                }

                result.oldModuleId = svc.defaultServiceId;
                svc.defaultServiceId = targetModule;
                result.newModuleId = targetModule;
            } else if (node.action === 'switchPreset') {
                // Resolve module: from msgOverride (if switching both) or from configured moduleId
                let targetModule = null;
                let targetPreset = null;

                if (typeof msgOverride === 'object' && msgOverride) {
                    targetModule = msgOverride.module || msgOverride.moduleId;
                    targetPreset = msgOverride.preset || msgOverride.presetId;
                } else if (typeof msgOverride === 'string') {
                    // String payload = preset name only, use configured module
                    targetModule = node.moduleId;
                    targetPreset = msgOverride;
                } else {
                    targetModule = node.moduleId;
                    targetPreset = node.presetId;
                }

                if (!targetModule) throw new Error('No module specified');
                if (!targetPreset) throw new Error('No preset specified (set in node or send in msg.payload)');

                // Resolve module UUID
                if (!svc.modules[targetModule]) {
                    const resolvedMod = resolveModuleName(node.serviceName, targetModule, svc);
                    if (!resolvedMod) throw new Error('Module not found: "' + targetModule + '"');
                    targetModule = resolvedMod;
                }

                const mod = svc.modules[targetModule];
                if (!mod) throw new Error('Module not found in ' + node.serviceName);

                // Resolve preset UUID
                let resolvedPreset = targetPreset;
                if (mod.serviceSettingsId !== targetPreset) {
                    // Not a direct UUID match — try name lookup
                    resolvedPreset = resolvePresetName(node.serviceName, targetModule, targetPreset);
                    if (!resolvedPreset) {
                        // If the name is "Automatic", use the existing serviceSettingsId (keep current)
                        // VoxtaCloud presets are labeled "Automatic" — switching to "Automatic" means keep the default
                        if (targetPreset.toLowerCase() === 'automatic') {
                            resolvedPreset = mod.serviceSettingsId;
                        } else {
                            throw new Error('Preset not found: "' + targetPreset + '"');
                        }
                    }
                }

                result.moduleId = targetModule;
                result.oldPresetId = mod.serviceSettingsId;
                mod.serviceSettingsId = resolvedPreset;
                result.newPresetId = resolvedPreset;
            } else {
                throw new Error('Unknown action: ' + node.action);
            }

            await httpRequest(restInfo, 'PUT', '/api/configurations/' + node.configId, config);
            return result;
        }

        // Resolve a module name to UUID using cached config
        function resolveModuleName(serviceName, nameOrId, svc) {
            // Direct UUID match
            if (svc.modules && svc.modules[nameOrId]) return nameOrId;

            // Name lookup via cached labels
            if (node._cachedConfig && node._cachedConfig.moduleLabels) {
                const svcLabels = node._cachedConfig.moduleLabels[serviceName];
                if (svcLabels) {
                    const lower = nameOrId.toLowerCase().trim();
                    for (const mid of Object.keys(svcLabels)) {
                        const info = svcLabels[mid];
                        if (info.label && info.label.toLowerCase() === lower) return mid;
                        if (info.serviceName && info.serviceName.toLowerCase() === lower) return mid;
                    }
                }
            }
            return null;
        }

        // Resolve a preset name to UUID using cached config
        function resolvePresetName(serviceName, moduleId, nameOrId) {
            // Direct UUID — check if it's a valid preset for this module
            if (node._cachedConfig && node._cachedConfig.moduleLabels) {
                const svcLabels = node._cachedConfig.moduleLabels[serviceName];
                if (svcLabels && svcLabels[moduleId]) {
                    const presets = svcLabels[moduleId].presets || [];
                    const lower = nameOrId.toLowerCase().trim();
                    // Check UUID first
                    for (const p of presets) {
                        if (p.id === nameOrId) return p.id;
                    }
                    // Name match (strip "(active)" suffix)
                    for (const p of presets) {
                        if (p.label && p.label.toLowerCase().replace(/\s*\(active\)\s*$/, '') === lower) return p.id;
                    }
                }
            }
            return null;
        }

        node.on('input', async function (msg, send, done) {
            if (node.action === 'toggle' && node.toggleMode === 'set') {
                if (typeof msg.payload === 'boolean') {
                    node._explicitValue = msg.payload;
                } else if (typeof msg.payload === 'string') {
                    const s = msg.payload.toLowerCase().trim();
                    if (s === 'true' || s === 'on' || s === 'enable' || s === '1') node._explicitValue = false;
                    else if (s === 'false' || s === 'off' || s === 'disable' || s === '0') node._explicitValue = true;
                    else { if (done) done(new Error('Invalid payload: ' + msg.payload)); return; }
                } else { if (done) done(new Error('Invalid payload type')); return; }
            }

            if (node.action === 'toggleMic' && node.toggleMode === 'set') {
                if (typeof msg.payload === 'boolean') {
                    node._explicitMicMuted = msg.payload;
                } else if (typeof msg.payload === 'string') {
                    const s = msg.payload.toLowerCase().trim();
                    if (s === 'true' || s === 'on' || s === 'mute' || s === 'muted' || s === '1') node._explicitMicMuted = true;
                    else if (s === 'false' || s === 'off' || s === 'unmute' || s === 'unmuted' || s === '0') node._explicitMicMuted = false;
                    else { if (done) done(new Error('Invalid payload: ' + msg.payload)); return; }
                } else { if (done) done(new Error('Invalid payload type for toggleMic')); return; }
            }

            try {
                // For switchModule: pass msg.payload as module name/UUID override
                // For switchPreset: pass msg.payload as preset name, or {module, preset} object
                let override = undefined;
                if (node.action === 'switchModule') {
                    override = (msg.payload !== undefined && msg.payload !== '') ? msg.payload : undefined;
                } else if (node.action === 'switchPreset') {
                    override = (msg.payload !== undefined && msg.payload !== '') ? msg.payload : undefined;
                } else if (node.action === 'startChat') {
                    override = msg.payload;
                }

                const result = await executeAction(override);
                let statusText;
                if (node.action === 'toggle') statusText = node.serviceName + ' ' + (result.newDisabled ? 'OFF' : 'ON');
                else if (node.action === 'toggleMic') statusText = 'mic ' + (result.muted ? 'MUTED' : 'UNMUTED');
                else if (node.action === 'switchModule') statusText = node.serviceName + ' module switched';
                else if (node.action === 'startChat') statusText = 'chat started';
                else statusText = node.serviceName + ' preset switched';
                node.status({ fill: 'green', shape: 'dot', text: statusText });
                msg.payload = result;
                msg.topic = 'voxta-api';
                send(msg);
                if (done) done();
            } catch (err) {
                node.error(err.message);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                msg.payload = { error: err.message, service: node.serviceName };
                msg.topic = 'voxta-api-error';
                send(msg);
                if (done) done(err);
            }
        });

        node.on('close', function () {
            if (_linkEvent && _linkHandler) { RED.events.removeListener(_linkEvent, _linkHandler); }
 node.status({}); });
    }

    RED.nodes.registerType('api', VoxtaApiNode);

    // Proxy: returns cached configuration tree for the editor discover button
    // If no cache: sends a single 'authenticate' on the shared connection to trigger
    // Voxta to re-broadcast the 'configuration' message, then waits for the cache to populate.
    RED.httpAdmin.get('/voxta-api/discover', function (req, res) {
        const clientId = req.query.clientId;
        if (!clientId) {
            res.status(400).json({ error: 'Missing clientId parameter' });
            return;
        }

        const cc = RED.nodes.getNode(clientId);
        if (!cc) {
            res.status(404).json({ error: 'SignalR client not found' });
            return;
        }

        // Find any voxta-api node that uses this client and check for cached config
        let apiNode = null;
        RED.nodes.eachNode(function (n) {
            if (n.type === 'voxta-api' && n.client === clientId) {
                const found = RED.nodes.getNode(n.id);
                if (found) apiNode = found;
            }
        });

        if (apiNode && apiNode._cachedConfig) {
            // Cache hit — return immediately
            res.json(apiNode._cachedConfig);
            return;
        }

        // No cache — finger the service: send one authenticate to trigger configuration broadcast
        if (!cc.connection) {
            res.status(503).json({ error: 'SignalR connection not established yet' });
            return;
        }

        // Send authenticate on the shared connection (must use Voxta.NoxyRed as client name — Voxta 1.7.0 rejects unknown clients)
        cc.connection.invoke('SendMessage', {
            $type: 'authenticate',
            client: 'Voxta.NoxyRed',
            clientVersion: '1.0.0',
            scope: ['role:app', 'role:inspector'],
            capabilities: { audioOutput: 'Url', audioInput: 'WebSocketStream' }
        }).catch(function (e) {
            // Ignore — the voxta-events node's auth may already be active
        });

        // Poll for cache population (the passive listener will catch the configuration message)
        let attempts = 0;
        const maxAttempts = 20; // 20 x 250ms = 5 seconds max
        const poll = setInterval(function () {
            attempts++;
            if (apiNode && apiNode._cachedConfig) {
                clearInterval(poll);
                res.json(apiNode._cachedConfig);
            } else if (attempts >= maxAttempts) {
                clearInterval(poll);
                // Fallback to REST-only discover (UUIDs, no labels)
                restDiscover(cc, res);
            }
        }, 250);
    });

    // REST-only fallback: fetches configs via HTTP, no labels
    function restDiscover(cc, res) {
        const host = cc.host;
        const port = cc.port;
        const secure = cc.secure;
        const proto = secure ? https : http;

        function fetch(path) {
            return new Promise((resolve, reject) => {
                const options = { hostname: host, port: port, path: path, method: 'GET', headers: { 'Accept': 'application/json' } };
                if (secure) options.rejectUnauthorized = false;
                const r = proto.request(options, function (resp) {
                    let body = '';
                    resp.on('data', function (c) { body += c; });
                    resp.on('end', function () {
                        if (resp.statusCode >= 200 && resp.statusCode < 300) {
                            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON')); }
                        } else { reject(new Error(path + ' returned ' + resp.statusCode)); }
                    });
                });
                r.on('error', reject);
                r.end();
            });
        }

        (async () => {
            try {
                const configsResp = await fetch('/api/configurations');
                const configs = configsResp.items || [];
                const fullConfigs = [];
                for (const c of configs) {
                    try {
                        const full = await fetch('/api/configurations/' + c.id);
                        fullConfigs.push({ id: c.id, name: c.name, services: full.services || {} });
                    } catch (e) {}
                }
                res.json({ configurations: fullConfigs, moduleLabels: {} });
            } catch (err) {
                res.status(503).json({ error: 'Discover failed: ' + err.message });
            }
        })();
    }
};
