// In-memory session store
const sessions = new Map();

export function createSession(sessionId, info) {
  sessions.set(sessionId, {
    id: sessionId,
    projectName: info.projectName,
    projectPath: info.projectPath,
    status: 'idle',
    messages: [],
    agentWs: null,
    clientWs: new Set(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });
  return sessions.get(sessionId);
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function getAllSessions() {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      projectName: session.projectName,
      status: session.status,
      messageCount: session.messages.length,
      lastActivity: session.lastActivity,
      lastMessage: session.messages.length > 0
        ? summarizeMessage(session.messages[session.messages.length - 1])
        : null,
    });
  }
  return list;
}

export function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    // Close all client WebSockets for this session
    for (const ws of session.clientWs) {
      ws.send(JSON.stringify({ type: 'session_closed', sessionId }));
    }
    sessions.delete(sessionId);
  }
}

export function addMessage(sessionId, message) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.messages.push(message);
  session.lastActivity = Date.now();

  // Keep buffer at 200 messages max
  if (session.messages.length > 200) {
    session.messages = session.messages.slice(-200);
  }
}

export function getMessages(sessionId, since = 0) {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return session.messages.filter(m => m.timestamp > since);
}

export function updateSessionStatus(sessionId, status) {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = status;
    session.lastActivity = Date.now();
  }
}

function summarizeMessage(msg) {
  if (!msg) return null;
  const text = msg.content || msg.text || '';
  return text.length > 100 ? text.substring(0, 100) + '...' : text;
}
