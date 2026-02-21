const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');

const AGENT_URL = 'http://127.0.0.1:9680';
const AGENT_WS_URL = 'ws://127.0.0.1:9680/ws';

let statusBarItem;
let currentSessionId = null;
let chatPanel = null;
let agentWs = null;

function activate(context) {
  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'remote-clauding.toggleShare';
  updateStatusBar(false);
  statusBarItem.show();

  // Register commands
  const toggleCmd = vscode.commands.registerCommand(
    'remote-clauding.toggleShare',
    toggleShare
  );

  const openPanelCmd = vscode.commands.registerCommand(
    'remote-clauding.openPanel',
    () => openChatPanel(context)
  );

  context.subscriptions.push(statusBarItem, toggleCmd, openPanelCmd);

  // Check agent health on startup
  checkAgentHealth();
}

function deactivate() {
  if (currentSessionId) {
    stopSharing().catch(() => {});
  }
  if (agentWs) {
    agentWs.close();
  }
}

async function toggleShare() {
  if (currentSessionId) {
    await stopSharing();
  } else {
    await startSharing();
  }
}

async function startSharing() {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('No workspace folder open');
    return;
  }

  const projectPath = workspaceFolder.uri.fsPath;
  const projectName = workspaceFolder.name;

  try {
    updateStatusBar(null); // Loading state

    const result = await agentRequest('POST', '/sessions/share', {
      projectPath,
      projectName,
    });

    if (result.session) {
      currentSessionId = result.session.id;
      updateStatusBar(true);

      // Connect WebSocket and open chat panel
      connectAgentWs();
      openChatPanel();

      if (result.alreadyShared) {
        vscode.window.showInformationMessage(
          `"${projectName}" is already shared to mobile`
        );
      } else {
        vscode.window.showInformationMessage(
          `"${projectName}" shared to mobile! A push notification has been sent.`
        );
      }
    }
  } catch (err) {
    updateStatusBar(false);
    vscode.window.showErrorMessage(
      `Failed to share: ${err.message}. Is the agent running?`
    );
  }
}

