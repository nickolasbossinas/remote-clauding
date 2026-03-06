#!/usr/bin/env node

// remote_clauding — a Claude Code CLI wrapper with phone connectivity
// Spawns claude as a child process with stream-json protocol,
// renders in terminal, and relays to phone via relay server.

import { spawn } from 'child_process';
import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { TerminalRenderer } from './terminal-renderer.js';
import { RelayBridge } from './relay-bridge.js';
import { TerminalFooter } from './terminal-footer.js';
import { interactiveSelect, getActiveKeyHandler, cancelInteractiveSelect } from './interactive-select.js';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env') });

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:3001';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-me';
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL || '';

const ALLOWED_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,NotebookEdit,AskUserQuestion';

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
let claudeProcess = null;
let sessionId = null;
let isProcessing = false;
let pendingPermission = null; // { requestId, toolName, input }
let pendingQuestion = null;   // { requestId, questions }
let lineBuffer = '';
let isRestarting = false;     // true when intentionally killing claude to restart

// AskUserQuestion stream interception state
// In -p mode, AskUserQuestion is auto-allowed and fails internally.
// We intercept it from the stream, suppress its output, and show our own UI.
let askQuestionCapture = null;   // { toolUseId, inputJson, questions }
let askToolInputBuf = '';        // accumulates partial_json for AskUserQuestion
let suppressRelayText = false;   // suppress text relay after ToolSearch

// --- Claude child process ---

function spawnClaude() {
  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--allowedTools', ALLOWED_TOOLS,
  ];

  if (resumeId) claudeArgs.push('--resume', resumeId);
  if (continueSession) claudeArgs.push('--continue');
  if (model) claudeArgs.push('--model', model);

  // Remove CLAUDECODE env to avoid nested session detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  claudeProcess = spawn('claude', claudeArgs, {
    cwd: getNativeCwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // needed on Windows to find .cmd
  });

  claudeProcess.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleClaudeEvent(event);
      } catch {}
    }
  });

  claudeProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`\x1b[31m${text}\x1b[0m`);
  });

  claudeProcess.on('error', (err) => {
    footer.cleanup();
    console.error(`\x1b[31mFailed to start claude: ${err.message}\x1b[0m`);
    console.error('Make sure claude is installed: npm install -g @anthropic-ai/claude-code');
    relay.disconnect();
    process.exit(1);
  });

  claudeProcess.on('exit', (code) => {
    if (isRestarting) return; // intentional restart, don't exit
    footer.cleanup();
    console.log(`\n\x1b[2mClaude process exited (code ${code})\x1b[0m`);
    relay.disconnect();
    process.exit(code || 0);
  });
}

function writeToClaudeStdin(obj) {
  if (claudeProcess && !claudeProcess.killed) {
    claudeProcess.stdin.write(JSON.stringify(obj) + '\n');
  }
}

function resolveQuestion(requestId, questions, answer) {
  pendingQuestion = null;

  if (answer === null) {
    // Dismissed
    writeToClaudeStdin({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { behavior: 'deny', message: 'User dismissed the question' },
      },
    });
  } else {
    const answers = {};
    if (questions.length > 0) {
      answers[questions[0].question] = answer;
    }
    writeToClaudeStdin({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: { questions, answers },
        },
      },
    });
  }

  relay.sendOutput({ type: 'question_answered' });
  renderer.startThinking();
  relay.sendStatus('processing');
}

function sendUserMessage(content, { fromPhone = false } = {}) {
  // Deactivate footer if active (entering processing state)
  if (footer.inputActive) footer.deactivate();

  // If waiting for a permission response
  if (pendingPermission) {
    const answer = content.trim().toLowerCase();
    const { requestId, input } = pendingPermission;
    pendingPermission = null;

    const behavior = (answer === 'y' || answer === 'yes') ? 'allow' : 'deny';
    writeToClaudeStdin({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User denied' },
      },
    });

    // Notify phone
    relay.sendOutput({ type: 'permission_resolved', permissionId: requestId, action: behavior });
    renderer.startThinking();
    relay.sendStatus('processing');
    return;
  }

  // If waiting for a free-text question answer (options are handled by interactiveSelect)
  if (pendingQuestion) {
    const { requestId, questions } = pendingQuestion;
    pendingQuestion = null;
    resolveQuestion(requestId, questions, content);
    return;
  }

  // Regular user message
  isProcessing = true;
  renderer.startThinking();
  relay.sendStatus('processing');

  // Mirror user message to phone (skip if message came from phone)
  if (!fromPhone) {
    relay.sendOutput({
      type: 'user_message',
      role: 'user',
      content,
    });
  }

  writeToClaudeStdin({
    type: 'user',
    message: { role: 'user', content },
  });
}

// --- Handle events from claude stdout ---

