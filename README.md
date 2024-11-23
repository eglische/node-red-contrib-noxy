# node-red-contrib-noxy

A collection of custom Node-RED nodes designed for easy integration between **Voxta** and Node-RED. This pack includes:

1. **Voxta Actions**: Register actions with Voxta.
2. **Voxta Messages**: Send messages to Voxta.
3. **Voxta Keys**: Send VK formatted instructions for triggering local keystrokes.
4. **Noxy Sequencer**: Create a sequence of events with or without fixed or random delays that can be stopped and reset at any time

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

### 4. Noxy Sequencer

The **Noxy Sequencer** node is designed to sequentially execute a series of actions with optional delays, providing a simple yet powerful way to automate tasks in a defined order. It is particularly useful for applications requiring a timed sequence of operations, such as controlling devices, triggering multiple actions, or introducing delays between outputs.
Features:

**Sequential Execution:** The node processes each element in the defined sequence, executing them one by one, until the end is reached.

**Configurable** Elements:
- **Output Action:** Sends a specified message to the output. Each "output" action creates a corresponding output port.
- You can configure the output type as a string, number, boolean, or JSON.
- The value to be sent can also be customized, making it flexible for various use cases.

- **Delay Action:** Introduces a delay before moving on to the next action.
- The delay can be fixed (e.g., 3 seconds) or set to a random range (e.g., between 2 and 5 seconds).
- Time units available are milliseconds (ms), seconds (s), or minutes (min).

**Stop Functionality:**
- If the sequencer receives a message payloada of "stop!", the current sequence is immediately terminated, and the node resets to the beginning.
- This is useful for stopping a sequence mid-execution, effectively resetting the state.

**Visual Representation:** Each sequence element (output or delay) can be added, edited, or reordered visually. The interface allows easy dragging and dropping of elements to arrange the sequence as desired.

**Live Status Feedback:** The node provides real-time status updates, such as:
- "Executing Index X": Indicates the current element being processed.
- "Wait for X ms": Shows the remaining delay before moving to the next action.
- "Stopped": Displays when the sequence has been stopped due to a "stop!" message.
- "Sequence completed": Indicates that all sequence elements have been processed.

## Installation

To install the node-red-contrib-noxy in Node-RED:

```sh
cd ~/.node-red
npm install node-red-contrib-voxta
