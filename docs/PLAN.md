# Remote Clauding - Implementation Plan

## Context
Build a system that lets you monitor and interact with Claude Code from your iPhone while Claude works on your PC's VSCode project. You can have multiple VSCode windows open, each with its own Claude Code session. Connection is on-demand: you press a button in VSCode to share a session to your phone, which receives a push notification. If Claude needs input while your phone is idle, another push notification alerts you.

## Architecture Overview

```
┌──────────────────┐                 ┌───────────────┐                ┌──────────┐
│  Your PC         │      WSS        │ Cloud Relay   │      WSS       │ iPhone   │
│                  │ ───────────────► │ Server        │ ◄──────────── │ (PWA)    │
│ VSCode Ext       │                 │ (Node.js)     │                │          │
│   ↕ localhost    │                 │ + Web Push    │  ── push ──►   │          │
│ Desktop Agent    │                 │               │                │          │
│ + Claude CLI     │                 │ Hosts PWA     │                │          │
└──────────────────┘                 └───────────────┘                └──────────┘
```

**Four components:**

1. **VSCode Extension** (`vscode-ext/`) - Adds a "Share to Mobile" button in VSCode status bar. Communicates with the desktop agent over localhost.
2. **Desktop Agent** (`agent/`) - Background Node.js service on your PC. Manages Claude CLI sessions, connects to cloud relay.
3. **Relay Server** (`server/`) - Cloud-hosted Node.js server. Routes messages, manages sessions, sends Web Push notifications, and serves the PWA static files.
4. **Mobile PWA** (`web/`) - React app for iPhone. Shows a session list, live Claude output, input bar. Receives push notifications.

## Flow

### Initial Setup (one-time)
1. Deploy relay server to cloud (Render/Railway)
2. Install VSCode extension
3. Start desktop agent on PC (could auto-start with VSCode extension)
4. Open PWA on iPhone Safari → Add to Home Screen → Grant notification permission
5. PWA registers a Web Push subscription → stored on relay server

### Sharing a Session
1. You're working in VSCode with Claude Code running
2. You click the **"Share to Mobile"** button in the VSCode status bar
3. VSCode extension tells the desktop agent (via localhost HTTP) to share this session
4. Agent registers the session with the relay server
5. Relay server sends a **push notification** to your iPhone: _"Claude session 'my-project' is now shared"_
6. You tap the notification → PWA opens → shows the session with Claude's output

### Ongoing Interaction
- You type a message in the PWA → relay → agent → Claude CLI → output streams back
- Each message streams in real-time with markdown rendering
- You can switch between multiple active sessions in the PWA

### Claude Needs Input
1. Claude asks a question or hits a permission prompt
2. Agent detects this from the stream-json output
3. Agent notifies relay → relay sends **push notification**: _"Claude needs your input on 'my-project'"_
4. You tap notification → PWA opens to that session → you respond

## Project Structure

```
remote-clauding/
├── server/                      # Cloud relay server + PWA hosting
│   ├── package.json
│   └── src/
│       ├── index.js             # Express + WebSocket server entry
│       ├── relay.js             # WebSocket message routing logic
│       ├── sessions.js          # Multi-session management
│       ├── push.js              # Web Push notification service
│       └── auth.js              # Token-based authentication
│
├── agent/                       # Desktop agent (runs on your PC)
│   ├── package.json
│   └── src/
│       ├── index.js             # Entry point, starts HTTP + WS
│       ├── http-server.js       # Local HTTP API for VSCode ext
│       ├── claude.js            # Spawns & manages Claude CLI processes
│       ├── session-manager.js   # Tracks multiple Claude sessions
│       └── relay-client.js      # WebSocket client to cloud relay
│
├── vscode-ext/                  # VSCode companion extension
│   ├── package.json             # Extension manifest
│   └── src/
│       └── extension.js         # Status bar button + agent communication
│
├── web/                         # Mobile PWA (React + Vite)
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   ├── public/
│   │   ├── manifest.json        # PWA install manifest
│   │   └── sw.js                # Service worker (push + offline)
│   └── src/
│       ├── main.jsx             # App entry
│       ├── App.jsx              # Router: session list vs session view
│       ├── components/
│       │   ├── SessionList.jsx  # List of active shared sessions
│       │   ├── SessionView.jsx  # Full Claude output for one session
│       │   ├── MessageList.jsx  # Scrollable message feed
│       │   ├── Message.jsx      # Single message (markdown + code)
│       │   ├── ToolCall.jsx     # Collapsible tool usage display
│       │   ├── InputBar.jsx     # Message input + send button
│       │   └── StatusBar.jsx    # Connection status indicator
│       ├── hooks/
│       │   ├── useRelay.js      # WebSocket connection hook
│       │   └── usePush.js       # Push notification subscription hook
│       └── styles/
│           └── app.css          # Mobile-first styles
│
└── README.md
```

## Implementation Steps

### Step 1: Relay Server (`server/`)
- **Express + ws** WebSocket server
- **Session management**: Track multiple agent sessions, each identified by a unique session ID and project name
- **Message routing**: Route messages between specific agent sessions and connected PWA clients
- **Message buffer**: Keep last 200 messages per session so PWA can catch up on reconnect
- **Web Push**: Use `web-push` npm package with VAPID keys to send push notifications
  - Notification types: `session-shared` (new session available) and `input-required` (Claude waiting)
  - Store PWA push subscriptions in memory (with optional file persistence)