function handleClaudeEvent(event) {
  // --- Intercept AskUserQuestion from stream ---
  // In -p mode, AskUserQuestion is auto-allowed internally and fails.
  // We intercept it from the stream: capture its input, suppress its rendering,
  // and after the turn completes show our own interactive select.
  if (event.type === 'stream_event') {
    const ev = event.event;
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use'
        && ev.content_block.name === 'ToolSearch') {
      suppressRelayText = true;
    } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use'
        && ev.content_block.name !== 'AskUserQuestion' && ev.content_block.name !== 'ToolSearch') {
      suppressRelayText = false;
    }
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use'
        && ev.content_block.name === 'AskUserQuestion') {
      // Start capturing AskUserQuestion
      askQuestionCapture = { toolUseId: ev.content_block.id, inputJson: '', questions: null };
      askToolInputBuf = '';
      renderer.suppressToolUse(ev.content_block.id);
    } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta'
        && askQuestionCapture && !askQuestionCapture.questions) {
      // Accumulate AskUserQuestion input JSON
      askToolInputBuf += (ev.delta.partial_json || '');
    } else if (ev?.type === 'content_block_stop' && askQuestionCapture && !askQuestionCapture.questions) {
      // Parse accumulated input
      try {
        const input = JSON.parse(askToolInputBuf);
        askQuestionCapture.questions = input.questions || [];
      } catch {
        askQuestionCapture.questions = [];
      }
      askToolInputBuf = '';
    }
  }

  // Suppress error tool_result for captured AskUserQuestion
  if (event.type === 'user' && askQuestionCapture) {
    const blocks = event.message?.content || [];
    const hasAskResult = (Array.isArray(blocks) ? blocks : []).some(
      b => b.type === 'tool_result' && b.tool_use_id === askQuestionCapture.toolUseId
    );
    if (hasAskResult) {
      const filtered = blocks.filter(
        b => !(b.type === 'tool_result' && b.tool_use_id === askQuestionCapture.toolUseId)
      );
      // Render remaining blocks (if any)
      if (filtered.length > 0) {
        renderer.renderEvent({ ...event, message: { ...event.message, content: filtered } });
      }
      // Relay remaining tool results
      for (const block of filtered) {
        if (block.type === 'tool_result') {
          relay.sendOutput({
            type: 'tool_result',
            toolId: block.tool_use_id,
            content: block.content || '',
            isError: !!block.is_error,
          });
        }
      }
      return; // skip normal handling for this event
    }
  }

  // Render in terminal
  renderer.renderEvent(event);

  // Capture session ID
  if (event.type === 'system' && event.subtype === 'init') {
    sessionId = event.session_id;
    return;
  }

  // Map to relay output events (same format the phone PWA expects)
  if (event.type === 'stream_event') {
    const ev = event.event;
    if (!ev) return;

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
      if (!suppressRelayText) relay.sendOutput({ type: 'text_block_start' });
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        if (!suppressRelayText) relay.sendOutput({ type: 'assistant_delta', content: ev.delta.text || '' });
      } else if (ev.delta?.type === 'input_json_delta') {
        // Don't relay AskUserQuestion input deltas
        if (!askQuestionCapture) {
          relay.sendOutput({ type: 'tool_use_delta', content: ev.delta.partial_json || '' });
        }
      }
    }
  } else if (event.type === 'assistant') {
    // Full assistant message — skip text blocks (already sent via streaming deltas)
    // Only relay tool_use blocks in case streaming missed them
    const blocks = event.message?.content || [];
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
  } else if (event.type === 'user') {
    // Normal user events (non-AskUserQuestion) — relay tool results
    const blocks = event.message?.content || [];
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
  } else if (event.type === 'control_request') {
    handleControlRequest(event);
  } else if (event.type === 'result') {
    isProcessing = false;
    suppressRelayText = false;
    relay.sendOutput({ type: 'result', sessionId, subtype: event.subtype });
    relay.sendStatus('idle');
    // If we captured an AskUserQuestion, show interactive select now
    if (askQuestionCapture?.questions?.length > 0) {
      const captured = askQuestionCapture;
      askQuestionCapture = null;
      handleCapturedQuestion(captured.questions);
    } else {
      askQuestionCapture = null;
      showPrompt();
    }
  }
}

async function handleCapturedQuestion(questions) {
  const q = questions[0];
  if (!q) { showPrompt(); return; }

  // Relay to phone
  relay.sendOutput({ type: 'ask_question', questions });
  relay.sendInputRequired(q.question || 'Claude needs your input');

  if (q.options && q.options.length > 0) {
    // Interactive arrow-key selector (footer stays inactive)
    const answer = await interactiveSelect(q.question, q.options);

    if (answer) {
      // Send the answer as a regular user message — Claude will understand
      relay.sendOutput({ type: 'question_answered' });
      sendUserMessage(answer);
    } else {
      relay.sendOutput({ type: 'question_answered' });
      showPrompt();
    }
  } else {
    // Free-text question — show prompt and let user type
    renderer.renderQuestion(questions);
    footer.activate('Your answer: ');
    // The next line input will be sent as a regular user message
  }
}

