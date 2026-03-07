#!/usr/bin/env node

// remote_clauding — a Claude Code CLI wrapper with phone connectivity
// Uses the Agent SDK query() function for direct Claude integration
// with canUseTool callback for permission handling.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { TerminalRenderer } from './terminal-renderer.js';
import { renderMarkdown } from './markdown-render.js';
import { RelayBridge } from './relay-bridge.js';
import { TerminalFooter } from './terminal-footer.js';
import { interactiveSelect, getActiveKeyHandler, cancelInteractiveSelect, resolveInteractiveSelect } from './interactive-select.js';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') });

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3001';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-me';
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL || '';

// Tools that are auto-allowed without permission prompts
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
]);

// Normalize cwd to Windows-style path (MSYS2/git bash returns /c/Users/... instead of C:\Users\...)
function getNativeCwd() {
  const cwd = process.cwd();
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(cwd)) {
    return cwd.replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':\\').replace(/\//g, '\\');
  }
  return cwd;
}

// Parse CLI args
const args = process.argv.slice(2);
let resumeId = null;
let continueSession = false;
let model = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resume' && args[i + 1]) { resumeId = args[++i]; }
  else if (args[i] === '--continue' || args[i] === '-c') { continueSession = true; }
  else if (args[i] === '--model' && args[i + 1]) { model = args[++i]; }
}

// State
const renderer = new TerminalRenderer();
const relay = new RelayBridge(RELAY_URL, AUTH_TOKEN);
const footer = new TerminalFooter();
let sdkSessionId = null;
let isProcessing = false;
let autoAccept = false;
let abortController = null;
let streamedText = false;       // true if text was delivered via streaming deltas

// Pending permission/question (Promise resolvers)
let pendingPermission = null;   // { resolve, permissionId, toolName, input }
let pendingQuestion = null;     // { resolve, questions }

// Message queue for messages sent while processing
let messageQueue = [];

// --- SDK query ---

function getToolSummary(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Bash': {
      const cmd = input.command || '';
      return cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd;
    }
    case 'Glob': return input.pattern || '';
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'TodoWrite': return 'Updated todos';
    default: return '';
  }
}

async function runQuery(prompt) {
  isProcessing = true;
  abortController = new AbortController();
  streamedText = false;
  renderer.startThinking();
  relay.sendStatus('processing');

  // Remove CLAUDECODE env var to allow spawning inside a Claude Code session
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const options = {
    abortController,
    cwd: getNativeCwd(),
    env,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    tools: [
      'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
      'WebFetch', 'WebSearch', 'TodoWrite', 'Task',
      'NotebookEdit', 'AskUserQuestion',
    ],
    permissionMode: 'default',
    canUseTool: async (toolName, input, { signal }) => {
      // AskUserQuestion: show interactive prompt
      if (toolName === 'AskUserQuestion' && input.questions) {
        return handleAskUserQuestion(input.questions, signal);
      }

      // Auto-allow read-only tools
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }

      // Auto-accept mode: allow all
      if (autoAccept) {
        return { behavior: 'allow', updatedInput: input };
      }

      // Supervised mode: pause and ask user
      return handlePermissionRequest(toolName, input, signal);
    },
  };

  if (sdkSessionId) {
    options.resume = sdkSessionId;
  } else if (resumeId) {
    options.resume = resumeId;
  } else if (continueSession) {
    options.continue = true;
  }

  if (model) {
    options.model = model;
  }

  try {
    for await (const msg of query({ prompt, options })) {
      handleSDKMessage(msg);
    }
  } catch (err) {
    renderer.stopThinking();
    console.error(`\x1b[31mError: ${err.message}\x1b[0m`);
  }

  isProcessing = false;
  abortController = null;
  relay.sendOutput({ type: 'result', sessionId: sdkSessionId, subtype: 'success' });
  relay.sendStatus('idle');

  // Process queued messages
  if (messageQueue.length > 0) {
    const next = messageQueue.shift();
    runQuery(next.content).then(next.resolve).catch(next.reject);
  } else {
    showPrompt();
  }
}

