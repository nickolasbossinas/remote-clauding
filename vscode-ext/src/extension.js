const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const AGENT_URL = 'http://127.0.0.1:9680';
const AGENT_WS_URL = 'ws://127.0.0.1:9680/ws';

class ChatViewProvider {
  static viewType = 'remote-clauding.chatView';

  constructor(extensionUri, workspaceState) {
    this._extensionUri = extensionUri;
    this._workspaceState = workspaceState;
    this._view = null;
    this._agentWs = null;
    this._currentSessionId = null;
    this._currentSessionToken = null;
    this._currentRelayUrl = null;
    this._isShared = false;
    this._autoAccept = false;
    this._messageHistory = workspaceState.get('messageHistory', []);
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtml();

    // Connect to agent WS immediately
    this._connectAgentWs();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'webview_ready') {
        // Replay saved message history to restore UI
        for (const savedMsg of this._messageHistory) {
          this._view.webview.postMessage(savedMsg);
        }
        return;
      } else if (msg.type === 'clear_history') {
        this._messageHistory = [];
        this._workspaceState.update('messageHistory', []);
        return;
      } else if (msg.type === 'user_message') {
        await this._ensureSession();
        if (this._currentSessionId && this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'user_message',
            sessionId: this._currentSessionId,
            content: msg.content,
          }));
        }
      } else if (msg.type === 'stop_message' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'stop_message',
            sessionId: this._currentSessionId,
          }));
        }
      } else if (msg.type === 'toggle_share') {
        if (this._isShared) {
          this._stopSharing();
        } else {
          this._startSharing();
        }
      } else if (msg.type === 'set_auto_accept') {
        this._autoAccept = msg.autoAccept;
        if (this._currentSessionId && this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'set_auto_accept',
            sessionId: this._currentSessionId,
            autoAccept: msg.autoAccept,
          }));
        }
      } else if (msg.type === 'permission_response' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'permission_response',
            sessionId: this._currentSessionId,
            permissionId: msg.permissionId,
            action: msg.action,
          }));
        }
      } else if (msg.type === 'dismiss_question' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'dismiss_question',
            sessionId: this._currentSessionId,
          }));
        }
      } else if (msg.type === 'fetch_conversations') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        try {
          const result = await agentRequest('GET',
            `/conversations?projectPath=${encodeURIComponent(workspaceFolder.uri.fsPath)}`);
          this._postMessage({ type: 'conversations_list', conversations: result.conversations || [] });
        } catch {}
      } else if (msg.type === 'select_conversation') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        try {
          const result = await agentRequest('POST', '/sessions', {
            projectPath: workspaceFolder.uri.fsPath,
            projectName: workspaceFolder.name,
            forceNew: true,
            resumeConversationId: msg.conversationId,
          });
          if (result.session) {
            this._currentSessionId = result.session.id;
            this._currentSessionToken = result.session.sessionToken;
          }
          const history = await agentRequest('GET',
            `/conversations/${msg.conversationId}?projectPath=${encodeURIComponent(workspaceFolder.uri.fsPath)}`);
          this._postMessage({ type: 'conversation_history', messages: history.messages || [] });
          this._postMessage({ type: 'conversation_resumed', conversationId: msg.conversationId });
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to resume conversation: ${err.message}`);
        }
      }
    });

    webviewView.onDidDispose(() => {
      this._view = null;
    });
  }

  async _ensureSession() {
    if (this._currentSessionId) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    try {
      const result = await agentRequest('POST', '/sessions', {
        projectPath: workspaceFolder.uri.fsPath,
        projectName: workspaceFolder.name,
      });

      if (result.session) {
        this._currentSessionId = result.session.id;
        this._currentSessionToken = result.session.sessionToken;

        // Sync auto-accept state with the new session
        if (!this._autoAccept && this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'set_auto_accept',
            sessionId: this._currentSessionId,
            autoAccept: false,
          }));
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to create session: ${err.message}. Is the agent running?`
      );
    }
  }

  async _startSharing() {
    try {
      this._postMessage({ type: 'share_status', status: 'loading' });

      // Ensure a session exists first
      await this._ensureSession();
      if (!this._currentSessionId) {
        this._postMessage({ type: 'share_status', status: 'idle' });
        return;
      }

      // Share or re-share the existing session
      await agentRequest('POST', `/sessions/${this._currentSessionId}/reshare`);
      this._isShared = true;

      // Get relay URL if we don't have it yet
      if (!this._currentRelayUrl) {
        const health = await agentRequest('GET', '/health');
        this._currentRelayUrl = health.relayPublicUrl || '';
      }

      await this._showQr();
      this._postMessage({ type: 'share_status', status: 'shared' });
    } catch (err) {
      this._postMessage({ type: 'share_status', status: 'idle' });
      vscode.window.showErrorMessage(
        `Failed to share: ${err.message}. Is the agent running?`
      );
    }
  }

  async _stopSharing() {
    if (!this._currentSessionId) return;

    try {
      await agentRequest('POST', `/sessions/${this._currentSessionId}/unshare`);
      this._isShared = false;
      this._postMessage({ type: 'share_status', status: 'idle' });
      this._postMessage({ type: 'hide_qr' });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to stop sharing: ${err.message}`);
    }
  }

  async _showQr() {
    if (this._currentRelayUrl && this._currentSessionToken) {
      const qrUrl = `${this._currentRelayUrl}/#/pair/${this._currentSessionToken}`;
      const qrDataUrl = await QRCode.toDataURL(qrUrl, {
        width: 280, margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      this._postMessage({ type: 'show_qr', qrDataUrl, qrUrl });
    }
  }

  _connectAgentWs() {
    if (this._agentWs) {
      this._agentWs.close();
    }

    this._agentWs = new WebSocket(AGENT_WS_URL);

    this._agentWs.on('open', () => {
      console.log('[Remote Clauding] WebSocket connected to agent');
    });

    this._agentWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Only forward messages for this sidebar's session
        if (msg.sessionId && msg.sessionId !== this._currentSessionId) return;
        this._postMessage(msg);
      } catch {}
    });

    this._agentWs.on('close', () => {
      console.log('[Remote Clauding] WebSocket disconnected');
    });

    this._agentWs.on('error', (err) => {
      console.error('[Remote Clauding] WebSocket error:', err.message);
    });
  }

  _postMessage(msg) {
    // Buffer claude_output messages for history persistence
    if (msg.type === 'claude_output' && msg.message) {
      this._messageHistory.push(msg);
      // Keep max 500 messages to avoid bloating storage
      if (this._messageHistory.length > 500) {
        this._messageHistory = this._messageHistory.slice(-500);
      }
      this._workspaceState.update('messageHistory', this._messageHistory);
    }
    if (this._view) {
      this._view.webview.postMessage(msg);
    }
  }

  dispose() {
    if (this._currentSessionId && this._isShared) {
      agentRequest('POST', `/sessions/${this._currentSessionId}/unshare`).catch(() => {});
    }
    if (this._agentWs) {
      this._agentWs.close();
    }
  }

  _getHtml() { return getHtml(); }
}