function handleControlRequest(event) {
  const { request_id, request } = event;

  if (request.subtype === 'can_use_tool') {
    if (request.tool_name === 'AskUserQuestion') {
      // Show question in terminal + relay to phone
      const questions = request.input?.questions || [];

      relay.sendOutput({ type: 'ask_question', questions });
      relay.sendInputRequired(questions[0]?.question || 'Claude needs your input');

      const q = questions[0];
      if (q?.options && q.options.length > 0) {
        // Interactive arrow-key selector (footer stays inactive)
        pendingQuestion = { requestId: request_id, questions };
        interactiveSelect(q.question, q.options).then((answer) => {
          if (answer === null) {
            // Cancelled — dismiss
            resolveQuestion(request_id, questions, null);
          } else {
            resolveQuestion(request_id, questions, answer);
          }
        });
      } else {
        // Free-text question (no options)
        pendingQuestion = { requestId: request_id, questions };
        renderer.renderQuestion(questions);
        footer.activate('Your answer: ');
      }
    } else {
      // Permission prompt
      pendingPermission = { requestId: request_id, toolName: request.tool_name, input: request.input };
      renderer.renderPermissionPrompt(request);
      footer.activate('Allow? [y/n]: ');

      const summary = `${request.tool_name}: ${JSON.stringify(request.input).substring(0, 100)}`;
      relay.sendOutput({
        type: 'permission_request',
        permissionId: request_id,
        toolName: request.tool_name,
        toolInput: request.input,
        summary,
      });
      relay.sendStatus('permission_required');
    }
  }
}

// --- Phone input (from relay) ---

relay.on('phone_message', (content) => {
  // Cancel interactive select if active (phone answered the question)
  if (getActiveKeyHandler()) cancelInteractiveSelect();
  writeToContent(() => renderer.renderPhoneMessage(content));
  sendUserMessage(content, { fromPhone: true });
});

relay.on('phone_stop', () => {
  if (claudeProcess && !claudeProcess.killed) {
    // Send interrupt
    writeToClaudeStdin({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }
});

relay.on('phone_permission', (permissionId, action) => {
  if (pendingPermission && pendingPermission.requestId === permissionId) {
    const { requestId, input } = pendingPermission;
    pendingPermission = null;

    writeToClaudeStdin({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: action === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User denied from phone' },
      },
    });

    writeToContent(() => console.log(`\x1b[32m📱 Permission ${action}ed from phone\x1b[0m`));
    relay.sendOutput({ type: 'permission_resolved', permissionId, action });
    renderer.startThinking();
    relay.sendStatus('processing');
  }
});

relay.on('phone_dismiss_question', () => {
  if (getActiveKeyHandler()) cancelInteractiveSelect();
  if (pendingQuestion) {
    resolveQuestion(pendingQuestion.requestId, pendingQuestion.questions, null);
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
    // Already shared — just show QR again
    showShareQR();
    return;
  }

  if (relay.connected) {
    // Connected but not shared (e.g. after /unshare) — just re-share
    relay.shareSession();
    showShareQR();
    return;
  }

  // Connect to relay and share the existing local session
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
  // PWA pair URL: <base>/#/pair/<auth-token>
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
};

// Commands that get passed through to Claude as regular messages (skills)
const PASSTHROUGH_COMMANDS = ['/commit', '/diff'];

function handleCommand(input) {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // Check aliases
  if (cmd === '/quit') return handleCommand('/exit');

  switch (cmd) {
    case '/exit':
      footer.cleanup();
      console.log('Goodbye!');
      if (claudeProcess) claudeProcess.kill();
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
      console.log('\x1b[2mClearing conversation...\x1b[0m');
      restartClaude([]);
      break;

    case '/compact':
      console.log('\x1b[2mCompacting conversation...\x1b[0m');
      // Send /compact as a user message — Claude CLI handles it as a skill
      sendUserMessage('/compact');
      break;

    case '/status':
      console.log(`\n\x1b[1mSession:\x1b[0m ${sessionId || '(not started)'}`);
      console.log(`\x1b[1mRelay:\x1b[0m ${relay.connected ? '\x1b[32mconnected\x1b[0m' : '\x1b[31mdisconnected\x1b[0m'}`);
      console.log(`\x1b[1mClaude:\x1b[0m ${claudeProcess && !claudeProcess.killed ? '\x1b[32mrunning\x1b[0m' : '\x1b[31mstopped\x1b[0m'}`);
      console.log(`\x1b[1mProcessing:\x1b[0m ${isProcessing ? 'yes' : 'no'}`);
      console.log();
      showPrompt();
      break;

    case '/cost':
      // Send /cost as a user message — Claude CLI handles it
      sendUserMessage('/cost');
      break;

    default:
      // Pass through skill commands
      if (PASSTHROUGH_COMMANDS.includes(cmd)) {
        sendUserMessage(input);
      } else {
        console.log(`\x1b[33mUnknown command: ${cmd}. Type /help for available commands.\x1b[0m`);
        showPrompt();
      }
      break;
  }
}

function restartClaude(extraArgs = []) {
  isRestarting = true;

  // Kill current process
  if (claudeProcess && !claudeProcess.killed) {
    claudeProcess.kill();
  }

  // Reset state
  isProcessing = false;
  pendingPermission = null;
  pendingQuestion = null;
  lineBuffer = '';
  sessionId = null;

  // Update args and respawn
  resumeId = extraArgs.includes('--resume') ? extraArgs[extraArgs.indexOf('--resume') + 1] : null;
  continueSession = extraArgs.includes('--continue');

  isRestarting = false;
  spawnClaude();

  setTimeout(showPrompt, 1000);
}

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
    files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.includes('/'));
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
        || getFirstUserText(headText)
        || '(untitled)';

      conversations.push({
        id,
        title,
        mtime: stat.mtimeMs,
      });
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

  const maxShow = 15;
  const shown = convos.slice(0, maxShow);
  console.log(`\n\x1b[1mPast conversations:\x1b[0m`);
  shown.forEach((c, i) => {
    const date = new Date(c.mtime).toLocaleDateString();
    console.log(`  \x1b[36m${i + 1}.\x1b[0m ${c.title} \x1b[2m(${date})\x1b[0m`);
  });
  if (convos.length > maxShow) {
    console.log(`\x1b[2m  ... and ${convos.length - maxShow} more\x1b[0m`);
  }
  console.log();

  // Set up a one-time line handler for the selection
  resumeSelecting = shown;
  footer.activate('Select #: ');
}

