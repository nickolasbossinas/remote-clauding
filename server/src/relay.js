import { WebSocketServer } from 'ws';
import { validateToken } from './auth.js';
import {
  createSession,
  getSession,
  getSessionByToken,
  getAllSessions,
  removeSession,
  addMessage,
  getMessages,
  updateSessionStatus,
} from './sessions.js';
import { sendNotification } from './push.js';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;
    const token = url.searchParams.get('token');

    if (pathname === '/ws/agent') {
      // Agents authenticate with global AUTH_TOKEN or per-user token
      const user = validateToken(token);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws._type = 'agent';
        ws._sessionId = null;
        ws._userId = user.id;
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/client') {
      // Clients can use global AUTH_TOKEN, per-user token, or per-session token
      let autoSubscribeSessionId = null;
      let isSessionToken = false;
      let userId = 0;

      const user = validateToken(token);
      if (user) {
        userId = user.id;
      } else {
        // Try session token
        const session = getSessionByToken(token);
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        autoSubscribeSessionId = session.id;
        isSessionToken = true;
        userId = session.userId;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        ws._type = 'client';
        ws._sessionId = autoSubscribeSessionId;
        ws._authSessionId = autoSubscribeSessionId; // original session for access checks
        ws._isSessionToken = isSessionToken;
        ws._userId = userId;
        wss.emit('connection', ws, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    console.log(`[WS] ${ws._type} connected (session: ${ws._sessionId})`);

    if (ws._type === 'agent') {
      handleAgentConnection(ws);
    } else {
      handleClientConnection(ws, wss);
    }

    ws.on('error', (err) => {
      console.error(`[WS] ${ws._type} error:`, err.message);
    });
  });

  return wss;
}

