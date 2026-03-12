# Remote Clauding

Remote access to Claude Code sessions from your phone.

Run Claude Code on your PC — in VSCode or the terminal — and monitor, review, and respond to it from your iPhone. When Claude asks a question or finishes a task, you get a push notification on your phone and can reply immediately without being at your desk.

Works with:
- **VSCode** — the companion extension adds a "Share to Mobile" button that streams your active Claude session to the phone
- **CLI** — run `remote-clauding` in a terminal for a standalone Claude session accessible from your phone

## Architecture

```
┌──────────────┐      WSS       ┌───────────────┐      WSS      ┌──────────┐
│  Your PC     │ ─────────────► │ Cloud Relay   │ ◄──────────── │ iPhone   │
│  Agent +     │                │ Server        │               │ PWA      │
│  VSCode Ext  │                │               │               │          │
└──────────────┘                └───────────────┘               └──────────┘
```

Five components:
- **tauri-app/** - Desktop installer & manager (Tauri v2 + React)
- **server/** - Cloud relay server (Node.js + WebSocket + Web Push)
- **agent/** - Desktop agent that wraps Claude CLI (via `remote-clauding` CLI)
- **vscode-ext/** - VSCode extension with "Share to Mobile" button
- **web/** - Mobile PWA (React)

## Installation (Recommended)

The Tauri desktop app handles the full setup:

1. Build the installer: `cd tauri-app && npm install && npm run tauri build`
2. Run `Remote Clauding_1.0.0_x64-setup.exe` from `tauri-app/src-tauri/target/release/bundle/nsis/`
3. The app walks you through:
   - **Node.js** — detects system Node or installs a portable copy
   - **CLI** — installs the `remote-clauding` npm package globally
   - **VSCode extension** — installs the companion `.vsix`
   - **Authentication** — register/login against the relay server
   - **Agent** — start/stop with a single button (adds a system tray icon)

Once set up, open the PWA on your phone and the VSCode extension on your PC.

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

## CLI Usage

The `remote-clauding` CLI is installed globally by the Tauri app (or manually via `npm install -g`).

```bash
remote-clauding start       # Start the agent (background, with system tray icon)
remote-clauding stop        # Stop the agent
remote-clauding status      # Check if the agent is running
remote-clauding login       # Authenticate with the relay server
remote-clauding register    # Create a new account
remote-clauding setup       # Install/reinstall the VSCode extension
```

Without a subcommand, `remote-clauding` opens an interactive CLI session.

Agent logs are written to `%APPDATA%\remote-clauding\agent.log` (Windows).

## Deployment

### Relay Server (Render.com)

1. Create a new Web Service on Render
2. Root directory: `server`
3. Build command: `cd ../web && npm install && npm run build`
4. Start command: `npm start`
5. Set environment variables: `AUTH_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`

The server also serves the PWA static files, so both are deployed together.