function getHtml() {
    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --claude-orange: #d97757;
      --claude-clay: #c6613f;
      --dot-success: #74c991;
      --dot-error: #c74e39;
      --dot-warning: #e1c08d;
      --dot-progress: #d97757;
      --corner-sm: 4px;
      --corner-md: 6px;
      --corner-lg: 8px;
      --timeline-left: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      line-height: 1.45;
      position: relative;
    }

    /* Share toolbar */
    #share-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #share-btn {
      width: 100%;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: var(--corner-sm);
      padding: 4px 10px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
    }
    #share-btn:hover { opacity: 0.85; }
    #share-btn.shared {
      background: var(--vscode-statusBarItem-warningBackground, #856404);
      color: var(--vscode-statusBarItem-warningForeground, #fff);
    }

    /* Auto-accept toggle — sits below textarea inside input bar */
    #auto-accept-row {
      display: flex;
      align-items: center;
      padding: 2px 2px 0;
      font-size: 11px;
    }
    #auto-accept-row label {
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      user-select: none;
      opacity: 0.75;
    }
    #auto-accept-row label:hover { opacity: 1; }
    #auto-accept-toggle {
      accent-color: var(--claude-orange);
      width: 13px;
      height: 13px;
      cursor: pointer;
    }

    /* Permission request card — reuses question-card / question-option styles */

    /* Messages container — no gap, timeline spacing via padding */
    #messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 12px 40px 12px;
      display: flex;
      flex-direction: column;
      gap: 0;
      position: relative;
    }
    #messages > * { flex-shrink: 0; }

    /* Timeline item wrapper — CSS Grid: dot column + content column */
    .timeline-item {
      display: grid !important;
      grid-template-columns: 7px 1fr !important;
      column-gap: 8px;
      padding: 4px 0;
      align-items: start;
    }
    .timeline-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      margin-top: 6px;
      background: var(--dot-success);
      grid-column: 1;
      grid-row: 1;
    }
    .timeline-content {
      min-width: 0;
      grid-column: 2;
      grid-row: 1;
    }

    /* Dot color variants */
    .timeline-dot.dot-success { background: var(--dot-success); }
    .timeline-dot.dot-error { background: var(--dot-error); }
    .timeline-dot.dot-warning { background: var(--dot-warning); }
    .timeline-dot.dot-progress {
      background: var(--dot-progress);
      animation: dot-blink 1.2s ease-in-out infinite;
    }
    @keyframes dot-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* User message — simple bordered box, no timeline dot */
    .msg-user {
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background);
      border-radius: var(--corner-md);
      padding: 4px 8px;
      margin: 6px 0;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.45;
    }

    /* Assistant text block — plain, no card */
    .msg-assistant {
      word-break: break-word;
      font-size: 13px;
      line-height: 1.45;
    }
    .msg-assistant h3 { font-size: 1.05em; margin: 8px 0 4px; font-weight: 600; }
    .msg-assistant h4 { font-size: 1em; margin: 6px 0 3px; font-weight: 600; }
    .msg-assistant p { margin: 0 0 6px; }
    .msg-assistant p:last-child { margin-bottom: 0; }
    .msg-assistant ul, .msg-assistant ol { padding-left: 18px; margin: 0 0 6px; }
    .msg-assistant li { margin: 1px 0; }
    .msg-assistant a { color: var(--vscode-textLink-foreground); }
    .msg-assistant strong { font-weight: 600; }
    .msg-assistant code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .msg-assistant pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: var(--corner-sm);
      padding: 8px 10px;
      margin: 4px 0;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.4;
    }
    .msg-assistant pre code {
      background: none;
      padding: 0;
      font-size: inherit;
    }
    .msg-assistant table {
      border-collapse: collapse;
      margin: 4px 0;
      font-size: 12px;
      width: auto;
      overflow-x: auto;
      display: block;
    }
    .msg-assistant th, .msg-assistant td {
      border: 1px solid var(--vscode-panel-border, #333);
      padding: 3px 8px;
      text-align: left;
    }
    .msg-assistant th {
      background: var(--vscode-textBlockQuote-background);
      font-weight: 600;
    }
    .code-lang {
      font-size: 0.75em;
      opacity: 0.5;
      text-transform: uppercase;
      margin-bottom: 2px;
      letter-spacing: 0.5px;
    }

    /* Tool card — grid layout like Claude Code */
    .tool-card {
      border: 0.5px solid var(--vscode-panel-border);
      border-radius: 5px;
      overflow: hidden;
    }
    .tool-card.error {
      border-color: var(--dot-error);
    }
    .tool-header {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      user-select: none;
      font-size: 13px;
    }
    .tool-header:hover { opacity: 0.8; }
    .tool-name { font-weight: 700; margin-right: 4px; }
    .tool-summary {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-textLink-foreground);
      font-size: 0.85em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    /* Tool body — visible by default with gradient mask */
    .tool-body {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.35;
    }
    .tool-card.collapsed .tool-body { display: none; }
    .tool-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
    }
    .tool-grid-row {
      display: contents;
    }
    .tool-grid-row + .tool-grid-row .tool-grid-label,
    .tool-grid-row + .tool-grid-row .tool-grid-content {
      border-top: 0.5px solid var(--vscode-panel-border);
    }
    .tool-grid-label {
      padding: 4px 8px 4px 4px;
      opacity: 0.5;
      font-size: 0.85em;
      border-right: 0.5px solid var(--vscode-panel-border);
      border-top: 0.5px solid var(--vscode-panel-border);
      white-space: nowrap;
    }
    .tool-grid-row:first-child .tool-grid-label {
      border-top: 0.5px solid var(--vscode-panel-border);
    }
    .tool-grid-content {
      padding: 4px;
      white-space: pre-wrap;
      word-break: break-all;
      border-top: 0.5px solid var(--vscode-panel-border);
      max-height: 60px;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(to bottom, #000 40px, transparent 60px);
      mask-image: linear-gradient(to bottom, #000 40px, transparent 60px);
    }
    .tool-card.expanded .tool-grid-content {
      max-height: 200px;
      overflow: auto;
      -webkit-mask-image: none;
      mask-image: none;
    }
    .tool-grid-content.is-error { color: var(--dot-error); }

    /* Question / Permission overlay — fixed at bottom */
    #question-overlay {
      display: none;
      position: absolute;
      bottom: 8px;
      left: 8px;
      right: 8px;
      background: color-mix(in srgb, var(--vscode-editor-background) 85%, #fff 15%);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--corner-lg);
      padding: 12px 14px 10px;
      z-index: 10;
    }
    #question-overlay.visible { display: block; }
    #question-overlay-close {
      position: absolute;
      top: 10px;
      right: 12px;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      opacity: 0.7;
      cursor: pointer;
      font-size: 20px;
      z-index: 1;
      line-height: 1;
      padding: 2px 6px;
    }
    #question-overlay-close:hover { opacity: 1; }
    #question-overlay-esc {
      font-size: 11px;
      opacity: 0.4;
      margin-top: 8px;
    }
    .question-card {
      padding: 0;
      margin: 0;
    }
    .question-text {
      font-size: 14px;
      margin-bottom: 10px;
      font-weight: 600;
      word-wrap: break-word;
    }
    .question-header {
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      margin-bottom: 3px;
    }
    .question-options {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .question-option {
      display: flex;
      flex-direction: column;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid #888;
      border-radius: var(--corner-sm);
      padding: 6px 10px;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      font-size: 13px;
      transition: border-color 0.15s, background 0.15s;
    }
    .question-option:hover {
      border-color: var(--claude-orange);
    }
    .question-option-label { font-weight: 600; font-size: 0.9em; }
    .question-option-desc {
      font-size: 0.8em;
      opacity: 0.6;
      margin-top: 1px;
    }
    .question-option.selected {
      border-color: var(--claude-orange);
      background: var(--claude-orange);
      color: #fff;
    }
    .question-answered {
      opacity: 0.5;
      pointer-events: none;
    }
    .question-answered .question-option { cursor: default; }
    .question-multi-submit {
      margin-top: 6px;
      background: var(--claude-clay);
      color: #fff;
      border: none;
      border-radius: var(--corner-sm);
      padding: 5px 12px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      width: 100%;
    }
    .question-multi-submit:hover { opacity: 0.85; }
    .question-other-input {
      margin-top: 4px;
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--corner-sm);
      padding: 5px 8px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }
    .question-other-input:focus { border-color: var(--claude-orange); }

    /* Error / Input Required */
    .msg-error {
      color: var(--dot-error);
      font-size: 13px;
      padding: 2px 0;
    }
    .msg-input-required {
      color: var(--dot-warning);
      font-size: 13px;
      padding: 2px 0;
    }

    /* Input area — rounded rect (not pill), orange focus */
    #input-bar {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #input-row {
      display: flex;
      align-items: flex-end;
      gap: 6px;
    }
    #input-field {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--corner-lg);
      padding: 6px 10px;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      resize: none;
      outline: none;
      overflow-y: auto;
      max-height: calc(1.4em * 8 + 12px);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #input-field:focus {
      border-color: var(--claude-orange);
      box-shadow: 0 0 0 1px var(--claude-orange);
    }

    /* Send button — small square, clay orange */
    #send-btn {
      width: 26px;
      height: 26px;
      min-width: 26px;
      background: var(--claude-clay);
      color: #fff;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin-bottom: 2px;
      transition: opacity 0.15s;
    }
    #send-btn:hover:not(:disabled) { opacity: 0.8; }
    #send-btn:disabled { opacity: 0.3; cursor: default; }
    #send-btn svg { width: 14px; height: 14px; fill: #fff; }
    #send-btn.stop-btn {
      background: var(--dot-error);
    }
    #send-btn.stop-btn svg { display: none; }
    #send-btn.stop-btn::after {
      content: '';
      width: 10px;
      height: 10px;
      background: #fff;
      border-radius: 2px;
    }

    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.4;
      font-size: 12px;
    }

    #qr-section {
      display: none;
      text-align: center;
      padding: 12px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #qr-section p { margin: 4px 0; font-size: 12px; }
    #qr-section img {
      border-radius: var(--corner-md);
      background: white;
      padding: 6px;
      max-width: 100%;
    }
    .qr-url {
      font-size: 10px;
      opacity: 0.5;
      word-break: break-all;
    }
    #dismiss-qr {
      margin-top: 6px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: var(--corner-sm);
      padding: 3px 10px;
      cursor: pointer;
      font-size: 11px;
    }
    #dismiss-qr:hover { opacity: 0.8; }

    /* Thinking indicator — sparkle icon + rotating text */
    .thinking-indicator {
      display: none;
      padding: 4px 12px;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      opacity: 0.6;
    }
    .thinking-indicator.visible { display: flex; }
    .thinking-icon {
      font-size: 16px;
      width: 16px;
      text-align: center;
      flex-shrink: 0;
      color: var(--dot-progress);
    }
    .thinking-text {
      font-style: italic;
    }

    /* Past conversations dropdown */
    #past-conversations {
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #conversation-select {
      width: 100%;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: var(--corner-sm);
      padding: 4px 6px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #conversation-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
  </style>
