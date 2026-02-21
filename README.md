# Remote Clauding

Monitor and interact with Claude Code from your iPhone while Claude works on your PC.

## Architecture

```
┌──────────────┐      WSS       ┌───────────────┐      WSS      ┌──────────┐
│  Your PC     │ ─────────────► │ Cloud Relay   │ ◄──────────── │ iPhone   │
│  Agent +     │                │ Server        │               │ PWA      │
│  VSCode Ext  │                │               │               │          │
└──────────────┘                └───────────────┘               └──────────┘
```

Four components:
- **server/** - Cloud relay server (Node.js + WebSocket + Web Push)
- **agent/** - Desktop agent that wraps Claude CLI
- **vscode-ext/** - VSCode extension with "Share to Mobile" button
- **web/** - Mobile PWA (React)

## Quick Start (Local Dev)

### 1. Install dependencies

```bash
cd server && npm install
cd ../agent && npm install
cd ../web && npm install
```

### 2. Generate VAPID keys (for push notifications)

```bash
npx web-push generate-vapid-keys
```

Copy the keys into a `.env` file (see `.env.example`).

### 3. Start the relay server

```bash
cd server
# Set environment variables or create .env
npm run dev
```

### 4. Build & serve the PWA

```bash
cd web
npm run build
# The server serves the PWA from web/dist/
```

For development with hot reload:
```bash
cd web
npm run dev
# Open http://localhost:5173
```

### 5. Start the desktop agent

```bash
cd agent
# Set RELAY_URL=ws://localhost:3001 and AUTH_TOKEN
npm start
```

### 6. Load the VSCode extension

1. Open VSCode
2. Go to Extensions sidebar
3. Click "..." menu → "Install from VSIX..." or use dev mode:
   - Open `vscode-ext/` folder in VSCode
   - Press F5 to launch Extension Development Host

### 7. Use on iPhone

1. Open the relay server URL in Safari
2. Tap "Share" → "Add to Home Screen"
3. Open the app → Grant notification permission
4. In VSCode, click "Share to Mobile" in the status bar

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_TOKEN` | Shared secret token | `dev-token-change-me` |
| `VAPID_PUBLIC_KEY` | Web Push public key | _(required for push)_ |
| `VAPID_PRIVATE_KEY` | Web Push private key | _(required for push)_ |
| `RELAY_URL` | Relay server WebSocket URL | `ws://localhost:3001` |
| `PORT` | Relay server port | `3001` |
| `HTTP_PORT` | Agent local API port | `9680` |

## Deployment

### Relay Server (Render.com)

1. Create a new Web Service on Render
2. Root directory: `server`
3. Build command: `cd ../web && npm install && npm run build`
4. Start command: `npm start`
5. Set environment variables: `AUTH_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`

The server also serves the PWA static files, so both are deployed together.
