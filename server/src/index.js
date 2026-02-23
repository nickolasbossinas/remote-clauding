import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname2, '..', '..', '.env') });
import { authMiddleware } from './auth.js';
import { validateToken } from './auth.js';
import { getAllSessions, getSessionByToken } from './sessions.js';
import { initPush, addSubscription, getVapidPublicKey } from './push.js';
import { setupWebSocket } from './relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

app.use(express.json());

// Serve PWA static files
const webDistPath = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(webDistPath));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Get VAPID public key for push subscription
app.get('/api/push/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    return res.status(503).json({ error: 'Push not configured' });
  }
  res.json({ vapidPublicKey: key });
});

// Register push subscription (accepts global or session tokens)
app.post('/api/push/subscribe', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!validateToken(token) && !getSessionByToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  addSubscription(subscription);
  res.json({ success: true });
});

// List active sessions
app.get('/api/sessions', authMiddleware, (req, res) => {
  res.json({ sessions: getAllSessions() });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.sendFile(path.join(webDistPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Initialize push notifications
initPush();

// Setup WebSocket relay
setupWebSocket(server);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Relay server running on port ${PORT}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
});