</head>
<body>
  <div id="share-bar">
    <button id="share-btn">Share to Mobile</button>
  </div>
  <div id="past-conversations" style="display:none;">
    <select id="conversation-select">
      <option value="">Resume a past conversation...</option>
    </select>
  </div>
  <div id="qr-section">
    <p style="font-weight:600;">Scan to connect from your phone</p>
    <img id="qr-img" src="" alt="QR Code" />
    <p class="qr-url" id="qr-url-text"></p>
    <button id="dismiss-qr">Dismiss</button>
  </div>
  <div id="messages">
    <div class="empty-state">Waiting for messages...</div>
  </div>
  <div id="thinking-indicator" class="thinking-indicator">
    <span class="thinking-icon">&middot;</span>
    <span class="thinking-text">Thinking...</span>
  </div>
  <div id="input-bar">
    <div id="input-row">
      <textarea id="input-field" rows="1" placeholder="Message Claude..."></textarea>
      <button id="send-btn"><svg viewBox="0 0 24 24"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z"/></svg></button>
    </div>
    <div id="auto-accept-row">
      <label>
        <input type="checkbox" id="auto-accept-toggle" />
        Auto-accept edits
      </label>
    </div>
  </div>
  <div id="question-overlay">
    <button id="question-overlay-close">&times;</button>
    <div id="question-overlay-content"></div>
    <div id="question-overlay-esc">Esc to cancel</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input-field');
    const sendBtn = document.getElementById('send-btn');
    const shareBtn = document.getElementById('share-btn');
    const qrSection = document.getElementById('qr-section');
    const dismissQr = document.getElementById('dismiss-qr');
    const thinkingIndicator = document.getElementById('thinking-indicator');
    const inputBar = document.getElementById('input-bar');
    const questionOverlay = document.getElementById('question-overlay');
    const questionOverlayContent = document.getElementById('question-overlay-content');
    const questionOverlayClose = document.getElementById('question-overlay-close');
    let hasMessages = false;
    let isProcessing = false;

    // Past conversations dropdown
    const pastConversationsEl = document.getElementById('past-conversations');
    const conversationSelect = document.getElementById('conversation-select');
    let conversationActive = false;

    conversationSelect.addEventListener('change', () => {
      const id = conversationSelect.value;
      if (!id) return;
      conversationActive = true;
      pastConversationsEl.style.display = 'none';
      vscode.postMessage({ type: 'select_conversation', conversationId: id });
    });

    // Share button
    shareBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggle_share' });
    });

    // Auto-accept toggle
    const autoAcceptToggle = document.getElementById('auto-accept-toggle');
    let autoAcceptEnabled = false;

    autoAcceptToggle.addEventListener('change', () => {
      autoAcceptEnabled = autoAcceptToggle.checked;
      vscode.postMessage({
        type: 'set_auto_accept',
        autoAccept: autoAcceptEnabled,
      });
    });

    // Permission cards
    const permissionCards = new Map();

    // Question/permission overlay helpers
    let activeOverlayDismiss = null; // callback when X is clicked

    function showOverlay(card, onDismiss) {
      questionOverlayContent.innerHTML = '';
      questionOverlayContent.appendChild(card);
      questionOverlay.classList.add('visible');
      inputBar.style.display = 'none';
      activeOverlayDismiss = onDismiss || null;
    }

    function hideOverlay() {
      questionOverlay.classList.remove('visible');
      questionOverlayContent.innerHTML = '';
      inputBar.style.display = '';
      activeOverlayDismiss = null;
    }

    function dismissOverlay() {
      if (activeOverlayDismiss) activeOverlayDismiss();
      hideOverlay();
    }

    questionOverlayClose.addEventListener('click', dismissOverlay);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && questionOverlay.classList.contains('visible')) {
        dismissOverlay();
      }
    });

    const THINKING_LABELS = [
      'Thinking', 'Concocting', 'Clauding', 'Finagling',
      'Envisioning', 'Pondering', 'Musing', 'Ruminating',
      'Accomplishing', 'Baking', 'Brewing', 'Calculating',
      'Cerebrating', 'Cogitating', 'Computing', 'Crafting',
    ];
    const SPARKLE_FRAMES = ['\u00B7', '\u2722', '*', '\u2736', '\u273B', '\u273D',
                            '\u273B', '\u2736', '*', '\u2722', '\u00B7'];
    let thinkingTextInterval = null;
    let sparkleInterval = null;
    const thinkingTextEl = document.querySelector('.thinking-text');
    const thinkingIconEl = document.querySelector('.thinking-icon');

    function startThinkingRotation() {
      if (sparkleInterval) return;
      let sparkleIdx = 0;
      let textIdx = Math.floor(Math.random() * THINKING_LABELS.length);
      thinkingTextEl.textContent = THINKING_LABELS[textIdx] + '...';
      thinkingIconEl.textContent = SPARKLE_FRAMES[0];
      sparkleInterval = setInterval(() => {
        sparkleIdx = (sparkleIdx + 1) % SPARKLE_FRAMES.length;
        thinkingIconEl.textContent = SPARKLE_FRAMES[sparkleIdx];
      }, 120);
      thinkingTextInterval = setInterval(() => {
        textIdx = (textIdx + 1) % THINKING_LABELS.length;
        thinkingTextEl.textContent = THINKING_LABELS[textIdx] + '...';
      }, 3000);
    }
    function stopThinkingRotation() {
      if (sparkleInterval) { clearInterval(sparkleInterval); sparkleInterval = null; }
      if (thinkingTextInterval) { clearInterval(thinkingTextInterval); thinkingTextInterval = null; }
    }

    const sendSvg = '<svg viewBox="0 0 24 24"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z"/></svg>';

    function updateSendBtn() {
      if (isProcessing) {
        sendBtn.innerHTML = '';
        sendBtn.classList.add('stop-btn');
        sendBtn.disabled = false;
      } else {
        sendBtn.innerHTML = sendSvg;
        sendBtn.classList.remove('stop-btn');
        sendBtn.disabled = !inputEl.value.trim();
      }
    }
    updateSendBtn();

    // QR code dismiss
    dismissQr.addEventListener('click', () => {
      qrSection.style.display = 'none';
    });

    // Track tool cards by ID for updating with results
    const toolCards = new Map();
    // Current assistant text element for streaming deltas
    let currentAssistantEl = null;
    let currentAssistantText = '';

    function clearEmpty() {
      if (!hasMessages) {
        messagesEl.innerHTML = '';
        hasMessages = true;
      }
    }

    function isNearBottom() {
      const threshold = 80;
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    }

    function scrollToBottom(force) {
      if (force || isNearBottom()) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // --- Lightweight markdown renderer ---
    function renderMarkdown(text) {
      if (!text) return '';

      const codeBlocks = [];
      text = text.replace(/\\\`\\\`\\\`(\\w*)\\n([\\s\\S]*?)\\\`\\\`\\\`/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : '';
        codeBlocks.push('<pre>' + langLabel + '<code>' + escapeHtml(code) + '</code></pre>');
        return '%%CODEBLOCK_' + idx + '%%';
      });

      const lines = text.split('\\n');
      let html = '';
      let inList = false;
      let inTable = false;
      let tableHeader = false;

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        const cbMatch = line.match(/^%%CODEBLOCK_(\\d+)%%$/);
        if (cbMatch) {
          if (inList) { html += '</ul>'; inList = false; }
          if (inTable) { html += '</tbody></table>'; inTable = false; }
          html += codeBlocks[parseInt(cbMatch[1])];
          continue;
        }

        if (line.trim().match(/^\\|.*\\|$/)) {
          if (inList) { html += '</ul>'; inList = false; }
          if (line.trim().match(/^\\|[\\s\\-:|]+\\|$/)) {
            tableHeader = true;
            continue;
          }
          const cells = line.trim().replace(/^\\|\\s*/, '').replace(/\\s*\\|$/, '').split(/\\s*\\|\\s*/);
          if (!inTable) {
            html += '<table><thead><tr>';
            cells.forEach(c => { html += '<th>' + inlineFormat(c) + '</th>'; });
            html += '</tr></thead><tbody>';
            inTable = true;
            tableHeader = false;
          } else {
            html += '<tr>';
            cells.forEach(c => { html += '<td>' + inlineFormat(c) + '</td>'; });
            html += '</tr>';
          }
          continue;
        }

        if (inTable) { html += '</tbody></table>'; inTable = false; }

        if (line.match(/^####\\s/)) {
          if (inList) { html += '</ul>'; inList = false; }
          html += '<h4>' + inlineFormat(line.replace(/^####\\s/, '')) + '</h4>';
          continue;
        }
        if (line.match(/^###?\\s/) || line.match(/^##?\\s/) || line.match(/^#\\s/)) {
          if (inList) { html += '</ul>'; inList = false; }
          html += '<h3>' + inlineFormat(line.replace(/^#+\\s/, '')) + '</h3>';
          continue;
        }

        if (line.match(/^[\\-\\*]\\s/)) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + inlineFormat(line.replace(/^[\\-\\*]\\s/, '')) + '</li>';
          continue;
        }

        if (inList) { html += '</ul>'; inList = false; }

        if (line.trim() === '') {
          html += '<br>';
          continue;
        }

        html += '<p>' + inlineFormat(line) + '</p>';
      }

      if (inList) html += '</ul>';
      if (inTable) html += '</tbody></table>';
      return html;
    }

    function inlineFormat(text) {
      const codes = [];
      text = text.replace(/\\\`([^\\\`]+)\\\`/g, (_, code) => {
        codes.push('<code>' + escapeHtml(code) + '</code>');
        return '%%INLINE_' + (codes.length - 1) + '%%';
      });
      text = escapeHtml(text);
      text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      text = text.replace(/%%INLINE_(\\d+)%%/g, (_, idx) => codes[parseInt(idx)]);
      return text;
    }

    function showPrevTimelineLine() {
      const items = messagesEl.querySelectorAll('.timeline-item');
      if (items.length > 0) {
        const line = items[items.length - 1].querySelector('.timeline-line');
        if (line) line.style.display = '';
      }
    }

    function addUserMessage(content) {
      clearEmpty();
      currentAssistantEl = null;
      const div = document.createElement('div');
      div.className = 'msg-user';
      div.textContent = content;
      messagesEl.appendChild(div);
      scrollToBottom(true);
    }

    function makeTimelineItem(dotClass, dotOffset) {
      const mt = dotOffset || 6;
      const lineTop = 4 + mt + 7; // padding + margin-top + dot height
      const wrapper = document.createElement('div');
      wrapper.className = 'timeline-item';
      wrapper.style.cssText = 'display:grid;grid-template-columns:7px 1fr;column-gap:8px;padding:4px 0;align-items:start;position:relative;';
      const dot = document.createElement('div');
      dot.className = 'timeline-dot ' + dotClass;
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;grid-column:1;grid-row:1;margin-top:' + mt + 'px;position:relative;z-index:1;';
      const line = document.createElement('div');
      line.className = 'timeline-line';
      line.style.cssText = 'position:absolute;left:3px;top:' + lineTop + 'px;bottom:-10px;width:1px;background:var(--vscode-panel-border);display:none;';
      const content = document.createElement('div');
      content.className = 'timeline-content';
      content.style.cssText = 'min-width:0;grid-column:2;grid-row:1;';
      wrapper.appendChild(line);
      wrapper.appendChild(dot);
      wrapper.appendChild(content);
      return { wrapper, dot, line, content };
    }

    function ensureAssistantBlock() {
      if (!currentAssistantEl) {
        clearEmpty();
        showPrevTimelineLine();
        const { wrapper, content } = makeTimelineItem('dot-success');
        content.className = 'timeline-content msg-assistant';
        messagesEl.appendChild(wrapper);
        currentAssistantEl = content;
        currentAssistantText = '';
      }
      return currentAssistantEl;
    }

    function setAssistantContent(text) {
      const el = ensureAssistantBlock();
      currentAssistantText = text.trim();
      el.innerHTML = renderMarkdown(currentAssistantText);
      scrollToBottom(true);
    }

    function appendAssistantDelta(delta) {
      const isNew = !currentAssistantEl;
      ensureAssistantBlock();
      currentAssistantText += delta;
      currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
      scrollToBottom(isNew);
    }

    function formatToolInput(toolName, input) {
      if (!input) return '';
      switch (toolName) {
        case 'Bash': return input.command || '';
        case 'Read': return input.file_path || '';
        case 'Write': return input.file_path || '';
        case 'Edit': {
          let s = input.file_path || '';
          if (input.old_string) s += '\\n--- old\\n' + input.old_string + '\\n+++ new\\n' + (input.new_string || '');
          return s;
        }
        case 'Glob': return input.pattern || '';
        case 'Grep': return (input.pattern || '') + (input.path ? '  in ' + input.path : '');
        case 'WebFetch': return input.url || '';
        case 'WebSearch': return input.query || '';
        default: return JSON.stringify(input, null, 2);
      }
    }

    function addToolCard(toolName, toolId, summary, toolInput) {
      clearEmpty();
      currentAssistantEl = null;
      showPrevTimelineLine();

      const { wrapper, dot, content } = makeTimelineItem('dot-progress', 11);

      const card = document.createElement('div');
      card.className = 'tool-card';
      card.dataset.toolId = toolId || '';
      card.dataset.toolName = toolName || '';

      // Bash: prefer description for header, command stays in IN row
      let displaySummary = summary || '';
      if (toolName === 'Bash' && toolInput?.description) {
        displaySummary = toolInput.description;
      }
      const summaryText = displaySummary ? escapeHtml(displaySummary) : '';
      const inputText = formatToolInput(toolName, toolInput);

      card.innerHTML =
        '<div class="tool-header">' +
          '<span class="tool-name">' + escapeHtml(toolName) + '</span>' +
          '<span class="tool-summary">' + summaryText + '</span>' +
        '</div>' +
        '<div class="tool-body">' +
          '<div class="tool-grid">' +
            '<div class="tool-grid-row" style="display:contents">' +
              '<div class="tool-grid-label">IN</div>' +
              '<div class="tool-grid-content">' + (inputText ? escapeHtml(inputText) : '...') + '</div>' +
            '</div>' +
            '<div class="tool-grid-row" style="display:contents">' +
              '<div class="tool-grid-label">OUT</div>' +
              '<div class="tool-grid-content tool-output">Running...</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      card.querySelector('.tool-header').addEventListener('click', () => {
        card.classList.toggle('collapsed');
      });

      content.appendChild(card);
      messagesEl.appendChild(wrapper);
      if (toolId) toolCards.set(toolId, card);
      scrollToBottom(true);
    }

    function updateToolCard(toolId, summary, toolName, toolInput) {
      const card = toolCards.get(toolId);
      if (!card) return;
      const name = toolName || card.dataset.toolName || '';

      if (summary) {
        const summaryEl = card.querySelector('.tool-summary');
        if (summaryEl) summaryEl.textContent = ' \\u2014 ' + summary;
      }

      if (toolInput) {
        const inputEl = card.querySelector('.tool-input');
        if (inputEl) {
          const inputText = formatToolInput(name, toolInput);
          if (inputText) inputEl.textContent = inputText;
        }
      }
    }

    function updateToolResult(toolId, content, isError) {
      const card = toolCards.get(toolId);
      if (!card) return;

      const outputEl = card.querySelector('.tool-output');

      // Update timeline dot color
      const wrapper = card.closest('.timeline-item');
      if (wrapper) {
        const dot = wrapper.querySelector('.timeline-dot');
        if (dot) {
          dot.classList.remove('dot-progress');
          dot.classList.add(isError ? 'dot-error' : 'dot-success');
        }
      }

      if (isError) {
        card.classList.add('error');
        outputEl.classList.add('is-error');
      }

      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      const maxLen = 5000;
      outputEl.textContent = text.length > maxLen
        ? text.substring(0, maxLen) + '\\n... (truncated)'
        : text;
    }

    function addQuestionCard(questions) {
      clearEmpty();
      currentAssistantEl = null;

      const container = document.createElement('div');

      for (const q of questions) {
        const card = document.createElement('div');
        card.className = 'question-card';

        let html = '';
        if (q.header) {
          html += '<div class="question-header">' + escapeHtml(q.header) + '</div>';
        }
        html += '<div class="question-text">' + escapeHtml(q.question) + '</div>';
        html += '<div class="question-options">';

        const options = q.options || [];
        for (const opt of options) {
          html += '<button class="question-option" data-label="' + escapeHtml(opt.label) + '">';
          html += '<span class="question-option-label">' + escapeHtml(opt.label) + '</span>';
          if (opt.description) {
            html += '<span class="question-option-desc">' + escapeHtml(opt.description) + '</span>';
          }
          html += '</button>';
        }
        html += '<button class="question-option" data-label="__other__">';
        html += '<span class="question-option-label">Other</span>';
        html += '<span class="question-option-desc">Type a custom response</span>';
        html += '</button>';
        html += '</div>';

        if (q.multiSelect) {
          html += '<button class="question-multi-submit" style="display:none">Submit</button>';
        }

        card.innerHTML = html;

        const isMulti = !!q.multiSelect;
        const selected = new Set();

        card.querySelectorAll('.question-option').forEach(btn => {
          btn.addEventListener('click', () => {
            const label = btn.dataset.label;

            if (label === '__other__') {
              if (!card.querySelector('.question-other-input')) {
                const input = document.createElement('input');
                input.className = 'question-other-input';
                input.placeholder = 'Type your response...';
                input.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter' && input.value.trim()) {
                    sendAnswer(card, input.value.trim());
                  }
                });
                card.appendChild(input);
                input.focus();
              }
              return;
            }

            if (isMulti) {
              btn.classList.toggle('selected');
              if (selected.has(label)) selected.delete(label); else selected.add(label);
              const submitBtn = card.querySelector('.question-multi-submit');
              if (submitBtn) submitBtn.style.display = selected.size > 0 ? 'block' : 'none';
            } else {
              sendAnswer(card, label);
            }
          });
        });

        if (isMulti) {
          const submitBtn = card.querySelector('.question-multi-submit');
          if (submitBtn) {
            submitBtn.addEventListener('click', () => {
              if (selected.size > 0) sendAnswer(card, Array.from(selected).join(', '));
            });
          }
        }

        container.appendChild(card);
      }

      showOverlay(container, () => {
        // X / Esc = deny this tool, Claude continues
        vscode.postMessage({ type: 'dismiss_question' });
      });
    }

    function sendAnswer(card, answer) {
      card.classList.add('question-answered');
      hideOverlay();
      vscode.postMessage({ type: 'user_message', content: answer });
    }

    function getPermissionQuestion(toolName, toolInput) {
      const input = formatToolInput(toolName, toolInput);
      const short = input ? input.substring(0, 200) : '';
      switch (toolName) {
        case 'Edit': case 'Write': case 'NotebookEdit':
          return 'Make this edit to ' + (toolInput?.file_path || toolInput?.notebook_path || 'file') + '?';
        case 'Bash':
          return 'Run this command?' + (short ? '\\n' + short : '');
        default:
          return 'Allow ' + toolName + '?' + (short ? '\\n' + short : '');
      }
    }

    function addPermissionCard(permissionId, toolName, toolInput, summary) {
      clearEmpty();
      currentAssistantEl = null;

      const card = document.createElement('div');
      card.className = 'question-card';
      card.dataset.permissionId = permissionId;

      const questionText = getPermissionQuestion(toolName, toolInput);

      let html = '<div class="question-header">' + escapeHtml(toolName) + '</div>';
      html += '<div class="question-text">' + escapeHtml(questionText) + '</div>';
      html += '<div class="question-options">';
      html += '<button class="question-option" data-action="allow"><span class="question-option-label">Yes</span></button>';
      html += '<button class="question-option" data-action="allow-all"><span class="question-option-label">Yes, allow all edits this session</span></button>';
      html += '<button class="question-option" data-action="deny"><span class="question-option-label">No</span></button>';
      html += '</div>';

      card.innerHTML = html;

      function resolveCard(action, message) {
        card.classList.add('question-answered');
        hideOverlay();
        vscode.postMessage({ type: 'permission_response', permissionId, action });
        if (action === 'allow' && message === 'allow-all') {
          autoAcceptToggle.checked = true;
          autoAcceptEnabled = true;
          vscode.postMessage({ type: 'set_auto_accept', autoAccept: true });
        }
      }

      card.querySelectorAll('.question-option').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'allow' || action === 'allow-all') {
            btn.classList.add('selected');
            resolveCard('allow', action);
          } else if (action === 'deny') {
            btn.classList.add('selected');
            resolveCard('deny');
          }
        });
      });

      // Free text: "Tell Claude what to do instead"
      const otherInput = document.createElement('input');
      otherInput.className = 'question-other-input';
      otherInput.placeholder = 'Tell Claude what to do instead';
      otherInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && otherInput.value.trim()) {
          resolveCard('deny');
          vscode.postMessage({ type: 'user_message', content: otherInput.value.trim() });
        } else if (e.key === 'Escape') {
          // Let it bubble to the global Escape handler which calls dismissOverlay()
          otherInput.blur();
        }
      });
      card.appendChild(otherInput);

      permissionCards.set(permissionId, card);

      showOverlay(card, () => {
        // X / Esc = deny this tool, Claude continues
        resolveCard('deny');
      });
    }

    // --- Handle messages from the extension ---
    window.addEventListener('message', (event) => {
      try {
        const msg = event.data;

        if (msg.type === 'claude_output' && msg.message) {
          const m = msg.message;

          if (m.role === 'user') {
            const text = typeof m.content === 'string' ? m.content : '';
            if (text) addUserMessage(text);
          } else if (m.type === 'assistant_message') {
            thinkingIndicator.classList.remove('visible');
            stopThinkingRotation();
            if (m.content) setAssistantContent(m.content);
          } else if (m.type === 'text_block_start') {
            currentAssistantText = '';
          } else if (m.type === 'assistant_delta') {
            thinkingIndicator.classList.remove('visible');
            stopThinkingRotation();
            appendAssistantDelta(m.content || '');
          } else if (m.type === 'ask_question') {
            addQuestionCard(m.questions || []);
          } else if (m.type === 'tool_use_start') {
            thinkingIndicator.classList.remove('visible');
            stopThinkingRotation();
            if (m.toolName === 'AskUserQuestion') {
              // Handled via canUseTool → ask_question event; never show as tool card
            } else {
              addToolCard(m.toolName || 'Tool', m.toolId, m.summary || '', m.toolInput);
            }
          } else if (m.type === 'tool_use_update') {
            if (m.toolName === 'AskUserQuestion') {
              // Handled via canUseTool → ask_question event; skip
            } else {
              updateToolCard(m.toolId, m.summary || '', m.toolName, m.toolInput);
            }
          } else if (m.type === 'tool_use_delta') {
            // no-op
          } else if (m.type === 'tool_result') {
            updateToolResult(m.toolId, m.content, m.isError);
            thinkingIndicator.classList.add('visible');
            startThinkingRotation();
            scrollToBottom(true);
          } else if (m.type === 'question_answered') {
            hideOverlay();
          } else if (m.type === 'permission_request') {
            thinkingIndicator.classList.remove('visible');
            stopThinkingRotation();
            addPermissionCard(m.permissionId, m.toolName, m.toolInput, m.summary);
          } else if (m.type === 'permission_resolved') {
            hideOverlay();
          } else if (m.type === 'result') {
            currentAssistantEl = null;
          } else if (m.type === 'error') {
            clearEmpty();
            showPrevTimelineLine();
            const { wrapper, content } = makeTimelineItem('dot-error');
            content.className = 'timeline-content msg-error';
            content.textContent = m.content || 'An error occurred';
            messagesEl.appendChild(wrapper);
            scrollToBottom(true);
          }
        } else if (msg.type === 'session_status') {
          isProcessing = msg.status === 'processing' || msg.status === 'permission_required';
          updateSendBtn();
          if (msg.status === 'processing') {
            thinkingIndicator.classList.add('visible');
            startThinkingRotation();
            scrollToBottom(true);
          } else {
            thinkingIndicator.classList.remove('visible');
            stopThinkingRotation();
          }
        } else if (msg.type === 'auto_accept_changed') {
          autoAcceptEnabled = msg.autoAccept;
          autoAcceptToggle.checked = autoAcceptEnabled;
        } else if (msg.type === 'share_status') {
          if (msg.status === 'loading') {
            shareBtn.textContent = 'Sharing...';
            shareBtn.disabled = true;
            shareBtn.classList.remove('shared');
          } else if (msg.status === 'shared') {
            shareBtn.textContent = 'Stop Sharing';
            shareBtn.disabled = false;
            shareBtn.classList.add('shared');
          } else {
            shareBtn.textContent = 'Share to Mobile';
            shareBtn.disabled = false;
            shareBtn.classList.remove('shared');
          }
        } else if (msg.type === 'show_qr') {
          document.getElementById('qr-img').src = msg.qrDataUrl;
          document.getElementById('qr-url-text').textContent = msg.qrUrl || '';
          qrSection.style.display = 'block';
        } else if (msg.type === 'hide_qr') {
          qrSection.style.display = 'none';
        } else if (msg.type === 'conversations_list') {
          if (conversationActive || hasMessages) return;
          const convos = msg.conversations || [];
          if (convos.length === 0) return;
          conversationSelect.innerHTML = '<option value="">Resume a past conversation...</option>';
          for (const c of convos) {
            const opt = document.createElement('option');
            opt.value = c.conversationId;
            const date = new Date(c.mtime).toLocaleDateString();
            const summary = c.summary.length > 60 ? c.summary.substring(0, 60) + '...' : c.summary;
            opt.textContent = summary + ' (' + date + ')';
            conversationSelect.appendChild(opt);
          }
          pastConversationsEl.style.display = '';
        } else if (msg.type === 'conversation_history') {
          const msgs = msg.messages || [];
          for (const m of msgs) {
            if (m.role === 'user') {
              addUserMessage(m.text);
            } else if (m.role === 'assistant') {
              setAssistantContent(m.text);
            }
          }
        } else if (msg.type === 'conversation_resumed') {
          conversationActive = true;
          pastConversationsEl.style.display = 'none';
        } else if (msg.type === 'input_required') {
          // Question card already shown via ask_question event; just stop thinking
          thinkingIndicator.classList.remove('visible');
          stopThinkingRotation();
        }
      } catch (err) {
        console.error('[Remote Clauding] Message handler error:', err);
      }
    });

    // Auto-resize textarea
    const maxHeight = parseFloat(getComputedStyle(inputEl).maxHeight) || Infinity;
    function autoResize() {
      inputEl.style.height = 'auto';
      inputEl.style.overflow = 'hidden';
      const newHeight = inputEl.scrollHeight;
      inputEl.style.height = newHeight + 'px';
      if (newHeight >= maxHeight) {
        inputEl.style.overflow = 'auto';
      }
    }
    inputEl.addEventListener('input', () => {
      autoResize();
      updateSendBtn();
    });

    // Send message
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      conversationActive = true;
      pastConversationsEl.style.display = 'none';
      vscode.postMessage({ type: 'user_message', content: text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      updateSendBtn();
      inputEl.focus();
    }

    function stop() {
      vscode.postMessage({ type: 'stop_message' });
    }

    sendBtn.addEventListener('click', () => {
      if (isProcessing) stop(); else send();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // Request saved history from extension
    vscode.postMessage({ type: 'webview_ready' });
    // Request past conversations for dropdown
    vscode.postMessage({ type: 'fetch_conversations' });
  </script>
</body>
</html>`;
}

class ChatPanel {
  static panels = new Map(); // id -> ChatPanel

  constructor(extensionUri, workspaceState, viewColumn, forceNew = true, existingPanel = null) {
    this._extensionUri = extensionUri;
    this._workspaceState = workspaceState;
    this._forceNew = forceNew;
    this._disposed = false;
    this._id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this._agentWs = null;
    this._currentSessionId = null;
    this._currentSessionToken = null;
    this._currentRelayUrl = null;
    this._isShared = false;
    this._autoAccept = false;
    this._resumeConversationId = null;
    this._messageHistory = workspaceState.get(`chatPanel_${this._id}_history`, []);

    if (existingPanel) {
      // Restoring from a serialized panel (VSCode reload)
      this._panel = existingPanel;
      this._panel.webview.options = { enableScripts: true };
    } else {
      this._panel = vscode.window.createWebviewPanel(
        'remote-clauding.chatPanel',
        'Remote Clauding',
        viewColumn || vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
    }

    this._panel.webview.html = getHtml();
    this._connectAgentWs();

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'webview_ready') {
        for (const savedMsg of this._messageHistory) {
          this._panel.webview.postMessage(savedMsg);
        }
        return;
      } else if (msg.type === 'clear_history') {
        this._messageHistory = [];
        this._workspaceState.update(`chatPanel_${this._id}_history`, []);
        return;
      } else if (msg.type === 'user_message') {
        await this._ensureSession();
        if (this._currentSessionId && this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'user_message',
            sessionId: this._currentSessionId,
            content: msg.content,
          }));
        }
      } else if (msg.type === 'stop_message' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'stop_message',
            sessionId: this._currentSessionId,
          }));
        }
      } else if (msg.type === 'toggle_share') {
        if (this._isShared) {
          this._stopSharing();
        } else {
          this._startSharing();
        }
      } else if (msg.type === 'set_auto_accept') {
        this._autoAccept = msg.autoAccept;
        if (this._currentSessionId && this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'set_auto_accept',
            sessionId: this._currentSessionId,
            autoAccept: msg.autoAccept,
          }));
        }
      } else if (msg.type === 'permission_response' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'permission_response',
            sessionId: this._currentSessionId,
            permissionId: msg.permissionId,
            action: msg.action,
          }));
        }
      } else if (msg.type === 'dismiss_question' && this._currentSessionId) {
        if (this._agentWs && this._agentWs.readyState === WebSocket.OPEN) {
          this._agentWs.send(JSON.stringify({
            type: 'dismiss_question',
            sessionId: this._currentSessionId,
          }));
        }
      } else if (msg.type === 'fetch_conversations') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        try {
          const result = await agentRequest('GET',
            `/conversations?projectPath=${encodeURIComponent(workspaceFolder.uri.fsPath)}`);
          this._postMessage({ type: 'conversations_list', conversations: result.conversations || [] });
        } catch {}
      } else if (msg.type === 'select_conversation') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        try {
          this._resumeConversationId = msg.conversationId;
          ChatPanel._savePanelRegistry(this._workspaceState);
          const result = await agentRequest('POST', '/sessions', {
            projectPath: workspaceFolder.uri.fsPath,
            projectName: workspaceFolder.name,
            forceNew: true,
            resumeConversationId: msg.conversationId,
          });
          if (result.session) {
            this._currentSessionId = result.session.id;
            this._currentSessionToken = result.session.sessionToken;
          }
          const history = await agentRequest('GET',
            `/conversations/${msg.conversationId}?projectPath=${encodeURIComponent(workspaceFolder.uri.fsPath)}`);
          this._postMessage({ type: 'conversation_history', messages: history.messages || [] });
          this._postMessage({ type: 'conversation_resumed', conversationId: msg.conversationId });
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to resume conversation: ${err.message}`);
        }
      }
    });

    this._panel.onDidDispose(() => {
      this._disposed = true;
      if (this._currentSessionId && this._isShared) {
        agentRequest('POST', `/sessions/${this._currentSessionId}/unshare`).catch(() => {});
      }
      if (this._agentWs) {
        this._agentWs.close();
      }
      ChatPanel.panels.delete(this._id);
      ChatPanel._savePanelRegistry(this._workspaceState);
    });

    ChatPanel.panels.set(this._id, this);
    ChatPanel._savePanelRegistry(this._workspaceState);
  }

  async _ensureSession() {
    if (this._currentSessionId) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    try {
      const result = await agentRequest('POST', '/sessions', {
        projectPath: workspaceFolder.uri.fsPath,
        projectName: workspaceFolder.name,
        forceNew: this._forceNew,
      });

      if (result.session) {
        this._currentSessionId = result.session.id;
        this._currentSessionToken = result.session.sessionToken;
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to create session: ${err.message}. Is the agent running?`
      );
    }
  }

  async _startSharing() {
    try {
      this._postMessage({ type: 'share_status', status: 'loading' });
      await this._ensureSession();
      if (!this._currentSessionId) {
        this._postMessage({ type: 'share_status', status: 'idle' });
        return;
      }
      await agentRequest('POST', `/sessions/${this._currentSessionId}/reshare`);
      this._isShared = true;
      if (!this._currentRelayUrl) {
        const health = await agentRequest('GET', '/health');
        this._currentRelayUrl = health.relayPublicUrl || '';
      }
      await this._showQr();
      this._postMessage({ type: 'share_status', status: 'shared' });
    } catch (err) {
      this._postMessage({ type: 'share_status', status: 'idle' });
      vscode.window.showErrorMessage(
        `Failed to share: ${err.message}. Is the agent running?`
      );
    }
  }

  async _stopSharing() {
    if (!this._currentSessionId) return;
    try {
      await agentRequest('POST', `/sessions/${this._currentSessionId}/unshare`);
      this._isShared = false;
      this._postMessage({ type: 'share_status', status: 'idle' });
      this._postMessage({ type: 'hide_qr' });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to stop sharing: ${err.message}`);
    }
  }

  async _showQr() {
    if (this._currentRelayUrl && this._currentSessionToken) {
      const qrUrl = `${this._currentRelayUrl}/#/pair/${this._currentSessionToken}`;
      const qrDataUrl = await QRCode.toDataURL(qrUrl, {
        width: 280, margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
      this._postMessage({ type: 'show_qr', qrDataUrl, qrUrl });
    }
  }

  _connectAgentWs() {
    if (this._agentWs) {
      this._agentWs.close();
    }
    this._agentWs = new WebSocket(AGENT_WS_URL);
    this._agentWs.on('open', () => {
      console.log(`[Remote Clauding] ChatPanel ${this._id} WS connected`);
    });
    this._agentWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Only forward messages for this panel's session
        if (msg.sessionId && msg.sessionId !== this._currentSessionId) return;
        this._postMessage(msg);
      } catch {}
    });
    this._agentWs.on('close', () => {
      console.log(`[Remote Clauding] ChatPanel ${this._id} WS disconnected`);
    });
    this._agentWs.on('error', (err) => {
      console.error(`[Remote Clauding] ChatPanel ${this._id} WS error:`, err.message);
    });
  }

  _postMessage(msg) {
    if (msg.type === 'claude_output' && msg.message) {
      this._messageHistory.push(msg);
      if (this._messageHistory.length > 500) {
        this._messageHistory = this._messageHistory.slice(-500);
      }
      this._workspaceState.update(`chatPanel_${this._id}_history`, this._messageHistory);
    }
    this._panel.webview.postMessage(msg);
  }

  dispose() {
    this._panel.dispose();
  }

  static _savePanelRegistry(workspaceState) {
    const entries = [];
    for (const [id, panel] of ChatPanel.panels) {
      entries.push({ id, viewColumn: panel._panel.viewColumn, resumeConversationId: panel._resumeConversationId || null });
    }
    workspaceState.update('chatPanels', entries);
  }

  // Restore a panel from a serialized webview (VSCode reload)
  static restore(panel, extensionUri, workspaceState) {
    const savedPanels = workspaceState.get('chatPanels', []);
    const cp = new ChatPanel(extensionUri, workspaceState, panel.viewColumn, true, panel);
    // Find matching saved entry to restore resumeConversationId
    // Use the first unmatched entry since IDs are regenerated
    if (savedPanels.length > 0) {
      const entry = savedPanels.shift();
      if (entry.resumeConversationId) {
        cp._resumeConversationId = entry.resumeConversationId;
      }
      workspaceState.update('chatPanels', savedPanels);
    }
    return cp;
  }
}

