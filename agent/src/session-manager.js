import { randomUUID, randomBytes } from 'crypto';
import { ClaudeBridge } from './claude.js';

export class SessionManager {
  constructor(relayClient) {
    this.sessions = new Map();
    this.relayClient = relayClient;
    this.onLocalBroadcast = null; // Set by index.js for VSCode extension WS

    // Listen for messages from relay (user input from mobile)
    relayClient.on('message', (msg) => {
      if (msg.type === 'user_message') {
        this.handleUserMessage(msg.sessionId, msg.content, false);
      }
    });
  }

  // Broadcast to both relay (mobile) and local WebSocket (VSCode extension)
  broadcast(sessionId, message) {
    this.relayClient.sendClaudeOutput(sessionId, message);
    this.localBroadcast({
      type: 'claude_output',
      sessionId,
      message,
    });
  }

  localBroadcast(message) {
    if (this.onLocalBroadcast) {
      this.onLocalBroadcast(message);
    }
  }

  createSession(projectPath, projectName) {
    const sessionId = randomUUID();
    const sessionToken = randomBytes(32).toString('base64url');
    const claude = new ClaudeBridge(projectPath);

    const session = {
      id: sessionId,
      sessionToken,
      projectPath,
      projectName,
      claude,
      status: 'idle',
    };

    // Wire up Claude events to both relay AND local VSCode clients
    claude.on('output', (output) => {
      this.broadcast(sessionId, output);
    });

    claude.on('status', (status) => {
      session.status = status;
      this.relayClient.sendStatus(sessionId, status);
      this.localBroadcast({
        type: 'session_status',
        sessionId,
        status,
      });
    });

    claude.on('input_required', (data) => {
      session.status = 'input_required';
      this.relayClient.sendInputRequired(sessionId, data.prompt);
      this.localBroadcast({
        type: 'input_required',
        sessionId,
        prompt: data.prompt,
      });
    });

    claude.on('done', ({ code }) => {
      console.log(`[Session ${sessionId}] Claude finished (code: ${code})`);
    });

    this.sessions.set(sessionId, session);

    // Register with relay
    this.relayClient.registerSession(sessionId, projectName, projectPath, sessionToken);

    // Notify local VSCode clients
    this.localBroadcast({
      type: 'sessions_updated',
      sessions: this.getAllSessions(),
    });

    console.log(`[Session] Created: ${sessionId} for "${projectName}" at ${projectPath}`);
    return session;
  }

  async handleUserMessage(sessionId, content, fromLocal = false) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[Session] Unknown session: ${sessionId}`);
      return;
    }

    console.log(`[Session ${sessionId}] User message (from ${fromLocal ? 'local' : 'relay'}): ${content.substring(0, 100)}`);

    const userMsg = {
      role: 'user',
      content,
      timestamp: Date.now(),
    };

    if (fromLocal) {
      // VSCode-originated: send to both relay (so PWA sees it) and local WS
      this.broadcast(sessionId, userMsg);
    } else {
      // Relay-originated: relay already broadcast to PWA clients, just notify local VSCode
      this.localBroadcast({
        type: 'claude_output',
        sessionId,
        message: userMsg,
      });
    }

    try {
      await session.claude.sendMessage(content);
    } catch (err) {
      console.error(`[Session ${sessionId}] Claude error:`, err.message);
      const errorMsg = { type: 'error', content: `Error: ${err.message}` };
      this.relayClient.sendClaudeOutput(sessionId, errorMsg);
      this.localBroadcast({
        type: 'claude_output',
        sessionId,
        message: errorMsg,
      });
    }
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.claude.abort();
      this.relayClient.unregisterSession(sessionId);
      this.sessions.delete(sessionId);
      this.localBroadcast({
        type: 'sessions_updated',
        sessions: this.getAllSessions(),
      });
      console.log(`[Session] Removed: ${sessionId}`);
    }
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({
        id,
        projectName: session.projectName,
        projectPath: session.projectPath,
        sessionToken: session.sessionToken,
        status: session.status,
      });
    }
    return list;
  }
}
