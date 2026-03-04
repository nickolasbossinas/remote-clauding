import { randomUUID, randomBytes } from 'crypto';
import { ClaudeBridge } from './claude.js';

export class SessionManager {
  constructor(relayClient) {
    this.sessions = new Map();
    this.relayClient = relayClient;
    this.onLocalBroadcast = null; // Set by index.js for VSCode extension WS
    this.onSessionCountChange = null; // Set by index.js for tray icon updates

    // Listen for messages from relay (user input from mobile)
    relayClient.on('message', (msg) => {
      if (msg.type === 'user_message') {
        this.handleUserMessage(msg.sessionId, msg.content, false);
      } else if (msg.type === 'stop_message') {
        this.abortSession(msg.sessionId);
      } else if (msg.type === 'permission_response') {
        this.handlePermissionResponse(msg.sessionId, msg.permissionId, msg.action);
      } else if (msg.type === 'set_auto_accept') {
        this.handleSetAutoAccept(msg.sessionId, msg.autoAccept);
      } else if (msg.type === 'dismiss_question') {
        this.handleDismissQuestion(msg.sessionId);
      }
    });
  }

  localBroadcast(message) {
    if (this.onLocalBroadcast) {
      this.onLocalBroadcast(message);
    }
  }

  createSession(projectPath, projectName, { shared = true } = {}) {
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
      autoAccept: false,
      shared,
      messageBuffer: [],
    };

    // Wire up Claude events to relay (if shared) AND local VSCode clients
    claude.on('output', (output) => {
      session.messageBuffer.push(output);
      if (session.shared) this.relayClient.sendClaudeOutput(sessionId, output);
      this.localBroadcast({ type: 'claude_output', sessionId, message: output });
    });

    claude.on('status', (status) => {
      session.status = status;
      if (session.shared) this.relayClient.sendStatus(sessionId, status);
      this.localBroadcast({
        type: 'session_status',
        sessionId,
        status,
      });
    });

    claude.on('input_required', (data) => {
      session.status = 'input_required';
      if (session.shared) this.relayClient.sendInputRequired(sessionId, data.prompt);
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
    this._notifySessionCount();

    // Only register with relay if sharing to mobile
    if (shared) {
      this.relayClient.registerSession(sessionId, projectName, projectPath, sessionToken);
    }

    // Notify local VSCode clients
    this.localBroadcast({
      type: 'sessions_updated',
      sessions: this.getAllSessions(),
    });

    console.log(`[Session] Created: ${sessionId} for "${projectName}" at ${projectPath} (shared: ${shared})`);
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

    session.messageBuffer.push(userMsg);

    if (fromLocal) {
      // VSCode-originated: send to relay (if shared) and local WS
      if (session.shared) this.relayClient.sendClaudeOutput(sessionId, userMsg);
      this.localBroadcast({ type: 'claude_output', sessionId, message: userMsg });
    } else {
      // Relay-originated: relay already broadcast to PWA clients, just notify local VSCode
      this.localBroadcast({ type: 'claude_output', sessionId, message: userMsg });
    }

    try {
      await session.claude.sendMessage(content);
    } catch (err) {
      console.error(`[Session ${sessionId}] Claude error:`, err.message);
      const errorMsg = { type: 'error', content: `Error: ${err.message}` };
      if (session.shared) this.relayClient.sendClaudeOutput(sessionId, errorMsg);
      this.localBroadcast({ type: 'claude_output', sessionId, message: errorMsg });
    }
  }

  abortSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.claude.isRunning) {
      console.log(`[Session ${sessionId}] Aborting Claude execution`);
      session.claude.abort();
    }
  }

  unshareSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.shared = false;
      this.relayClient.unregisterSession(sessionId);
      console.log(`[Session] Unshared: ${sessionId}`);
    }
  }

  reshareSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.shared = true;
      this.relayClient.registerSession(sessionId, session.projectName, session.projectPath, session.sessionToken, session.autoAccept);
      // Send buffered history to relay so PWA gets full history
      if (session.messageBuffer.length > 0) {
        this.relayClient.sendMessageHistory(sessionId, session.messageBuffer);
      }
      console.log(`[Session] Re-shared: ${sessionId} (${session.messageBuffer.length} buffered messages sent)`);
    }
  }

  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.claude.abort();
      this.relayClient.unregisterSession(sessionId);
      this.sessions.delete(sessionId);
      this._notifySessionCount();
      this.localBroadcast({
        type: 'sessions_updated',
        sessions: this.getAllSessions(),
      });
      console.log(`[Session] Removed: ${sessionId}`);
    }
  }

  handlePermissionResponse(sessionId, permissionId, action) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.claude.resolvePermission(permissionId, action);
  }

  handleDismissQuestion(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.claude.dismissQuestion();
  }

  handleSetAutoAccept(sessionId, autoAccept) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.autoAccept = autoAccept;
    session.claude.setAutoAccept(autoAccept);

    // Broadcast the change to all clients for sync
    const msg = { type: 'auto_accept_changed', sessionId, autoAccept };
    if (session.shared) this.relayClient.send(msg);
    this.localBroadcast(msg);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  _notifySessionCount() {
    if (this.onSessionCountChange) {
      this.onSessionCountChange(this.sessions.size);
    }
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
        autoAccept: session.autoAccept,
      });
    }
    return list;
  }
}