let provider;

function activate(context) {
  // Set context for secondary sidebar support (modern VSCode always supports it)
  vscode.commands.executeCommand('setContext', 'remote-clauding:doesNotSupportSecondarySidebar', false);

  provider = new ChatViewProvider(context.extensionUri, context.workspaceState);

  // Register for primary sidebar (fallback on old VSCode)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'remote-clauding.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register for secondary sidebar (modern VSCode)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'remote-clauding.chatViewSecondary',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Toggle share command
  context.subscriptions.push(
    vscode.commands.registerCommand('remote-clauding.toggleShare', () => {
      if (provider._isShared) {
        provider._stopSharing();
      } else {
        provider._startSharing();
      }
    })
  );

  // Open panel — opens a new editor tab in the same editor group as the clicked icon
  context.subscriptions.push(
    vscode.commands.registerCommand('remote-clauding.openPanel', () => {
      const activeGroup = vscode.window.tabGroups.activeTabGroup;
      const viewColumn = activeGroup ? activeGroup.viewColumn : vscode.ViewColumn.Active;
      new ChatPanel(context.extensionUri, context.workspaceState, viewColumn, true);
    })
  );

  // New Chat command — alias for openPanel
  context.subscriptions.push(
    vscode.commands.registerCommand('remote-clauding.newChat', () => {
      new ChatPanel(context.extensionUri, context.workspaceState, vscode.ViewColumn.Active, true);
    })
  );

  // Restore panels on VSCode reload
  vscode.window.registerWebviewPanelSerializer('remote-clauding.chatPanel', {
    async deserializeWebviewPanel(panel) {
      const cp = ChatPanel.restore(panel, context.extensionUri, context.workspaceState);
      // If this panel had a conversation, load its history from JSONL
      if (cp._resumeConversationId) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          try {
            const history = await agentRequest('GET',
              `/conversations/${cp._resumeConversationId}?projectPath=${encodeURIComponent(workspaceFolder.uri.fsPath)}`);
            cp._postMessage({ type: 'conversation_history', messages: history.messages || [] });
            cp._postMessage({ type: 'conversation_resumed', conversationId: cp._resumeConversationId });
          } catch {}
        }
      }
    }
  });
}

function deactivate() {
  if (provider) {
    provider.dispose();
  }
  for (const panel of ChatPanel.panels.values()) {
    panel.dispose();
  }
}

function agentRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, AGENT_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid response: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

module.exports = { activate, deactivate };
