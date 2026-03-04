import express from 'express';
import { readdir, open, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

function getClaudeProjectDir(projectPath) {
  const dirName = projectPath.replace(/[:\\/]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', dirName);
}

const META_TAGS = /^<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|ide_|system-reminder)/;

function getMessageText(message, { skipMeta = false } = {}) {
  const content = message?.content;
  if (!content) return null;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.find(b => b.type === 'text')?.text
    : null;
  if (!text) return null;
  if (skipMeta && META_TAGS.test(text.trim())) return null;
  return text.substring(0, 200);
}

function extractFirstUserText(text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user') {
        const t = getMessageText(obj.message, { skipMeta: true });
        if (t) return t;
      }
    } catch {}
  }
  return null;
}

function extractLastField(text, field) {
  const pattern = `"${field}":"`;
  let idx = text.lastIndexOf(pattern);
  if (idx === -1) return null;
  idx += pattern.length;
  let end = idx;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === '\\') end++; // skip escaped char
    end++;
  }
  return text.substring(idx, end).substring(0, 200);
}

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
    res.json({ status: 'ok', relayPublicUrl: relayPublicUrl || '' });
  });

  // List past conversations from JSONL files
  app.get('/conversations', async (req, res) => {
    const { projectPath } = req.query;
    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }
    try {
      const dir = getClaudeProjectDir(projectPath);
      let files;
      try { files = await readdir(dir); } catch { return res.json({ conversations: [] }); }

      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      const conversations = [];

      for (const file of jsonlFiles) {
        const conversationId = file.replace('.jsonl', '');
        const filePath = path.join(dir, file);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.size === 0) continue;

          const fh = await open(filePath, 'r');
          const buf = Buffer.alloc(65536);

          // Read head (first 64KB)
          const { bytesRead } = await fh.read(buf, 0, 65536, 0);
          const head = buf.subarray(0, bytesRead).toString('utf8');

          // Read tail (last 64KB) if file is larger
          let tail = head;
          const tailOffset = Math.max(0, fileStat.size - 65536);
          if (tailOffset > 0) {
            const { bytesRead: tailRead } = await fh.read(buf, 0, 65536, tailOffset);
            tail = buf.subarray(0, tailRead).toString('utf8');
          }
          await fh.close();

          // Prefer customTitle/summary from tail, fall back to first user message
          const customTitle = extractLastField(tail, 'customTitle');
          const tailSummary = extractLastField(tail, 'summary');
          const firstUserText = extractFirstUserText(head);
          const summary = customTitle || tailSummary || firstUserText || '(untitled)';

          conversations.push({ conversationId, summary, mtime: fileStat.mtime.toISOString() });
        } catch {}
      }

      conversations.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      res.json({ conversations: conversations.slice(0, 50) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get conversation history (last 10 user messages + all assistant responses)
  app.get('/conversations/:id', async (req, res) => {
    const { projectPath } = req.query;
    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }
    const dir = getClaudeProjectDir(projectPath);
    const filePath = path.join(dir, `${req.params.id}.jsonl`);
    try {
      const fh = await open(filePath, 'r');
      const content = await fh.readFile('utf8');
      await fh.close();

      const messages = [];
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' || obj.type === 'assistant') {
            const t = getMessageText(obj.message, { skipMeta: true });
            if (t) messages.push({ role: obj.type, text: t, timestamp: obj.timestamp });
          }
        } catch {}
      }

      // Keep last 10 user messages and all assistant messages associated with them
      const userIndices = messages.reduce((acc, m, i) => m.role === 'user' ? [...acc, i] : acc, []);
      const cutoff = userIndices.length > 10 ? userIndices[userIndices.length - 10] : 0;
      res.json({ messages: messages.slice(cutoff) });
    } catch {
      res.status(404).json({ error: 'Conversation not found' });
    }
  });

  // List active sessions
  app.get('/sessions', (req, res) => {
    res.json({ sessions: sessionManager.getAllSessions() });
  });

  // Create a local-only session (no mobile sharing)
  app.post('/sessions', async (req, res) => {
    const { projectPath, projectName, forceNew, resumeConversationId } = req.body;

    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }

    const name = projectName || projectPath.split(/[/\\]/).pop();

    // Return existing session for this project (unless forceNew)
    if (!forceNew) {
      for (const session of sessionManager.getAllSessions()) {
        if (session.projectPath === projectPath) {
          return res.json({ session, alreadyExists: true });
        }
      }
    }

    const session = await sessionManager.createSession(projectPath, name, { shared: false, resumeConversationId });
    res.json({
      session: {
        id: session.id,
        projectName: session.projectName,
        projectPath: session.projectPath,
        sessionToken: session.sessionToken,
        status: session.status,
      },
    });
  });

  // Share a session (called by VSCode extension)
  app.post('/sessions/share', async (req, res) => {
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

    const session = await sessionManager.createSession(projectPath, name);
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

  // Re-share a session (re-register with relay)
  app.post('/sessions/:id/reshare', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    sessionManager.reshareSession(req.params.id);
    res.json({ success: true });
  });

  // Unshare a session (stop mobile access but keep session alive)
  app.post('/sessions/:id/unshare', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    sessionManager.unshareSession(req.params.id);
    res.json({ success: true });
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
