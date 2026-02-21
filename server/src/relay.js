import { WebSocketServer } from 'ws';
import { validateToken } from './auth.js';
import {
  createSession,
  getSession,
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

    if (!validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname === '/ws/agent' || pathname === '/ws/client') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws._type = pathname === '/ws/agent' ? 'agent' : 'client';
        ws._sessionId = url.searchParams.get('sessionId') || null;
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
        });
        session.agentWs = ws;
        ws._sessionId = msg.sessionId;

        // Notify mobile via push
        sendNotification(
          'Session Shared',
          `Claude session "${msg.projectName}" is now shared`,
          { type: 'session-shared', sessionId: msg.sessionId }
        );

        // Notify connected clients about new session
        broadcastToClients(null, {
          type: 'sessions_updated',
          sessions: getAllSessions(),
        });
        break;
      }

      case 'session_unregister': {
        removeSession(msg.sessionId);
        broadcastToClients(null, {
          type: 'sessions_updated',
          sessions: getAllSessions(),
        });
        break;
      }

      case 'claude_output': {
        const message = {
          ...msg.message,
          timestamp: Date.now(),
        };
        addMessage(msg.sessionId, message);

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
        broadcastToClients(null, {
          type: 'sessions_updated',
          sessions: getAllSessions(),
        });
        break;
      }

      case 'input_required': {
        updateSessionStatus(msg.sessionId, 'input_required');
        const session = getSession(msg.sessionId);
        const projectName = session?.projectName || msg.sessionId;

        // Push notification for input required
        sendNotification(
          'Input Required',
          `Claude needs your input on "${projectName}"`,
          { type: 'input-required', sessionId: msg.sessionId }
        );

        broadcastToClients(msg.sessionId, {
          type: 'input_required',
          sessionId: msg.sessionId,
          prompt: msg.prompt,
        });

        broadcastToClients(null, {
          type: 'sessions_updated',
          sessions: getAllSessions(),
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Agent disconnected (session: ${ws._sessionId})`);
    if (ws._sessionId) {
      // Auto-remove session when agent disconnects
      removeSession(ws._sessionId);
      broadcastToClients(null, {
        type: 'sessions_updated',
        sessions: getAllSessions(),
      });
    }
  });
}

// Track all client connections globally
const allClients = new Set();

function handleClientConnection(ws, wss) {
  allClients.add(ws);

  // Send current sessions list on connect
  ws.send(JSON.stringify({
    type: 'sessions_updated',
    sessions: getAllSessions(),
  }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'subscribe_session': {
        // Client wants to watch a specific session
        ws._sessionId = msg.sessionId;
        const session = getSession(msg.sessionId);
        if (session) {
          session.clientWs.add(ws);
          // Send message history
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