let resumeSelecting = null; // array of conversations being shown for selection

// --- Footer helpers ---

// Write to content area, temporarily leaving footer if active
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
  if (!isProcessing && !pendingPermission && !pendingQuestion && !resumeSelecting) {
    footer.activate('> ');
  }
}

function submitInput() {
  const line = footer.submit();
  // Echo user input to content area (dark gray background to distinguish from output)
  console.log(`\x1b[48;2;45;45;45m\x1b[1m > \x1b[22m${line} \x1b[0m`);

  const trimmed = line.trim();

  // Handle resume selection
  if (resumeSelecting) {
    const convos = resumeSelecting;
    resumeSelecting = null;

    if (!trimmed) {
      console.log('\x1b[2mCancelled.\x1b[0m');
      showPrompt();
      return;
    }

    const num = parseInt(trimmed, 10);
    if (num >= 1 && num <= convos.length) {
      const selected = convos[num - 1];
      console.log(`\x1b[32mResuming: ${selected.title}\x1b[0m\n`);
      restartClaude(['--resume', selected.id]);
    } else {
      console.log('\x1b[33mInvalid selection.\x1b[0m');
      showPrompt();
    }
    return;
  }

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

  // Skip input when footer is not active (processing, etc.)
  if (!footer.inputActive) return;

  // Ctrl+C
  if (key === '\x03') {
    footer.cleanup();
    if (claudeProcess) claudeProcess.kill();
    relay.disconnect();
    process.stdout.write('\n');
    process.exit(0);
  }

  // Ctrl+D
  if (key === '\x04') {
    footer.cleanup();
    if (claudeProcess) claudeProcess.kill();
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

  // Arrow up/down — ignore (no history yet)
  if (key === '\x1b[A' || key === '\x1b[B') return;

  // Ignore other escape sequences
  if (key.startsWith('\x1b')) return;

  // Regular character — insert at cursor position
  footer.inputBuffer = footer.inputBuffer.slice(0, footer.cursorPos) + key + footer.inputBuffer.slice(footer.cursorPos);
  footer.cursorPos += key.length;
  footer.redrawInput();
});

// --- Startup ---

// Read version from package.json
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
  const inner = width - 4; // padding inside box

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

  // ╭─ Remote Clauding v1.0.0 ───...───╮  (total = width)
  // 2 + 1 + 15 + 1 + 1 + ver.len + 1 + dashes + 1 = width
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

// Create local session (not shared yet — like VSCode's shared: false)
const projectName = path.basename(getNativeCwd());
relay.createLocalSession(getNativeCwd(), projectName);

renderStartupPanel();

// Setup footer (scroll region + footer panel)
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

// Only spawn claude — relay connects on /share
spawnClaude();

// Show initial prompt after a short delay (wait for system init)
setTimeout(showPrompt, 1000);
