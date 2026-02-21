import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '..', '.env') });

import { RelayClient } from './relay-client.js';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';

// Configuration from environment variables
const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3001';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-me';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '9680', 10);

console.log('[Agent] Starting Remote Clauding Agent...');
console.log(`[Agent] Relay URL: ${RELAY_URL}`);
console.log(`[Agent] HTTP port: ${HTTP_PORT}`);

// Connect to relay server
const relayClient = new RelayClient(RELAY_URL, AUTH_TOKEN);

relayClient.on('connected', () => {
  console.log('[Agent] Connected to relay server');
});

relayClient.on('disconnected', () => {
  console.log('[Agent] Disconnected from relay server');
});

// Session manager
const sessionManager = new SessionManager(relayClient);

// Local HTTP server for VSCode extension
const httpApp = createHttpServer(sessionManager);
const httpServer = createServer(httpApp);

// Local WebSocket server for VSCode extension real-time updates
const localWss = new WebSocketServer({ server: httpServer, path: '/ws' });
const localClients = new Set();

localWss.on('connection', (ws) => {
  console.log('[Local WS] VSCode extension connected');
  localClients.add(ws);

  // Send current sessions
  ws.send(JSON.stringify({
    type: 'sessions_updated',
    sessions: sessionManager.getAllSessions(),
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      // VSCode extension can also send messages to Claude
      if (msg.type === 'user_message' && msg.sessionId) {
        sessionManager.handleUserMessage(msg.sessionId, msg.content, true);
      }
    } catch {}
  });

  ws.on('close', () => {
    localClients.delete(ws);
    console.log('[Local WS] VSCode extension disconnected');
  });
});

// Expose broadcast function so session manager can notify local clients
sessionManager.onLocalBroadcast = (message) => {
  const data = JSON.stringify(message);
  for (const client of localClients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
};

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[Agent] HTTP API listening on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[Agent] Local WS available at ws://127.0.0.1:${HTTP_PORT}/ws`);
  console.log('[Agent] Ready. Waiting for sessions to share...');
});

httpServer.on('error', (err) => {
  if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
    console.error(`[Agent] Port ${HTTP_PORT} unavailable (${err.code}). Try setting HTTP_PORT env var.`);
  } else {
    console.error('[Agent] HTTP server error:', err.message);
  }
  process.exit(1);
});

// Connect to relay
relayClient.connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Agent] Shutting down...');
  relayClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Agent] Shutting down...');
  relayClient.disconnect();
  process.exit(0);
});
