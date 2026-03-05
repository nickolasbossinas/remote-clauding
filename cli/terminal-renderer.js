// Terminal renderer: parse NDJSON from claude stdout and render to terminal

import { renderMarkdown } from './markdown-render.js';

const TOOL_COLORS = {
  Bash: '\x1b[33m',    // yellow
  Edit: '\x1b[36m',    // cyan
  Write: '\x1b[36m',
  Read: '\x1b[90m',    // gray
  Glob: '\x1b[90m',
  Grep: '\x1b[90m',
  WebFetch: '\x1b[35m', // magenta
  WebSearch: '\x1b[35m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

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
    this._mdRawLines = 0;       // number of newlines written to terminal (for clearing)
    this._marginWritten = false; // whether the blank line margin has been output
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

        this.stopThinking();
        if (this._inTextBlock) {
          process.stdout.write('\n');
          this._inTextBlock = false;
        }
        const name = ev.content_block.name;
        const color = TOOL_COLORS[name] || DIM;
        console.log(`\n${color}▶ ${name}${RESET}`);
      } else if (ev.content_block?.type === 'text') {
        this.stopThinking();
        this._inTextBlock = true;
        this._textStarted = false;
        this._mdTextBuf = '';
        this._mdRawLines = 0;
        this._marginWritten = false;
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
        process.stdout.write(`${DIM}${ev.delta.partial_json || ''}${RESET}`);
      }
    } else if (ev.type === 'content_block_stop') {
      if (this._suppressBlockIndex !== null && ev.index === this._suppressBlockIndex) {
        this._suppressBlockIndex = null;
      }
      this._reformatMd();
    }
  }

  // Write raw text to terminal during streaming (for live typing feel)
  _writeRawStreaming(text) {
    this._mdTextBuf += text;

    // Write margin + prefix on first output
    if (!this._marginWritten) {
      this._marginWritten = true;
      process.stdout.write('\n● ');
    }

    // Write raw text, count newlines for later clearing
    process.stdout.write(text);
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') this._mdRawLines++;
    }
  }

  // Clear raw streaming output and re-render with full markdown formatting
  _reformatMd() {
    if (!this._mdTextBuf || !this._marginWritten) return;

    // Move cursor back to start of raw output (the ● line)
    if (this._mdRawLines > 0) {
      process.stdout.write(`\x1b[${this._mdRawLines}A`);
    }
    // Clear raw lines one-by-one (avoid \x1b[0J which would wipe the footer)
    for (let i = 0; i <= this._mdRawLines; i++) {
      process.stdout.write('\r\x1b[K');
      if (i < this._mdRawLines) process.stdout.write('\x1b[B');
    }
    // Move back up to the start
    if (this._mdRawLines > 0) {
      process.stdout.write(`\x1b[${this._mdRawLines}A`);
    }

    // Render formatted markdown
    const formatted = renderMarkdown(this._mdTextBuf);
    process.stdout.write('● ' + formatted);

    // Reset
    this._mdTextBuf = '';
    this._mdRawLines = 0;
  }

  _renderToolResult(event) {
    const blocks = event.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_result') {
        if (this._suppressToolUseId === block.tool_use_id) continue;

        const content = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('')
          : '';
        const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
        if (block.is_error) {
          console.log(`${RED}✗ Error: ${preview}${RESET}`);
        } else if (preview) {
          console.log(`${DIM}${preview}${RESET}`);
        }
      }
    }
  }

  renderPermissionPrompt(request) {
    this.stopThinking();
    const { tool_name, input } = request;
    const color = TOOL_COLORS[tool_name] || YELLOW;
    console.log(`\n${color}${BOLD}⚡ ${tool_name}${RESET} wants to run:`);
    const summary = getToolSummary(tool_name, input);
    if (summary) console.log(`  ${summary}`);
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
      return cmd.length > 120 ? cmd.substring(0, 120) + '...' : cmd;
    }
    case 'Glob': return input.pattern || '';
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    default: return JSON.stringify(input).substring(0, 120);
  }
}