function handleAgentConnection(ws) {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'session_register': {
        const session = createSession(msg.sessionId, {
          projectName: msg.projectName,
          projectPath: msg.projectPath,
          sessionToken: msg.sessionToken,
          userId: ws._userId,
          autoAccept: msg.autoAccept ?? false,
        });
        session.agentWs = ws;
        ws._sessionId = msg.sessionId;

        // Notify mobile via push (only for shared sessions)
        if (msg.sessionToken) {
          sendNotification(
            session.userId,
            'Session Shared',
            `Claude session "${msg.projectName}" is now shared`,
            { type: 'session-shared', sessionId: msg.sessionId }
          );
        }

        // Notify connected clients about new session
        broadcastSessionsUpdated();
        break;
      }

      case 'session_unregister': {
        const unregSession = getSession(msg.sessionId);
        if (unregSession) {
          // Notify clients but keep session data (messages preserved for re-share)
          for (const clientWs of unregSession.clientWs) {
            clientWs.send(JSON.stringify({ type: 'session_closed', sessionId: msg.sessionId }));
          }
          unregSession.agentWs = null;
          unregSession.status = 'unshared';
        }
        broadcastSessionsUpdated();
        break;
      }

      case 'claude_output': {
        const message = {
          ...msg.message,
          timestamp: Date.now(),
        };
        addMessage(msg.sessionId, message);

        // Push notification for permission requests
        if (msg.message?.type === 'permission_request') {
          const session = getSession(msg.sessionId);
          if (session?.sessionToken) {
            const projectName = session.projectName || msg.sessionId;
            sendNotification(
              session.userId,
              'Permission Required',
              `${msg.message.toolName}: ${msg.message.summary || 'Approve?'}`,
              { type: 'permission-required', sessionId: msg.sessionId }
            );
          }
        }

        // Forward to all clients watching this session
        broadcastToClients(msg.sessionId, {
          type: 'claude_output',
          sessionId: msg.sessionId,
          message,
        });
        break;
      }

      case 'session_status': {
        updateSessionStatus(msg.sessionId, msg.status);
        broadcastToClients(msg.sessionId, {
          type: 'session_status',
          sessionId: msg.sessionId,
          status: msg.status,
        });

        // Also update the session list for all clients
        broadcastSessionsUpdated();
        break;
      }

      case 'input_required': {
        updateSessionStatus(msg.sessionId, 'input_required');
        const session = getSession(msg.sessionId);
        const projectName = session?.projectName || msg.sessionId;

        // Push notification for input required (only for shared sessions)
        if (session?.sessionToken) {
          sendNotification(
            session.userId,
            'Input Required',
            `Claude needs your input on "${projectName}"`,
            { type: 'input-required', sessionId: msg.sessionId }
          );
        }

        broadcastToClients(msg.sessionId, {
          type: 'input_required',
          sessionId: msg.sessionId,
          prompt: msg.prompt,
        });

        broadcastSessionsUpdated();
        break;
      }

      case 'auto_accept_changed': {
        const session = getSession(msg.sessionId);
        if (session) session.autoAccept = msg.autoAccept;
        broadcastToClients(msg.sessionId, {
          type: 'auto_accept_changed',
          sessionId: msg.sessionId,
          autoAccept: msg.autoAccept,
        });
        broadcastSessionsUpdated();
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Agent disconnected (session: ${ws._sessionId})`);
    if (ws._sessionId) {
      // Auto-remove session when agent disconnects
      removeSession(ws._sessionId);
      broadcastSessionsUpdated();
    }
  });
}

// Track all client connections globally
const allClients = new Set();

function handleClientConnection(ws, wss) {
  allClients.add(ws);

  // Send current sessions list on connect (filtered for this user)
  ws.send(JSON.stringify({
    type: 'sessions_updated',
    sessions: getAllSessions(ws._userId),
  }));

  // Auto-subscribe if connected via session token
  if (ws._sessionId) {
    const session = getSession(ws._sessionId);
    if (session) {
      session.clientWs.add(ws);
      const messages = getMessages(ws._sessionId, 0);
      ws.send(JSON.stringify({
        type: 'auto_subscribed',
        sessionId: ws._sessionId,
        autoAccept: session.autoAccept ?? false,
      }));
      ws.send(JSON.stringify({
        type: 'message_history',
        sessionId: ws._sessionId,
        messages,
      }));
    }
  }

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'subscribe_session': {
        // Restrict session-token clients to their session
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        // Client wants to watch a specific session
        ws._sessionId = msg.sessionId;
        const session = getSession(msg.sessionId);
        if (session) {
          session.clientWs.add(ws);
          // Send autoAccept state and message history
          ws.send(JSON.stringify({
            type: 'auto_accept_changed',
            sessionId: msg.sessionId,
            autoAccept: session.autoAccept ?? false,
          }));
          const messages = getMessages(msg.sessionId, msg.since || 0);
          ws.send(JSON.stringify({
            type: 'message_history',
            sessionId: msg.sessionId,
            messages,
          }));
        }
        break;
      }

      case 'unsubscribe_session': {
        const session = getSession(ws._sessionId);
        if (session) {
          session.clientWs.delete(ws);
        }
        ws._sessionId = null;
        break;
      }

      case 'user_message': {
        // Restrict session-token clients to their session
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        // Forward user input to the agent
        const session = getSession(msg.sessionId);
        if (session?.agentWs?.readyState === 1) {
          session.agentWs.send(JSON.stringify({
            type: 'user_message',
            sessionId: msg.sessionId,
            content: msg.content,
          }));

          // Also add to message history
          addMessage(msg.sessionId, {
            role: 'user',
            content: msg.content,
            timestamp: Date.now(),
          });

          // Echo back to all clients watching this session
          broadcastToClients(msg.sessionId, {
            type: 'claude_output',
            sessionId: msg.sessionId,
            message: {
              role: 'user',
              content: msg.content,
              timestamp: Date.now(),
            },
          });
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Agent not connected for this session',
          }));
        }
        break;
      }

      case 'permission_response': {
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        const session = getSession(msg.sessionId);
        if (session?.agentWs?.readyState === 1) {
          session.agentWs.send(JSON.stringify({
            type: 'permission_response',
            sessionId: msg.sessionId,
            permissionId: msg.permissionId,
            action: msg.action,
          }));
        }
        break;
      }

      case 'set_auto_accept': {
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        const session = getSession(msg.sessionId);
        if (session?.agentWs?.readyState === 1) {
          session.agentWs.send(JSON.stringify({
            type: 'set_auto_accept',
            sessionId: msg.sessionId,
            autoAccept: msg.autoAccept,
          }));
        }
        break;
      }

      case 'stop_message': {
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        const session = getSession(msg.sessionId);
        if (session?.agentWs?.readyState === 1) {
          session.agentWs.send(JSON.stringify({
            type: 'stop_message',
            sessionId: msg.sessionId,
          }));
        }
        break;
      }

      case 'dismiss_question': {
        if (ws._isSessionToken && msg.sessionId !== ws._authSessionId) {
          ws.send(JSON.stringify({ type: 'error', error: 'Access denied to this session' }));
          break;
        }
        const session = getSession(msg.sessionId);
        if (session?.agentWs?.readyState === 1) {
          session.agentWs.send(JSON.stringify({
            type: 'dismiss_question',
            sessionId: msg.sessionId,
          }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
    // Remove from any session's client set
    const session = getSession(ws._sessionId);
    if (session) {
      session.clientWs.delete(ws);
    }
  });
}

function broadcastSessionsUpdated() {
  // Each client gets their own filtered session list
  for (const client of allClients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'sessions_updated',
        sessions: getAllSessions(client._userId),
      }));
    }
  }
}

function broadcastToClients(sessionId, message) {
  const data = JSON.stringify(message);

  if (sessionId) {
    // Send to clients watching this specific session
    const session = getSession(sessionId);
    if (session) {
      for (const client of session.clientWs) {
        if (client.readyState === 1) {
          client.send(data);
        }
      }
    }
  } else {
    // Send to all connected clients
    for (const client of allClients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }
}
