# node-red-contrib-noxy-v2

Node-RED nodes for controlling and extending [Voxta](https://voxta.ai/) directly. Version 2 connects to Voxta over its REST API and SignalR hub: it does **not** require the now obsolete Noxy-Red route anylonger and can directly connect to Voxta.

Use it to create and subscribe to chats, send messages, react to Voxta events, manage actions and context, switch services, and add a separate AI “director” to an active conversation.

## Requirements

- Node.js 18 or later.
- Node-RED 3 or later.
- A running Voxta server.
- A configured `signalr-client` node that can connect to the Voxta server. Every Voxta node in this package uses the same client configuration.

## Install Node-RED and this package

Install a supported current-LTS version of Node.js before installing Node-RED. The Node-RED editor is then available at [http://localhost:1880](http://localhost:1880) after starting the runtime.

### Windows

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
2. Open PowerShell and run:

   ```powershell
   npm install -g node-red
   node-red
   ```

3. Open `http://localhost:1880` in a browser.

### macOS

1. Install Node.js LTS from [nodejs.org](https://nodejs.org/) or your preferred package manager.
2. In Terminal, run:

   ```bash
   npm install -g node-red
   node-red
   ```

3. Open `http://localhost:1880` in a browser.

### Linux

1. Install Node.js LTS using your distribution's supported method.
2. In a terminal, run:

   ```bash
   sudo npm install -g node-red
   node-red
   ```

3. Open `http://localhost:1880` in a browser. On a server, replace `localhost` with that server's address if the Node-RED editor has been configured for network access.

### Install from the Palette Manager (after npm publication)

Once `node-red-contrib-noxy-v2` is published to npm, install it from the Node-RED editor:

1. Open the editor menu (top right) and select **Manage palette**.
2. Select the **Install** tab.
3. Search for `node-red-contrib-noxy-v2`.
4. Select **Install**, then restart Node-RED if prompted or after the installation completes.

The package will then appear in the **Voxta** category of the node palette.

> This v2 branch is not yet published to npm, so it will not appear in Palette Manager search yet. For development or pre-release use, install it from a local checkout in Node-RED's user directory (normally `~/.node-red`) and restart Node-RED:
>
> ```bash
> npm install /absolute/path/to/node-red-contrib-noxy
> ```

## Voxta network setup

When Node-RED and Voxta run on the same machine, the normal Voxta localhost binding is sufficient.

When Node-RED runs on another machine on the LAN, Voxta must listen on the network interface. Edit Voxta's `appsettings.json` and change the host binding from:

```text
http://localhost:5384
```

to:

```text
http://0.0.0.0:5384
```

Restart Voxta after changing the setting, then configure the SignalR client with the Voxta host, port, protocol, and any authentication that your Voxta installation requires.

Opening the listener to the LAN is not the same as making it public. Still, protect Voxta access: set a password or pre-authorize the Node-RED host, and do not expose the Voxta port to untrusted networks.

## Getting started

1. Add and configure the shared `signalr-client` node for your Voxta server.
2. Add a **Config** node and select that client. It establishes the event stream and maintains the current session state used by the other nodes.
3. Start or resume a chat in Voxta, or use an **API** node configured for **Start chat**.
4. Connect a **Messages**, **Actions**, **Context**, or **Director** node to the same client as needed.

For a flow that starts its own conversation, connect an Inject node to an API node configured with the **Start chat** action. Its output includes both `chatId` and `sessionId`; pass that message onward, or pass `msg.sessionId`, to target that exact session.

## Start a chat from a flow

Choose **Start chat** in the API node. A payload may identify a character or scenario by its display name or UUID. The node creates the chat through Voxta's REST API, resumes it through SignalR, waits for `chatStarted`, and subscribes to the resulting session. The subscription is important: without it, the chat may be created but Node-RED will not remain attached to its event stream.

Start a character chat:

```json
{
  "targetType": "character",
  "target": "Voxta"
}
```

Start a scenario chat:

```json
{
  "targetType": "scenario",
  "target": "My scenario"
}
```

Optional properties are `characters` (additional character names or UUIDs), `roles` (a role-to-character map), `contexts`, `actions`, `flags`, `client`, `ephemeral`, and `timeoutMs`. For a scenario whose default roles do not provide a character, supply `characters` or `roles` explicitly.

The successful output replaces `msg.payload` with a result like:

```json
{
  "action": "startChat",
  "chatId": "<chat UUID>",
  "sessionId": "<session UUID>",
  "targetType": "character",
  "target": "Voxta"
}
```

Use the returned `sessionId` for follow-up messages when a flow can handle more than one chat. Nodes otherwise use the currently active session maintained by the shared client.

## Nodes

| Node | What it does |
| --- | --- |
| **Config** | Connects to Voxta through the shared SignalR client and routes live Voxta events. Outputs can be split into chat/reply events, actions/app triggers, and other events, or combined into one stream. Its fourth output emits complete `noxy.chat-snapshot.v1` snapshots when a chat starts, resumes, or closes. |
| **API** | Performs Voxta control operations: start and subscribe to a chat, toggle a service, mute or unmute the microphone, and switch a service module or preset. Service/module/preset changes use REST; chat lifecycle and microphone control use SignalR. |
| **Messages** | Sends text or commands into a selected Voxta session. It supports named preset messages, short references, `next`, `previous`, `random`, multi-line sends, and direct text. Supply `msg.sessionId` to address a particular chat. |
| **Actions** | Registers and updates AI-triggerable Voxta actions for the active session. Actions can be added, removed, grouped, filtered by character, auto-injected, assigned cooldowns, or connected to Node-RED dashboard widgets. Triggered actions can drive a flow, a widget, or both. |
| **Context** | Adds, disables, replaces, and removes chat context. Send a configured name/group, or dynamic JSON. Context can be filtered by character and can expire after a time or a number of assistant replies. |
| **Director** | Runs a separate inference against the cached complete chat snapshot and writes the result into a persistent Voxta context slot. It can use Voxta TextGen/Action Inference/Summarization or an OpenAI-compatible endpoint directly. `[KEEP]` leaves the existing direction unchanged. |
| **Link** | Relays one input message to one or more enabled Noxy nodes while also passing it through. It is useful for calling several Actions, Context, API, or other nodes from one place in a flow. |
| **Sequencer** | A standalone timed sequence node; it is not Voxta-specific. It emits configured output steps separated by fixed or random delays. Send `stop!` to stop and reset the current sequence. |

## Session-aware flows and concurrent chats

Voxta identifies an active conversation by `sessionId`. The API node returns it after starting a chat, and the Config node includes it in lifecycle/event data. Preserve that field through your flow and set `msg.sessionId` before sending messages, actions, or context to keep each support request isolated.

The shared client maintains a convenient current-session fallback, but a multi-chat flow should always carry the explicit `sessionId`. This prevents a later chat-start event from redirecting work intended for an earlier chat.

## Input notes

- **Messages:** use a string in `msg.payload`, `msg.text`, a preset reference in `msg.shortRef` / `msg.messageRef`, or an array of message lines. Set `msg.sessionId` for a specific chat.
- **Actions:** use an action, group, or layer name in `msg.payload`; use `msg.mode` or `msg.actionMode` as `add` or `remove`. Send `msg.reset: true` to clear this node's injected actions from the session.
- **Context:** send a configured context name, `group:GroupName`, or prefix/suffix the name with `!` to send it disabled. Dynamic context JSON accepts `contextKey` (or `name`) and `text`; a `contexts` array is also accepted.
- **API:** service actions accept configured values or `msg.payload` overrides. For **Start chat**, send the object shown above.

## Migration from legacy

The `legacy` branch remains the original `node-red-contrib-noxy` package. Its Noxy-Red/MQTT and virtual-key approach is not part of this v2 package. Rebuild legacy flows around the direct SignalR client, Config event stream, and `sessionId` routing rather than expecting the old node names or transport.

## License

CC BY-NC 4.0. See [LICENSE](LICENSE).