function handleSDKMessage(msg) {
  // Extract session ID
  if (msg.session_id) {
    sdkSessionId = msg.session_id;
  }

  // Render streaming events directly via renderer
  if (msg.type === 'stream_event' || msg.type === 'user' || msg.type === 'result') {
    renderer.renderEvent(msg);
  }

  // Relay to phone + track streaming + fallback rendering
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (!ev) return;

    // Track that text was streamed (so we skip duplicate assistant message)
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      streamedText = true;
    }

    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      if (ev.content_block.name !== 'AskUserQuestion' && ev.content_block.name !== 'ToolSearch') {
        relay.sendOutput({
          type: 'tool_use_start',
          toolName: ev.content_block.name,
          toolId: ev.content_block.id,
          toolInput: ev.content_block.input,
          summary: '',
        });
      }
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
      relay.sendOutput({ type: 'text_block_start' });
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        relay.sendOutput({ type: 'assistant_delta', content: ev.delta.text || '' });
      } else if (ev.delta?.type === 'input_json_delta') {
        relay.sendOutput({ type: 'tool_use_delta', content: ev.delta.partial_json || '' });
      }
    }
  } else if (msg.type === 'assistant') {
    // Relay tool_use blocks (text is handled via streaming or result fallback)
    const blocks = msg.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_use' && block.name !== 'AskUserQuestion' && block.name !== 'ToolSearch') {
        relay.sendOutput({
          type: 'tool_use_start',
          toolName: block.name,
          toolId: block.id,
          toolInput: block.input,
          summary: '',
        });
      }
    }
  } else if (msg.type === 'result') {
    // Fallback: if nothing was streamed or emitted, render result text
    const resultText = msg.result || '';
    if (!streamedText && resultText) {
      renderer.stopThinking();
      const formatted = renderMarkdown(resultText);
      process.stdout.write('\n● ' + formatted + '\n\n');
      relay.sendOutput({ type: 'assistant_message', role: 'assistant', content: resultText });
    }
  } else if (msg.type === 'user') {
    const blocks = msg.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_result') {
        relay.sendOutput({
          type: 'tool_result',
          toolId: block.tool_use_id,
          content: block.content || '',
          isError: !!block.is_error,
        });
      }
    }
  } else if (msg.type === 'result') {
    // Result already sent after the loop
  }
}

// --- Permission handling via canUseTool ---

async function handleAskUserQuestion(questions, signal) {
  const q = questions[0];
  if (!q) return { behavior: 'deny', message: 'No question provided' };

  // Relay to phone
  relay.sendOutput({ type: 'ask_question', questions });
  relay.sendInputRequired(q.question || 'Claude needs your input');

  if (q.options && q.options.length > 0) {
    // Interactive arrow-key selector
    renderer.stopThinking();
    const answer = await interactiveSelect(q.question, q.options);

    relay.sendOutput({ type: 'question_answered' });

    if (answer) {
      const answers = {};
      answers[q.question] = answer;
      return { behavior: 'allow', updatedInput: { questions, answers } };
    } else {
      return { behavior: 'deny', message: 'User dismissed the question' };
    }
  } else {
    // Free-text question — show prompt and wait for user to type
    renderer.stopThinking();
    renderer.renderQuestion(questions);
    footer.activate('Your answer: ');

    return new Promise((resolve) => {
      pendingQuestion = { resolve, questions };

      signal.addEventListener('abort', () => {
        if (pendingQuestion) {
          pendingQuestion = null;
          resolve({ behavior: 'deny', message: 'Session aborted' });
        }
      });
    });
  }
}

