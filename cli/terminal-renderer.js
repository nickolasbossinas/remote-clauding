// Terminal renderer: parse NDJSON from claude stdout and render to terminal

import { renderMarkdown } from './markdown-render.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';

// Match VSCode panel dot colors exactly
const DOT_PROGRESS = '\x1b[38;2;217;119;87m';  // #d97757 — orange
const DOT_SUCCESS = '\x1b[38;2;116;201;145m';   // #74c991 — green
const DOT_ERROR = '\x1b[38;2;199;78;57m';       // #c74e39 — red

const THINKING_LABELS = [
  'Thinking', 'Concocting', 'Clauding', 'Finagling',
  'Envisioning', 'Pondering', 'Musing', 'Ruminating',
  'Accomplishing', 'Baking', 'Brewing', 'Calculating',
  'Cerebrating', 'Cogitating', 'Computing', 'Crafting',
];
const SPARKLE_FRAMES = ['\u00B7', '\u2722', '*', '\u2736', '\u273B', '\u273D',
                        '\u273B', '\u2736', '*', '\u2722', '\u00B7'];

export class TerminalRenderer {
  constructor() {
    this._inTextBlock = false;
    this._suppressToolUseId = null;
    this._suppressBlockIndex = null;
    this._thinkingActive = false;
    this._sparkleInterval = null;
    this._textInterval = null;
    this._sparkleIdx = 0;
    this._textIdx = 0;
    // Markdown streaming state
    this._textStarted = false;  // true after first non-whitespace text delta
    this._mdTextBuf = '';       // accumulates full text for markdown rendering
    this._suppressText = false;  // suppress text blocks after ToolSearch until a visible tool starts
    // Tool input accumulation (for formatted summary instead of raw JSON)
    this._toolJsonBuf = '';       // accumulates input_json_delta fragments
    this._toolName = null;        // current tool name for summary formatting
    // Track rendered tool IDs to avoid duplicate headers
    this._renderedToolIds = new Set();
  }

  suppressToolUse(toolUseId) {
    this._suppressToolUseId = toolUseId;
  }

  startThinking() {
    if (this._thinkingActive) return;
    this._thinkingActive = true;
    this._sparkleIdx = 0;
    this._textIdx = Math.floor(Math.random() * THINKING_LABELS.length);

    const label = THINKING_LABELS[this._textIdx];
    process.stdout.write(`\n\x1b[38;2;217;119;6m${SPARKLE_FRAMES[0]} ${label}...\x1b[0m`);

    this._sparkleInterval = setInterval(() => {
      this._sparkleIdx = (this._sparkleIdx + 1) % SPARKLE_FRAMES.length;
      this.redrawThinking();
    }, 120);

    this._textInterval = setInterval(() => {
      this._textIdx = (this._textIdx + 1) % THINKING_LABELS.length;
      this.redrawThinking();
    }, 3000);
  }

  redrawThinking() {
    if (!this._thinkingActive) return;
    const icon = SPARKLE_FRAMES[this._sparkleIdx];
    const label = THINKING_LABELS[this._textIdx];
    process.stdout.write(`\r\x1b[K\x1b[38;2;217;119;6m${icon} ${label}...\x1b[0m`);
  }

  stopThinking() {
    if (!this._thinkingActive) return;
    this._thinkingActive = false;
    if (this._sparkleInterval) { clearInterval(this._sparkleInterval); this._sparkleInterval = null; }
    if (this._textInterval) { clearInterval(this._textInterval); this._textInterval = null; }
    // Clear the thinking line and the blank line above it
    process.stdout.write('\r\x1b[K\x1b[A\r\x1b[K');
  }

  renderEvent(event) {
    switch (event.type) {
      case 'system':
        break;

      case 'stream_event':
        this._renderStreamEvent(event.event);
        break;

      case 'assistant':
        this._renderAssistantTools(event);
        break;

      case 'user':
        this._renderToolResult(event);
        break;

      case 'control_request':
        this.stopThinking();
        break;

      case 'result':
        this.stopThinking();
        this._reformatMd();
        if (this._inTextBlock) {
          process.stdout.write('\n\n');  // trailing newline + bottom margin
          this._inTextBlock = false;
        }
        this._suppressToolUseId = null;
        this._suppressText = false;
        this._renderedToolIds.clear();
        break;
    }
  }

