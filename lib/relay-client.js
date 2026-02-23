import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class RelayClient extends EventEmitter {
  constructor(relayUrl, authToken) {
    super();
    this.relayUrl = relayUrl;
    this.authToken = authToken;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.shouldReconnect = true;
  }

  connect() {
    const url = `${this.relayUrl}/ws/agent?token=${encodeURIComponent(this.authToken)}`;
    console.log(`[Relay] Connecting to ${this.relayUrl}...`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[Relay] Connected');
      this.reconnectDelay = 1000;
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this.emit('message', msg);
      } catch {
        console.error('[Relay] Invalid message received');
      }
    });

    this.ws.on('close', () => {
      console.log('[Relay] Disconnected');
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[Relay] Error:', err.message);
    });
  }

  scheduleReconnect() {
    if (!this.shouldReconnect) return;

    console.log(`[Relay] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        this.maxReconnectDelay
      );
      this.connect();
    }, this.reconnectDelay);
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  registerSession(sessionId, projectName, projectPath, sessionToken) {
    this.send({
      type: 'session_register',
      sessionId,
      projectName,
      projectPath,
      sessionToken,
    });
  }

  unregisterSession(sessionId) {
    this.send({
      type: 'session_unregister',
      sessionId,
    });
  }

  sendClaudeOutput(sessionId, message) {
    this.send({
      type: 'claude_output',
      sessionId,
      message,
    });
  }

  sendStatus(sessionId, status) {
    this.send({
      type: 'session_status',
      sessionId,
      status,
    });
  }

  sendInputRequired(sessionId, prompt) {
    this.send({
      type: 'input_required',
      sessionId,
      prompt,
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
    }
  }
}