async function handlePermissionRequest(toolName, input, signal) {
  const permissionId = randomUUID();
  const summary = `${toolName}: ${JSON.stringify(input).substring(0, 100)}`;

  // Show permission prompt in terminal
  renderer.stopThinking();
  renderer.renderPermissionPrompt({ tool_name: toolName, input });

  // Relay to phone
  relay.sendOutput({
    type: 'permission_request',
    permissionId,
    toolName,
    toolInput: input,
    summary,
  });
  relay.sendStatus('permission_required');

  // Store pending state so phone can resolve it too
  const resultPromise = new Promise((resolve) => {
    pendingPermission = { resolve, permissionId, toolName, input };

    signal.addEventListener('abort', () => {
      if (pendingPermission?.permissionId === permissionId) {
        pendingPermission = null;
        resolve({ behavior: 'deny', message: 'Session aborted' });
      }
    });
  });

  // Interactive arrow-key selector
  const options = [
    { label: 'Allow', description: 'run this tool' },
    { label: 'Deny', description: 'skip this tool' },
    { label: 'Allow all', description: 'auto-accept for this session' },
  ];
  const answer = await interactiveSelect(`Allow ${toolName}?`, options, { allowOther: false });

  // If phone already resolved it while we were waiting, just return the phone's result
  if (!pendingPermission || pendingPermission.permissionId !== permissionId) {
    return resultPromise;
  }

  // Resolve based on selection
  if (answer === 'Allow') {
    resolvePermission('y');
  } else if (answer === 'Allow all') {
    resolvePermission('a');
  } else {
    resolvePermission('n');
  }

  return resultPromise;
}

function resolvePermission(answer) {
  if (!pendingPermission) return;
  const { resolve, permissionId, input } = pendingPermission;
  pendingPermission = null;

  const lower = answer.trim().toLowerCase();
  const isAllow = (lower === 'y' || lower === 'yes' || lower === 'a' || lower === 'all');
  const isAllowAll = (lower === 'a' || lower === 'all');

  if (isAllowAll) {
    autoAccept = true;
    console.log('\x1b[32m\x1b[1mAuto-accept ON\x1b[0m — all edits will be allowed without prompting');
    updateFooterHelp();
    relay.sendOutput({ type: 'auto_accept_changed', autoAccept: true });
  }

  relay.sendOutput({ type: 'permission_resolved', permissionId, action: isAllow ? 'allow' : 'deny' });
  renderer.startThinking();
  relay.sendStatus('processing');

  if (isAllow) {
    resolve({ behavior: 'allow', updatedInput: input });
  } else {
    resolve({ behavior: 'deny', message: 'User denied' });
  }
}

function resolveQuestion(answer) {
  if (!pendingQuestion) return;
  const { resolve, questions } = pendingQuestion;
  pendingQuestion = null;

  if (answer === null) {
    resolve({ behavior: 'deny', message: 'User dismissed the question' });
  } else {
    const answers = {};
    if (questions.length > 0) {
      answers[questions[0].question] = answer;
    }
    resolve({ behavior: 'allow', updatedInput: { questions, answers } });
  }

  relay.sendOutput({ type: 'question_answered' });
  renderer.startThinking();
  relay.sendStatus('processing');
}

// --- Send user message ---

function sendUserMessage(content, { fromPhone = false } = {}) {
  if (footer.inputActive) footer.deactivate();

  // If waiting for a permission response
  if (pendingPermission) {
    resolvePermission(content);
    return;
  }

  // If waiting for a free-text question answer
  if (pendingQuestion) {
    resolveQuestion(content);
    return;
  }

  // Mirror user message to phone (skip if from phone)
  if (!fromPhone) {
    relay.sendOutput({
      type: 'user_message',
      role: 'user',
      content,
    });
  }

  // If already processing, queue the message
  if (isProcessing) {
    messageQueue.push({
      content,
      resolve: () => {},
      reject: (err) => console.error(err),
    });
    return;
  }

  runQuery(content);
}

// --- Phone input (from relay) ---

relay.on('phone_message', (content) => {
  if (getActiveKeyHandler()) {
    // Phone answered an active interactive select (question or permission)
    resolveInteractiveSelect(content);
    writeToContent(() => renderer.renderPhoneMessage(content));
    return;
  }
  // Deactivate footer once, render phone message, then send
  // (avoid writeToContent + sendUserMessage double deactivate/reactivate)
  if (footer.inputActive) footer.deactivate();
  renderer.renderPhoneMessage(content);
  sendUserMessage(content, { fromPhone: true });
});

relay.on('phone_stop', () => {
  if (abortController) {
    abortController.abort();
  }
});

