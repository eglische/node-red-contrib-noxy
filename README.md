# node-red-contrib-noxy

A collection of custom Node-RED nodes designed for easy integration between **Voxta**, **Noxy-Red**, and Node-RED. This pack includes:

1. **Voxta Actions**: Register actions with Voxta.
2. **Voxta Messages**: Send messages to Voxta.
3. **Voxta Keys**: Send VK formatted instructions for triggering local keystrokes.

## Overview

This package provides a set of nodes that enable seamless integration of **Voxta** logic into **Node-RED**, allowing users to graphically create and manage actions, messages, and keystroke events. When combined with **Noxy-Red**, these nodes facilitate rich interactions between **Voxta** and the local system through MQTT.

### Key Components
- **Noxy-Red** handles MQTT in/out connections between Voxta and Node-RED using `noxy-red.api`.
- **Voxta Nodes** (Actions, Messages, Keys) provide an intuitive graphical interface for managing various functionalities and logic.

## Nodes in This Pack

### 1. Voxta Actions
The **Voxta Actions** node allows users to register actions with Voxta, such as commands to be executed at various stages of a conversation.

- **Action Registration**: Add, modify, or remove actions.
- **Default Values**: Choose from common action triggers like "AfterUserMessage", "BeforeAssistantMessage", etc.
- **Multi-Select for Arrays**: Add multiple options for actions, including dynamic add/remove functionality.
  
For more details on actions, refer to [Voxta Actions Documentation](https://doc.voxta.ai/docs/actions/).

### 2. Voxta Messages
The **Voxta Messages** node allows users to send text messages back to Voxta from within Node-RED.

- **Message Types**: Send back user-defined messages, which Voxta can process.
- **Short References**: Use short references for easy recall and linking of multiple messages.

For detailed information about messages, see the [Voxta Messages Documentation](https://doc.voxta.ai/docs/messages/).

### 3. Voxta Keys
The **Voxta Keys** node is used to send VK (Virtual Key) formatted instructions to `noxy-red.api` to trigger keystrokes on the machine running **Noxy-Red**. This is especially useful for triggering local system interactions based on inputs to Voxta.

- **Virtual Key Mapping**: Map incoming text or number payloads to virtual keys, including modifier keys (`CTRL`, `ALT`, `SHIFT`).
- **Use Case**: Ideal for simulation games or automation environments where inputs need to trigger specific keystrokes.

## Installation

To install the node-red-contrib-noxy in Node-RED:

```sh
cd ~/.node-red
npm install node-red-contrib-voxta