- **Auth**: Simple shared token in WebSocket handshake headers
- **Static hosting**: Serve the built PWA files from `/` so everything is on one domain
- **Endpoints**:
  - `WSS /ws/agent` - Agent connections (one per Claude session)
  - `WSS /ws/client` - PWA connections
  - `POST /api/push/subscribe` - Register push subscription
  - `GET /api/sessions` - List active sessions
  - `GET /health` - Health check

### Step 2: Desktop Agent (`agent/`)
- **Local HTTP server** (port 9680) for VSCode extension communication:
  - `POST /sessions/share` - Share current session to mobile (triggers push notification via relay)
  - `GET /sessions` - List active sessions
  - `DELETE /sessions/:id` - Stop sharing a session
- **Claude CLI bridge** (`claude.js`):
  - Spawns `claude -p "<message>" --output-format stream-json --verbose` in the project's working directory
  - For follow-ups: `claude --continue -p "<message>" --output-format stream-json`
  - Parses each JSON line from stdout
  - Detects "input required" events (permission prompts, user questions) and flags them
- **Session manager**: Tracks multiple concurrent Claude sessions (one per VSCode window/project)
- **Relay client**: Maintains WSS connection to cloud relay, auto-reconnects with exponential backoff
- **Message types sent to relay**:
  - `assistant_message` - Claude's text output (streamed)
  - `tool_use` - Tool being called (name, input)
  - `tool_result` - Tool result (output, truncated if large)
  - `input_required` - Claude is waiting for user input
  - `session_status` - idle / processing / error
  - `session_info` - project name, path, session ID

### Step 3: VSCode Extension (`vscode-ext/`)
- **Activation**: Activates on VSCode startup
- **Status bar button**: Adds a "Share to Mobile" item in the status bar (bottom)
  - Icon: phone/broadcast icon
  - Click toggles sharing for the current workspace
  - Shows status: "Not Shared" / "Shared (connected)" / "Shared (no mobile)"
- **Communication**: HTTP requests to the local agent at `http://localhost:9680`
- **Auto-detect workspace**: Sends the current workspace folder path to the agent so it knows which project directory to use for Claude CLI
- Minimal extension - just the button and HTTP calls, all logic lives in the agent

### Step 4: Mobile PWA (`web/`)
- **React 18 + Vite** with mobile-first design
- **Session List** (home screen):
  - Shows all active shared sessions as cards
  - Each card shows: project name, status (idle/working/needs input), last message preview
  - Red badge on sessions that need input
  - Pull-to-refresh
- **Session View** (tap a session):
  - Auto-scrolling message feed
  - Messages rendered with `react-markdown` + `react-syntax-highlighter`
  - Tool calls shown as collapsible cards (icon + name, expand for details)
  - Fixed input bar at bottom with text field + send button
  - Back button to return to session list
- **Push notifications**:
  - On first launch, request notification permission and register push subscription with relay
  - Service worker handles push events: shows notification, clicking opens the relevant session
- **PWA manifest**: Name, icons, theme color, `display: standalone` for native feel
- **Connection handling**: Auto-reconnect WebSocket, show connection status banner

### Step 5: Integration Testing & Deployment
1. **Local testing**: Run all components locally, test multi-session flow
2. **Deploy relay server** to Render.com (free tier):
   - Set environment variables: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `AUTH_TOKEN`
   - The relay also serves the PWA static build
3. **Generate VAPID keys** for Web Push: `npx web-push generate-vapid-keys`
4. **Configure agent**: Set relay URL and auth token in `.env`
5. **Install VSCode extension**: Load from local folder (Extensions → Install from VSIX or dev mode)
6. **Test on iPhone**: Open relay URL in Safari → Add to Home Screen → Grant notifications → Test full flow

## Tech Stack
- **Runtime**: Node.js 18+
- **Relay server**: Express, ws, web-push
- **Agent**: Express (local HTTP), ws (relay client), child_process (Claude CLI)
- **VSCode Extension**: VS Code Extension API (minimal)
- **PWA**: React 18, Vite, react-markdown, react-syntax-highlighter
- **Deployment**: Render.com (relay + PWA), VSCode dev extension (local)

## Security
- Shared auth token for agent ↔ relay and PWA ↔ relay authentication
- All remote connections over WSS/HTTPS (cloud hosting provides TLS)
- Agent's local HTTP server only listens on `127.0.0.1` (not exposed to network)
- VAPID keys for Web Push (standard, no third-party push service needed)

## Verification
1. Start relay locally → verify WebSocket accepts agent and client connections
2. Start agent → verify it connects to relay, local HTTP responds on port 9680
3. Load VSCode extension → verify status bar button appears, clicking it calls agent API
4. Open PWA in desktop browser → verify session list loads, WebSocket connects
5. Share a session via VSCode button → verify push notification arrives (test in Chrome first)
6. Send a message from PWA → verify Claude runs on PC, output streams back to PWA
7. Open second VSCode window → share second session → verify both appear in PWA session list
8. Let Claude ask for input → verify push notification fires when phone is idle
9. Deploy to cloud → repeat all tests with cloud relay URL
10. Test on iPhone Safari → Add to Home Screen → verify push notifications work on iOS