relay.on('phone_permission', (permissionId, action) => {
  if (pendingPermission && pendingPermission.permissionId === permissionId) {
    const { resolve, input } = pendingPermission;
    pendingPermission = null;

    writeToContent(() => console.log(`\x1b[32m📱 Permission ${action}ed from phone\x1b[0m`));
    relay.sendOutput({ type: 'permission_resolved', permissionId, action });
    renderer.startThinking();
    relay.sendStatus('processing');

    if (action === 'allow') {
      resolve({ behavior: 'allow', updatedInput: input });
    } else {
      resolve({ behavior: 'deny', message: 'User denied from phone' });
    }
  }
});

relay.on('phone_dismiss_question', () => {
  if (getActiveKeyHandler()) cancelInteractiveSelect();
  if (pendingQuestion) {
    resolveQuestion(null);
  }
});

relay.on('phone_auto_accept', (value) => {
  autoAccept = value;
  writeToContent(() => {
    if (autoAccept) {
      console.log('\x1b[32m\x1b[1m📱 Auto-accept ON\x1b[0m (set from phone)');
    } else {
      console.log('\x1b[33m\x1b[1m📱 Auto-accept OFF\x1b[0m (set from phone)');
    }
  });
  updateFooterHelp();
  // If auto-accept turned on and a permission is pending, allow it
  if (autoAccept && pendingPermission) {
    const { resolve, permissionId, input } = pendingPermission;
    pendingPermission = null;
    footer.deactivate();
    resolve({ behavior: 'allow', updatedInput: input });
    relay.sendOutput({ type: 'permission_resolved', permissionId, action: 'allow' });
    renderer.startThinking();
    relay.sendStatus('processing');
  }
});

// --- Slash commands ---

function handleShareCommand() {
  if (!RELAY_PUBLIC_URL) {
    console.log('\x1b[33mRELAY_PUBLIC_URL not set in .env — cannot generate share link.\x1b[0m');
    showPrompt();
    return;
  }

  if (relay.connected && relay.shared) {
    showShareQR();
    return;
  }

  if (relay.connected) {
    relay.shareSession();
    showShareQR();
    return;
  }

  console.log('\x1b[2mConnecting to relay server...\x1b[0m');
  relay.once('connected', () => {
    relay.shareSession();
    showShareQR();
  });
  relay.connect();
}

function handleUnshareCommand() {
  if (!relay.shared) {
    console.log('\x1b[33mSession is not shared.\x1b[0m');
    showPrompt();
    return;
  }
  relay.shared = false;
  relay._send({ type: 'session_unregister', sessionId: relay.sessionId });
  console.log('\x1b[32mSession unshared from phone.\x1b[0m');
  showPrompt();
}

function showShareQR() {
  const pairUrl = `${RELAY_PUBLIC_URL}/#/pair/${encodeURIComponent(relay.sessionToken)}`;
  console.log(`\n\x1b[1mScan to connect your phone:\x1b[0m\n`);
  qrcode.generate(pairUrl, { small: true }, (code) => {
    console.log(code);
    console.log(`\x1b[2m${pairUrl}\x1b[0m\n`);
    showPrompt();
  });
}

const COMMANDS = {
  '/exit': { desc: 'Exit the CLI', alias: ['/quit'] },
  '/help': { desc: 'Show available commands' },
  '/share': { desc: 'Connect phone via QR code' },
  '/unshare': { desc: 'Stop sharing session to phone' },
  '/resume': { desc: 'Resume a past conversation' },
  '/clear': { desc: 'Clear conversation context' },
  '/compact': { desc: 'Compact conversation to save context' },
  '/status': { desc: 'Show session and relay status' },
  '/cost': { desc: 'Show token usage for this session' },
  '/auto': { desc: 'Toggle auto-accept for edits (skip permission prompts)' },
};

const PASSTHROUGH_COMMANDS = ['/commit', '/diff'];

