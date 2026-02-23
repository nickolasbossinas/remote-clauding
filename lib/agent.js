import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RelayClient } from './relay-client.js';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { savePid, clearPid } from './config.js';

const RELAY_URL = 'wss://claude.iptinno.com';
const RELAY_PUBLIC_URL = 'https://claude.iptinno.com';

export async function startAgent(config) {
  const { auth_token, port = 9680 } = config;

  // Write PID so logout/status can find us
  savePid(process.pid);

  console.log('[Agent] Starting Remote Clauding Agent...');
  console.log(`[Agent] HTTP port: ${port}`);

  // Connect to relay server
  const relayClient = new RelayClient(RELAY_URL, auth_token);

  // System tray (optional — works on Windows, skipped elsewhere)
  let tray;
  try {
    const { TrayManager } = await import('./tray.js');
    tray = new TrayManager();
  } catch {
    tray = {
      start() { return Promise.resolve(); },
      updateSessionCount() {},
      updateRelayStatus() {},
      kill() {},
      on() {},
    };
  }

  relayClient.on('connected', () => {
    console.log('[Agent] Connected to relay server');
    tray.updateRelayStatus(true);
  });

  relayClient.on('disconnected', () => {
    console.log('[Agent] Disconnected from relay server');
    tray.updateRelayStatus(false);
  });

  tray.on('exit', () => {
    console.log('[Agent] Exit requested from tray');
    relayClient.disconnect();
    tray.kill();
    process.exit(0);
  });

  // Session manager
  const sessionManager = new SessionManager(relayClient);

  sessionManager.onSessionCountChange = (count) => {
    tray.updateSessionCount(count);
  };

  // Local HTTP server for VSCode extension
  const httpApp = createHttpServer(sessionManager, RELAY_PUBLIC_URL);
  const httpServer = createServer(httpApp);

  // Local WebSocket server for VSCode extension real-time updates
  const localWss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const localClients = new Set();

  localWss.on('connection', (ws) => {
    console.log('[Local WS] VSCode extension connected');
    localClients.add(ws);

    ws.send(JSON.stringify({
      type: 'sessions_updated',
      sessions: sessionManager.getAllSessions(),
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'user_message' && msg.sessionId) {
          sessionManager.handleUserMessage(msg.sessionId, msg.content, true);
        } else if (msg.type === 'stop_message' && msg.sessionId) {
          sessionManager.abortSession(msg.sessionId);
        }
      } catch {}
    });

    ws.on('close', () => {
      localClients.delete(ws);
      console.log('[Local WS] VSCode extension disconnected');
    });
  });

  sessionManager.onLocalBroadcast = (message) => {
    const data = JSON.stringify(message);
    for (const client of localClients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  };

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[Agent] HTTP API listening on http://127.0.0.1:${port}`);
    console.log(`[Agent] Local WS available at ws://127.0.0.1:${port}/ws`);
    console.log('[Agent] Ready. Waiting for sessions to share...');

    tray.start()
      .then(() => console.log('[Agent] System tray icon ready'))
      .catch(() => {});
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      console.error(`[Agent] Port ${port} unavailable (${err.code}).`);
    } else {
      console.error('[Agent] HTTP server error:', err.message);
    }
    process.exit(1);
  });

  // Connect to relay
  relayClient.connect();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Agent] Shutting down...');
    clearPid();
    tray.kill();
    relayClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
