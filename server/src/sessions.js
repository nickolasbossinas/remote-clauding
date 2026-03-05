// In-memory session store
const sessions = new Map();

export function createSession(sessionId, info) {
  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    id: sessionId,
    projectName: info.projectName,
    projectPath: info.projectPath,
    sessionToken: info.sessionToken || null,
    userId: info.userId || 0,
    autoAccept: info.autoAccept ?? false,
    status: 'idle',
    messages: existing ? existing.messages : [],
    agentWs: null,
    clientWs: existing ? existing.clientWs : new Set(),
    createdAt: existing ? existing.createdAt : Date.now(),
    lastActivity: Date.now(),
  });
  return sessions.get(sessionId);
}

export function getSessionByToken(token) {
  if (!token) return null;
  for (const [id, session] of sessions) {
    if (session.sessionToken && session.sessionToken === token) {
      return session;
    }
  }
  return null;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function summarizeSession(session) {
  return {
    id: session.id,
    projectName: session.projectName,
    status: session.status,
    autoAccept: session.autoAccept,
    messageCount: session.messages.length,
    lastActivity: session.lastActivity,
    lastMessage: session.messages.length > 0
      ? summarizeMessage(session.messages[session.messages.length - 1])
      : null,
  };
}

export function getAllSessions(userId) {
  const list = [];
  for (const [id, session] of sessions) {
    // Hide unshared sessions
    if (session.status === 'unshared') continue;
    // Superuser (id=0) sees all; regular users see only their own
    if (userId !== undefined && userId !== 0 && session.userId !== userId) {
      continue;
    }
    list.push(summarizeSession(session));
  }
  return list;
}

export function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    // Notify client WebSockets that this session is closed
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