function handleCommand(input) {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/quit') return handleCommand('/exit');

  switch (cmd) {
    case '/exit':
      footer.cleanup();
      console.log('Goodbye!');
      if (abortController) abortController.abort();
      relay.disconnect();
      process.exit(0);
      break;

    case '/help':
      console.log(`\n\x1b[1mAvailable commands:\x1b[0m`);
      for (const [name, info] of Object.entries(COMMANDS)) {
        const aliases = info.alias ? ` (${info.alias.join(', ')})` : '';
        console.log(`  \x1b[36m${name}\x1b[0m${aliases} — ${info.desc}`);
      }
      console.log(`\n\x1b[2mSkill commands (passed to Claude): ${PASSTHROUGH_COMMANDS.join(', ')}\x1b[0m`);
      console.log();
      showPrompt();
      break;

    case '/share':
      handleShareCommand();
      break;

    case '/unshare':
      handleUnshareCommand();
      break;

    case '/resume':
      handleResumeCommand();
      break;

    case '/clear':
      console.log('\x1b[2mStarting new session...\x1b[0m');
      sdkSessionId = null;
      resumeId = null;
      continueSession = false;
      showPrompt();
      break;

    case '/compact':
      sendUserMessage('/compact');
      break;

    case '/status':
      console.log(`\n\x1b[1mSession:\x1b[0m ${sdkSessionId || '(not started)'}`);
      console.log(`\x1b[1mRelay:\x1b[0m ${relay.connected ? '\x1b[32mconnected\x1b[0m' : '\x1b[31mdisconnected\x1b[0m'}`);
      console.log(`\x1b[1mProcessing:\x1b[0m ${isProcessing ? 'yes' : 'no'}`);
      console.log(`\x1b[1mAuto-accept:\x1b[0m ${autoAccept ? '\x1b[32mON\x1b[0m' : '\x1b[33mOFF\x1b[0m'}`);
      console.log();
      showPrompt();
      break;

    case '/cost':
      sendUserMessage('/cost');
      break;

    case '/auto':
      autoAccept = !autoAccept;
      if (autoAccept) {
        console.log('\x1b[32m\x1b[1mAuto-accept ON\x1b[0m — all edits will be allowed without prompting\n');
      } else {
        console.log('\x1b[33m\x1b[1mAuto-accept OFF\x1b[0m — destructive tools will require permission\n');
      }
      updateFooterHelp();
      // If auto-accept just turned on and a permission is pending, allow it
      if (autoAccept && pendingPermission) {
        const { resolve, permissionId, input } = pendingPermission;
        pendingPermission = null;
        footer.deactivate();
        resolve({ behavior: 'allow', updatedInput: input });
        relay.sendOutput({ type: 'permission_resolved', permissionId, action: 'allow' });
        renderer.startThinking();
        relay.sendStatus('processing');
      }
      relay.sendOutput({ type: 'auto_accept_changed', autoAccept });
      showPrompt();
      break;

    default:
      if (PASSTHROUGH_COMMANDS.includes(cmd)) {
        sendUserMessage(input);
      } else {
        console.log(`\x1b[33mUnknown command: ${cmd}. Type /help for available commands.\x1b[0m`);
        showPrompt();
      }
      break;
  }
}

// --- Resume ---

function getClaudeProjectDir(projectPath) {
  const dirName = projectPath.replace(/[:\\/]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', dirName);
}

function extractLastField(text, field) {
  const pattern = `"${field}":"`;
  let idx = text.lastIndexOf(pattern);
  if (idx === -1) return null;
  idx += pattern.length;
  let end = idx;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === '\\') end++;
    end++;
  }
  return text.substring(idx, end).substring(0, 200);
}

function getFirstUserText(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user') {
        const content = obj.message?.content;
        const t = typeof content === 'string' ? content
          : Array.isArray(content) ? content.find(b => b.type === 'text')?.text
          : null;
        if (t && !t.startsWith('<')) return t.substring(0, 100);
      }
    } catch {}
  }
  return null;
}