  _renderStreamEvent(ev) {
    if (!ev) return;

    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type === 'tool_use') {
        if (this._suppressToolUseId === ev.content_block.id) {
          this._suppressBlockIndex = ev.index;
          return;
        }
        // Skip internal SDK tools and suppress following text
        if (ev.content_block.name === 'ToolSearch') {
          this._suppressBlockIndex = ev.index;
          this._suppressText = true;
          return;
        }

        this._suppressText = false;
        // Skip if already rendered from assistant message
        if (this._renderedToolIds.has(ev.content_block.id)) {
          this._suppressBlockIndex = ev.index;
          return;
        }
        this._renderedToolIds.add(ev.content_block.id);
        this.stopThinking();
        if (this._inTextBlock) {
          process.stdout.write('\n');
          this._inTextBlock = false;
        }
        const name = ev.content_block.name;
        console.log(`\n${DOT_PROGRESS}●${RESET} ${BOLD}${name}${RESET}`);
        this._toolName = name;
        this._toolJsonBuf = '';
      } else if (ev.content_block?.type === 'text') {
        // Only suppress the first text block after ToolSearch (stray explanation text)
        // Subsequent text blocks are real Claude output
        if (this._suppressText) {
          this._suppressBlockIndex = ev.index;
          this._suppressText = false; // reset — only suppress one text block
          return;
        }
        this._inTextBlock = true;
        this._textStarted = false;
        this._mdTextBuf = '';
      }
    } else if (ev.type === 'content_block_delta') {
      if (this._suppressBlockIndex !== null && ev.index === this._suppressBlockIndex) return;

      if (ev.delta?.type === 'text_delta') {
        let text = ev.delta.text || '';
        if (!this._textStarted) {
          text = text.trimStart();
          if (text.length > 0) {
            this._textStarted = true;
            this._writeRawStreaming(text);
          }
        } else {
          this._writeRawStreaming(text);
        }
        this._inTextBlock = true;
      } else if (ev.delta?.type === 'input_json_delta') {
        this._toolJsonBuf += ev.delta.partial_json || '';
      }
    } else if (ev.type === 'content_block_stop') {
      if (this._suppressBlockIndex !== null && ev.index === this._suppressBlockIndex) {
        this._suppressBlockIndex = null;
      }
      // Show formatted tool summary when tool block completes
      if (this._toolJsonBuf && this._toolName) {
        try {
          const input = JSON.parse(this._toolJsonBuf);
          const summary = getToolSummary(this._toolName, input);
          if (summary) {
            process.stdout.write(renderContained(summary) + '\n');
          }
        } catch {}
        this._toolJsonBuf = '';
        this._toolName = null;
      }
      this._reformatMd();
    }
  }

  // Buffer text silently during streaming (rendered on block end)
  _writeRawStreaming(text) {
    this._mdTextBuf += text;
  }

  // Render buffered markdown text
  _reformatMd() {
    if (!this._mdTextBuf) return;

    const formatted = renderMarkdown(this._mdTextBuf);
    this.stopThinking();
    process.stdout.write('\n● ' + formatted);

    // Reset
    this._mdTextBuf = '';
  }

  _renderAssistantTools(event) {
    const blocks = event.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_use') {
        if (block.name === 'ToolSearch' || block.name === 'AskUserQuestion') continue;
        if (this._suppressToolUseId === block.id) continue;
        if (this._renderedToolIds.has(block.id)) continue;
        this._renderedToolIds.add(block.id);

        this.stopThinking();
        if (this._inTextBlock) {
          process.stdout.write('\n');
          this._inTextBlock = false;
        }
        console.log(`\n${DOT_PROGRESS}●${RESET} ${BOLD}${block.name}${RESET}`);
        const summary = getToolSummary(block.name, block.input);
        if (summary) {
          process.stdout.write(renderContained(summary) + '\n');
        }
      }
    }
  }

  _renderToolResult(event) {
    const blocks = event.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_result') {
        if (this._suppressToolUseId === block.tool_use_id) continue;

        if (block.is_error) {
          let content = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('')
            : '';
          // Strip XML wrapper tags from SDK errors
          content = content.replace(/<\/?tool_use_error>/g, '').trim();
          const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
          this.stopThinking();
          process.stdout.write(renderContained(`✗ ${preview}`, DOT_ERROR) + '\n');
        }
      }
    }
  }

  renderPermissionPrompt(request) {
    this.stopThinking();
    const { tool_name, input } = request;
    console.log(`\n${DOT_PROGRESS}●${RESET} ${BOLD}${tool_name}${RESET} wants to run:`);
    const summary = getToolSummary(tool_name, input);
    if (summary) {
      console.log(renderContained(summary));
    }
  }

  renderQuestion(questions) {
    this.stopThinking();
    if (!questions || questions.length === 0) return;
    const q = questions[0];
    console.log(`\n${CYAN}${BOLD}❓ ${q.question}${RESET}`);
    if (q.options) {
      q.options.forEach((opt, i) => {
        console.log(`  ${BOLD}${i + 1}.${RESET} ${opt.label}${opt.description ? ` — ${DIM}${opt.description}${RESET}` : ''}`);
      });
    }
  }

  renderPhoneMessage(content) {
    console.log(`\n${GREEN}📱 [Phone]: ${content}${RESET}`);
  }
}

function getToolSummary(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Bash': {
      const cmd = input.command || '';
      return cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd;
    }
    case 'Glob': return input.pattern || '';
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    default: return JSON.stringify(input).substring(0, 120);
  }
}

// Render text as contained lines under a tool block with a left bar
function renderContained(text, color = DIM) {
  const lines = text.split('\n');
  return lines.map(l => `${DIM}  │${RESET} ${color}${l}${RESET}`).join('\n');
}
