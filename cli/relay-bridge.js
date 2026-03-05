// Relay bridge: connects to relay server for phone connectivity
// Adapted from agent/src/relay-client.js for CLI use

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export class RelayBridge extends EventEmitter {
  constructor(relayUrl, authToken) {
    super();
    this.relayUrl = relayUrl;
    this.authToken = authToken;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.shouldReconnect = true;
    this.sessionId = null;
    this.sessionToken = null;
    this.projectName = null;
    this.projectPath = null;
    this.shared = false;
    this.connected = false;
  }

  connect() {
    const url = `${this.relayUrl}/ws/agent?token=${encodeURIComponent(this.authToken)}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectDelay = 1000;
      this.connected = true;
      this.emit('connected');

      // Re-register session if it was shared
      if (this.sessionId && this.shared) {
        this._registerSession();
      }
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this._handleRelayMessage(msg);
      } catch {}
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this.ws.on('error', () => {
      // Error logged implicitly by close event
    });
  }

  createLocalSession(projectPath, projectName) {
    this.projectPath = projectPath;
    this.projectName = projectName;
    this.sessionId = randomUUID();
    this.sessionToken = randomUUID();
    return { sessionId: this.sessionId, sessionToken: this.sessionToken };
  }

  shareSession() {
    this.shared = true;
    this._registerSession();
  }

  _registerSession() {
    this._send({
      type: 'session_register',
      sessionId: this.sessionId,
      projectName: this.projectName,
      projectPath: this.projectPath,
      sessionToken: this.sessionToken,
      autoAccept: false,
    });
  }

  _handleRelayMessage(msg) {
    if (msg.type === 'user_message' && msg.sessionId === this.sessionId) {
      this.emit('phone_message', msg.content);
    } else if (msg.type === 'stop_message' && msg.sessionId === this.sessionId) {
      this.emit('phone_stop');
    } else if (msg.type === 'permission_response' && msg.sessionId === this.sessionId) {
      this.emit('phone_permission', msg.permissionId, msg.action);
    } else if (msg.type === 'set_auto_accept' && msg.sessionId === this.sessionId) {
      this.emit('phone_auto_accept', msg.autoAccept);
    } else if (msg.type === 'dismiss_question' && msg.sessionId === this.sessionId) {
      this.emit('phone_dismiss_question');
    }
  }

  // Send claude output event to phone
  sendOutput(message) {
    this._send({
      type: 'claude_output',
      sessionId: this.sessionId,
      message,
    });
  }

  sendStatus(status) {
    this._send({
      type: 'session_status',
      sessionId: this.sessionId,
      status,
    });
  }

  sendInputRequired(prompt) {
    this._send({
      type: 'input_required',
      sessionId: this.sessionId,
      prompt,
    });
  }

  _send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws && this.sessionId && this.shared) {
      this._send({ type: 'session_unregister', sessionId: this.sessionId });
    }
    if (this.ws) this.ws.close();
  }
}