async function listConversations() {
  const projectDir = getClaudeProjectDir(getNativeCwd());
  let files;
  try {
    files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.includes('/') && !f.startsWith('agent-'));
  } catch {
    return [];
  }

  const conversations = [];
  for (const file of files) {
    const filePath = path.join(projectDir, file);
    const id = file.replace('.jsonl', '');
    try {
      const stat = fs.statSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      const headBuf = Buffer.alloc(Math.min(65536, stat.size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const headText = headBuf.toString('utf-8');

      let tailText = '';
      if (stat.size > 65536) {
        const tailBuf = Buffer.alloc(65536);
        fs.readSync(fd, tailBuf, 0, tailBuf.length, stat.size - 65536);
        tailText = tailBuf.toString('utf-8');
      }
      fs.closeSync(fd);

      const combined = headText + tailText;
      const title = extractLastField(combined, 'customTitle')
        || extractLastField(combined, 'summary')
        || getFirstUserText(headText);

      if (!title) continue; // skip empty conversations with no user messages
      conversations.push({ id, title, mtime: stat.mtimeMs });
    } catch {}
  }

  conversations.sort((a, b) => b.mtime - a.mtime);
  return conversations;
}

async function handleResumeCommand() {
  console.log('\x1b[2mLoading conversations...\x1b[0m');
  const convos = await listConversations();

  if (convos.length === 0) {
    console.log('\x1b[33mNo past conversations found.\x1b[0m');
    showPrompt();
    return;
  }

  const options = convos.map((c) => {
    const date = new Date(c.mtime).toLocaleDateString();
    return { label: c.title, description: date };
  });

  const answer = await interactiveSelect('Resume conversation', options, {
    allowOther: false,
    maxVisible: 15,
  });

  if (answer) {
    const selected = convos.find(c => c.title === answer);
    if (selected) {
      console.log(`\x1b[32mResuming: ${selected.title}\x1b[0m\n`);
      sdkSessionId = null;
      resumeId = selected.id;
    }
  } else {
    console.log('\x1b[2mCancelled.\x1b[0m');
  }
  showPrompt();
}

// --- Footer helpers ---

function updateFooterHelp() {
  const autoLabel = autoAccept ? ' \x1b[32m[auto-accept ON]\x1b[0m\x1b[2m' : '';
  footer.helpText = ` /help \u00b7 /share \u00b7 /auto \u00b7 \u21b5 send${autoLabel}`;
  if (footer.inputActive) {
    footer.draw();
    footer._positionInputCursor();
  } else {
    process.stdout.write('\x1b7');
    footer.draw();
    process.stdout.write('\x1b8');
  }
}

function writeToContent(fn) {
  const wasActive = footer.inputActive;
  const savedBuffer = footer.inputBuffer;
  const savedCursor = footer.cursorPos;
  if (wasActive) footer.deactivate();
  fn();
  if (wasActive) {
    footer.activate('> ');
    footer.inputBuffer = savedBuffer;
    footer.cursorPos = savedCursor;
    footer.redrawInput();
  }
}

// --- Terminal input (via footer) ---

function showPrompt() {
  if (!isProcessing && !pendingPermission && !pendingQuestion) {
    footer.activate('> ');
  }
}

function submitInput() {
  const line = footer.submit();
  console.log(`\x1b[48;2;45;45;45m\x1b[1m > \x1b[22m${line} \x1b[0m`);

  const trimmed = line.trim();

  if (!trimmed && !pendingPermission && !pendingQuestion) {
    showPrompt();
    return;
  }

  // Handle slash commands
  if (trimmed.startsWith('/')) {
    handleCommand(trimmed);
    return;
  }

  sendUserMessage(trimmed || line);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', (key) => {
  // Delegate to interactive select if active
  const keyHandler = getActiveKeyHandler();
  if (keyHandler) {
    keyHandler(key);
    return;
  }

  // Skip input when footer is not active
  if (!footer.inputActive) return;

  // Ctrl+C
  if (key === '\x03') {
    footer.cleanup();
    if (abortController) abortController.abort();
    relay.disconnect();
    process.stdout.write('\n');
    process.exit(0);
  }

  // Ctrl+D
  if (key === '\x04') {
    footer.cleanup();
    if (abortController) abortController.abort();
    relay.disconnect();
    process.stdout.write('\n');
    process.exit(0);
  }

  // Enter
  if (key === '\r' || key === '\n') {
    submitInput();
    return;
  }

  // Backspace
  if (key === '\x7f' || key === '\b') {
    if (footer.cursorPos > 0) {
      footer.inputBuffer = footer.inputBuffer.slice(0, footer.cursorPos - 1) + footer.inputBuffer.slice(footer.cursorPos);
      footer.cursorPos--;
      footer.redrawInput();
    }
    return;
  }

  // Delete
  if (key === '\x1b[3~') {
    if (footer.cursorPos < footer.inputBuffer.length) {
      footer.inputBuffer = footer.inputBuffer.slice(0, footer.cursorPos) + footer.inputBuffer.slice(footer.cursorPos + 1);
      footer.redrawInput();
    }
    return;
  }

  // Arrow left
  if (key === '\x1b[D') {
    if (footer.cursorPos > 0) {
      footer.cursorPos--;
      footer.redrawInput();
    }
    return;
  }

  // Arrow right
  if (key === '\x1b[C') {
    if (footer.cursorPos < footer.inputBuffer.length) {
      footer.cursorPos++;
      footer.redrawInput();
    }
    return;
  }

  // Home
  if (key === '\x1b[H' || key === '\x01') {
    footer.cursorPos = 0;
    footer.redrawInput();
    return;
  }

  // End
  if (key === '\x1b[F' || key === '\x05') {
    footer.cursorPos = footer.inputBuffer.length;
    footer.redrawInput();
    return;
  }

  // Arrow up/down — ignore
  if (key === '\x1b[A' || key === '\x1b[B') return;

  // Ignore other escape sequences
  if (key.startsWith('\x1b')) return;

  // Regular character
  footer.inputBuffer = footer.inputBuffer.slice(0, footer.cursorPos) + key + footer.inputBuffer.slice(footer.cursorPos);
  footer.cursorPos += key.length;
  footer.redrawInput();
});