async function stopSharing() {
  if (!currentSessionId) return;

  try {
    await agentRequest('DELETE', `/sessions/${currentSessionId}`);
    currentSessionId = null;
    updateStatusBar(false);

    if (agentWs) {
      agentWs.close();
      agentWs = null;
    }

    vscode.window.showInformationMessage('Session sharing stopped');
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to stop sharing: ${err.message}`);
  }
}

// --- WebSocket connection to agent ---

function connectAgentWs() {
  if (agentWs) {
    agentWs.close();
  }

  agentWs = new WebSocket(AGENT_WS_URL);

  agentWs.on('open', () => {
    console.log('[Remote Clauding] WebSocket connected to agent');
  });

  agentWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Forward to webview panel
      if (chatPanel) {
        chatPanel.webview.postMessage(msg);
      }
    } catch {}
  });

  agentWs.on('close', () => {
    console.log('[Remote Clauding] WebSocket disconnected');
  });

  agentWs.on('error', (err) => {
    console.error('[Remote Clauding] WebSocket error:', err.message);
  });
}

// --- Chat Webview Panel ---

function openChatPanel() {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Two);
    return;
  }

  chatPanel = vscode.window.createWebviewPanel(
    'remoteClaудingChat',
    'Remote Clauding',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  chatPanel.webview.html = getChatPanelHtml();

  // Handle messages from the webview (user typed a message)
  chatPanel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === 'user_message' && currentSessionId) {
      // Send to agent via WebSocket
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({
          type: 'user_message',
          sessionId: currentSessionId,
          content: msg.content,
        }));
      }
    }
  });

  chatPanel.onDidDispose(() => {
    chatPanel = null;
  });
}

function getChatPanelHtml() {
  return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      line-height: 1.5;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    /* User message */
    .msg-user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
      padding: 8px 12px;
      border-radius: 12px 12px 2px 12px;
      max-width: 85%;
      word-break: break-word;
      margin-top: 8px;
    }

    /* Assistant text block */
    .msg-assistant {
      padding: 4px 0;
      max-width: 100%;
      word-break: break-word;
    }
    .msg-assistant h3 { font-size: 1.1em; margin: 8px 0 4px; }
    .msg-assistant h4 { font-size: 1em; margin: 6px 0 2px; }
    .msg-assistant p { margin: 4px 0; }
    .msg-assistant ul, .msg-assistant ol { margin: 4px 0 4px 20px; }
    .msg-assistant li { margin: 2px 0; }
    .msg-assistant a { color: var(--vscode-textLink-foreground); }
    .msg-assistant strong { font-weight: 600; }
    .msg-assistant code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .msg-assistant pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
      padding: 10px 12px;
      margin: 6px 0;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.4;
    }
    .msg-assistant pre code {
      background: none;
      padding: 0;
      font-size: inherit;
    }
    .code-lang {
      font-size: 10px;
      opacity: 0.5;
      text-transform: uppercase;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    /* Tool card */
    .tool-card {
      border-left: 3px solid var(--vscode-textLink-foreground);
      border-radius: 0 6px 6px 0;
      background: var(--vscode-textBlockQuote-background);
      margin: 3px 0;
      overflow: hidden;
    }
    .tool-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
    }
    .tool-header:hover { opacity: 0.8; }
    .tool-icon { font-size: 14px; flex-shrink: 0; }
    .tool-name { font-weight: 600; flex-shrink: 0; }
    .tool-summary {
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .tool-status { flex-shrink: 0; font-size: 13px; }
    .tool-status-running { color: var(--vscode-charts-yellow, #cca700); }
    .tool-status-success { color: var(--vscode-charts-green, #388a34); }
    .tool-status-error { color: var(--vscode-errorForeground, #f85149); }
    .tool-body {
      display: none;
      padding: 0 10px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      line-height: 1.4;
    }
    .tool-card.expanded .tool-body { display: block; }
    .tool-input, .tool-output {
      max-height: 200px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
      padding: 6px 8px;
      border-radius: 4px;
      margin: 4px 0;
      background: var(--vscode-editor-background);
    }
    .tool-section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .tool-output-error { color: var(--vscode-errorForeground, #f85149); }

    /* AskUserQuestion */
    .question-card {
      border-left: 3px solid var(--vscode-charts-orange, #cca700);
      border-radius: 0 6px 6px 0;
      background: var(--vscode-textBlockQuote-background);
      margin: 6px 0;
      padding: 10px 12px;
    }
    .question-text {
      font-size: 13px;
      margin-bottom: 8px;
      font-weight: 500;
    }
    .question-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      margin-bottom: 4px;
    }
    .question-options {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .question-option {
      display: flex;
      flex-direction: column;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      font-size: 13px;
      transition: border-color 0.15s;
    }
    .question-option:hover {
      border-color: var(--vscode-focusBorder);
    }
    .question-option-label { font-weight: 600; }
    .question-option-desc {
      font-size: 11px;
      opacity: 0.7;
      margin-top: 2px;
    }
    .question-option.selected {
      border-color: var(--vscode-button-background);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .question-answered {
      opacity: 0.6;
      pointer-events: none;
    }
    .question-answered .question-option { cursor: default; }
    .question-multi-submit {
      margin-top: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
    }
    .question-multi-submit:hover { background: var(--vscode-button-hoverBackground); }
    .question-other-input {
      margin-top: 4px;
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }
    .question-other-input:focus { border-color: var(--vscode-focusBorder); }

    /* Error / Input Required */
    .msg-error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
    }
    .msg-input-required {
      background: var(--vscode-inputValidation-warningBackground);
      border: 1px solid var(--vscode-inputValidation-warningBorder);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
    }

    /* Input bar */
    #input-bar {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #input-field {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px 10px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      outline: none;
    }
    #input-field:focus { border-color: var(--vscode-focusBorder); }
    #send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      cursor: pointer;
      font-weight: 600;
    }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    .empty-state {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <div id="messages">
    <div class="empty-state">Waiting for messages...</div>
  </div>
  <div id="input-bar">
    <textarea id="input-field" rows="1" placeholder="Message Claude..."></textarea>
    <button id="send-btn">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input-field');
    const sendBtn = document.getElementById('send-btn');
    let hasMessages = false;

    // Track tool cards by ID for updating with results
    const toolCards = new Map();
    // Current assistant text element for streaming deltas
    let currentAssistantEl = null;
    let currentAssistantText = '';

    const TOOL_ICONS = {
      Read: '\u{1F4C4}', Edit: '\u{270F}\u{FE0F}', Write: '\u{1F4DD}',
      Bash: '\u{1F4BB}', Glob: '\u{1F4C2}', Grep: '\u{1F50E}',
      WebFetch: '\u{1F310}', WebSearch: '\u{1F50D}',
      TodoWrite: '\u{2705}', Task: '\u{1F4CB}',
      NotebookEdit: '\u{1F4D3}',
    };

    function clearEmpty() {
      if (!hasMessages) {
        messagesEl.innerHTML = '';
        hasMessages = true;
      }
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // --- Lightweight markdown renderer ---
    function renderMarkdown(text) {
      if (!text) return '';

      // Fenced code blocks — extract them first to protect from inline processing
      const codeBlocks = [];
      text = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<div class="code-lang">' + escapeHtml(lang) + '</div>' : '';
        codeBlocks.push('<pre>' + langLabel + '<code>' + escapeHtml(code) + '</code></pre>');
        return '%%CODEBLOCK_' + idx + '%%';
      });

      // Process inline formatting on remaining text
      const lines = text.split('\\n');
      let html = '';
      let inList = false;

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Check for code block placeholder
        const cbMatch = line.match(/^%%CODEBLOCK_(\\d+)%%$/);
        if (cbMatch) {
          if (inList) { html += '</ul>'; inList = false; }
          html += codeBlocks[parseInt(cbMatch[1])];
          continue;
        }

        // Headers
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

        // List items
        if (line.match(/^[\\-\\*]\\s/)) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + inlineFormat(line.replace(/^[\\-\\*]\\s/, '')) + '</li>';
          continue;
        }

        // Close list if we hit a non-list line
        if (inList) { html += '</ul>'; inList = false; }

        // Empty line = paragraph break
        if (line.trim() === '') {
          html += '<br>';
          continue;
        }

        // Regular text
        html += '<p>' + inlineFormat(line) + '</p>';
      }

      if (inList) html += '</ul>';
      return html;
    }

    function inlineFormat(text) {
      // Inline code (protect first)
      const codes = [];
      text = text.replace(/\`([^\`]+)\`/g, (_, code) => {
        codes.push('<code>' + escapeHtml(code) + '</code>');
        return '%%INLINE_' + (codes.length - 1) + '%%';
      });
      // Bold
      text = escapeHtml(text);
      text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      // Italic
      text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      // Links
      text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
      // Restore inline codes
      text = text.replace(/%%INLINE_(\\d+)%%/g, (_, idx) => codes[parseInt(idx)]);
      return text;
    }

    // --- Add user message ---
    function addUserMessage(content) {
      clearEmpty();
      currentAssistantEl = null;
      const div = document.createElement('div');
      div.className = 'msg-user';
      div.textContent = content;
      messagesEl.appendChild(div);
      scrollToBottom();
    }

    // --- Assistant text block ---
    function ensureAssistantBlock() {
      if (!currentAssistantEl) {
        clearEmpty();
        const div = document.createElement('div');
        div.className = 'msg-assistant';
        messagesEl.appendChild(div);
        currentAssistantEl = div;
        currentAssistantText = '';
      }
      return currentAssistantEl;
    }

    function setAssistantContent(text) {
      const el = ensureAssistantBlock();
      currentAssistantText = text;
      el.innerHTML = renderMarkdown(text);
      scrollToBottom();
    }

    function appendAssistantDelta(delta) {
      ensureAssistantBlock();
      currentAssistantText += delta;
      currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
      scrollToBottom();
    }

    // --- Tool card ---
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

      const card = document.createElement('div');
      card.className = 'tool-card';
      card.dataset.toolId = toolId || '';
      card.dataset.toolName = toolName || '';

      const icon = TOOL_ICONS[toolName] || '\u{1F527}';
      const summaryText = summary ? ' \u2014 ' + escapeHtml(summary) : '';
      const inputText = formatToolInput(toolName, toolInput);

      card.innerHTML =
        '<div class="tool-header">' +
          '<span class="tool-icon">' + icon + '</span>' +
          '<span class="tool-name">' + escapeHtml(toolName) + '</span>' +
          '<span class="tool-summary">' + summaryText + '</span>' +
          '<span class="tool-status tool-status-running">\u25CB</span>' +
        '</div>' +
        '<div class="tool-body">' +
          '<div class="tool-section-label">Input</div>' +
          '<div class="tool-input">' + (inputText ? escapeHtml(inputText) : '...') + '</div>' +
          '<div class="tool-section-label">Output</div>' +
          '<div class="tool-output">Running...</div>' +
        '</div>';

      card.querySelector('.tool-header').addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      messagesEl.appendChild(card);
      if (toolId) toolCards.set(toolId, card);
      scrollToBottom();
    }

    function updateToolCard(toolId, summary, toolName, toolInput) {
      const card = toolCards.get(toolId);
      if (!card) return;
      const name = toolName || card.dataset.toolName || '';

      if (summary) {
        const summaryEl = card.querySelector('.tool-summary');
        if (summaryEl) summaryEl.textContent = ' \u2014 ' + summary;
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

      const statusEl = card.querySelector('.tool-status');
      const outputEl = card.querySelector('.tool-output');

      if (isError) {
        statusEl.className = 'tool-status tool-status-error';
        statusEl.textContent = '\u2717';
        outputEl.className = 'tool-output tool-output-error';
      } else {
        statusEl.className = 'tool-status tool-status-success';
        statusEl.textContent = '\u2713';
      }

      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      const maxLen = 5000;
      outputEl.textContent = text.length > maxLen
        ? text.substring(0, maxLen) + '\\n... (truncated)'
        : text;
    }

    // --- AskUserQuestion card ---
    function addQuestionCard(questions) {
      clearEmpty();
      currentAssistantEl = null;

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
        // "Other" option with free text
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
              // Show free text input
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

        messagesEl.appendChild(card);
      }
      scrollToBottom();
    }

    function sendAnswer(card, answer) {
      card.classList.add('question-answered');
      // Send to extension — message will appear when it comes back from the agent
      vscode.postMessage({ type: 'user_message', content: answer });
    }

    // --- Handle messages from the extension ---
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'claude_output' && msg.message) {
        const m = msg.message;

        if (m.role === 'user') {
          const text = typeof m.content === 'string' ? m.content : '';
          if (text) addUserMessage(text);
        } else if (m.type === 'assistant_message') {
          setAssistantContent(m.content || '');
        } else if (m.type === 'text_block_start') {
          currentAssistantEl = null;
        } else if (m.type === 'assistant_delta') {
          appendAssistantDelta(m.content || '');
        } else if (m.type === 'ask_question') {
          addQuestionCard(m.questions || []);
        } else if (m.type === 'tool_use_start') {
          // Detect AskUserQuestion and render as interactive question card
          if (m.toolName === 'AskUserQuestion' && m.toolInput?.questions) {
            addQuestionCard(m.toolInput.questions);
          } else {
            addToolCard(m.toolName || 'Tool', m.toolId, m.summary || '', m.toolInput);
          }
        } else if (m.type === 'tool_use_update') {
          // AskUserQuestion may arrive as tool_use_update when content_block_start was suppressed
          if (m.toolName === 'AskUserQuestion' && m.toolInput?.questions) {
            // Remove the generic tool card if one was created
            const existing = toolCards.get(m.toolId);
            if (existing) existing.remove();
            addQuestionCard(m.toolInput.questions);
          } else {
            updateToolCard(m.toolId, m.summary || '', m.toolName, m.toolInput);
          }
        } else if (m.type === 'tool_use_delta') {
          // Accumulate tool input (no-op for now)
        } else if (m.type === 'tool_result') {
          updateToolResult(m.toolId, m.content, m.isError);
        } else if (m.type === 'result') {
          currentAssistantEl = null;
        } else if (m.type === 'error') {
          clearEmpty();
          const div = document.createElement('div');
          div.className = 'msg-error';
          div.textContent = m.content;
          messagesEl.appendChild(div);
          scrollToBottom();
        }
      } else if (msg.type === 'input_required') {
        clearEmpty();
        const div = document.createElement('div');
        div.className = 'msg-input-required';
        div.textContent = msg.prompt || 'Claude needs your input';
        messagesEl.appendChild(div);
        scrollToBottom();
      }
    });

    // Send message
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'user_message', content: text });
      inputEl.value = '';
      inputEl.focus();
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  </script>
</body>
</html>`;
}

function updateStatusBar(isShared) {
  if (isShared === null) {
    statusBarItem.text = '$(sync~spin) Sharing...';
    statusBarItem.tooltip = 'Connecting to mobile...';
  } else if (isShared) {
    statusBarItem.text = '$(broadcast) Shared';
    statusBarItem.tooltip = 'Click to stop sharing to mobile';
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
  } else {
    statusBarItem.text = '$(device-mobile) Share to Mobile';
    statusBarItem.tooltip = 'Click to share this Claude session to mobile';
    statusBarItem.backgroundColor = undefined;
  }
}

async function checkAgentHealth() {
  try {
    await agentRequest('GET', '/health');
  } catch {
    console.log('[Remote Clauding] Agent not detected at', AGENT_URL);
  }
}

function agentRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, AGENT_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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
