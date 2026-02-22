import express from 'express';

export function createHttpServer(sessionManager, relayPublicUrl) {
  const app = express();
  app.use(express.json());

  // CORS for local VSCode extension requests
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // List active sessions
  app.get('/sessions', (req, res) => {
    res.json({ sessions: sessionManager.getAllSessions() });
  });

  // Share a session (called by VSCode extension)
  app.post('/sessions/share', (req, res) => {
    const { projectPath, projectName } = req.body;

    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }

    const name = projectName || projectPath.split(/[/\\]/).pop();

    // Check if already shared
    for (const session of sessionManager.getAllSessions()) {
      if (session.projectPath === projectPath) {
        return res.json({ session, alreadyShared: true, relayPublicUrl: relayPublicUrl || '' });
      }
    }

    const session = sessionManager.createSession(projectPath, name);
    res.json({
      session: {
        id: session.id,
        projectName: session.projectName,
        projectPath: session.projectPath,
        sessionToken: session.sessionToken,
        status: session.status,
      },
      relayPublicUrl: relayPublicUrl || '',
    });
  });

  // Stop sharing a session
  app.delete('/sessions/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    sessionManager.removeSession(req.params.id);
    res.json({ success: true });
  });

  return app;
}