// --- Startup ---

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

function renderStartupPanel() {
  const DIM = '\x1b[2m';
  const BOLD = '\x1b[1m';
  const RST = '\x1b[0m';
  const ORANGE = '\x1b[38;2;217;119;6m';
  const CYAN = '\x1b[36m';

  const cwd = getNativeCwd();
  const projectName = path.basename(cwd);
  const modelLabel = model || 'default';
  const modeLabel = resumeId ? 'resume' : continueSession ? 'continue' : 'new session';

  const width = Math.min(process.stdout.columns || 80, 64);
  const inner = width - 4;

  function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
  function pad(text, len) {
    return text + ' '.repeat(Math.max(0, len - stripAnsi(text).length));
  }
  function wrapText(text, len) {
    const lines = [];
    for (let i = 0; i < text.length; i += len) {
      lines.push(text.slice(i, i + len));
    }
    return lines;
  }

  const fixedChars = 22 + pkg.version.length;
  const top = `${DIM}╭─${RST} ${ORANGE}Remote Clauding${RST} ${DIM}v${pkg.version}${RST} ${DIM}${'─'.repeat(Math.max(1, width - fixedChars))}╮${RST}`;
  const bot = `${DIM}╰${'─'.repeat(width - 2)}╯${RST}`;
  const blank = `${DIM}│${RST}${' '.repeat(width - 2)}${DIM}│${RST}`;
  const line = (text) => `${DIM}│${RST}  ${pad(text, inner)}${DIM}│${RST}`;

  console.log('');
  console.log(top);
  console.log(blank);
  console.log(line(`${BOLD}${projectName}${RST}`));
  for (const chunk of wrapText(cwd, inner)) {
    console.log(line(`${DIM}${chunk}${RST}`));
  }
  console.log(blank);
  console.log(line(`Model: ${CYAN}${modelLabel}${RST}  ${DIM}·${RST}  ${modeLabel}`));
  console.log(line(`Phone: ${DIM}not connected${RST}  ${DIM}·${RST}  ${CYAN}/share${RST} to pair`));
  console.log(blank);
  console.log(bot);
  console.log('');
}

// Create local session (not shared yet)
const projectName = path.basename(getNativeCwd());
relay.createLocalSession(getNativeCwd(), projectName);

renderStartupPanel();

// Setup footer
footer.setup();

relay.on('connected', () => {
  writeToContent(() => console.log('\x1b[32m✓ Relay connected\x1b[0m'));
});

relay.on('disconnected', () => {
  if (relay.shared) {
    writeToContent(() => console.log('\x1b[33m⚠ Relay disconnected (reconnecting...)\x1b[0m'));
  }
});

// Cleanup footer on exit
process.on('exit', () => footer.cleanup());

// Show initial prompt (no need to spawn anything — SDK starts on first message)
showPrompt();
