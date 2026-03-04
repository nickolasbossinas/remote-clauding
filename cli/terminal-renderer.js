// Terminal renderer: parse NDJSON from claude stdout and render to terminal

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

export class TerminalRenderer {
  constructor() {
    this._inTextBlock = false;
    this._suppressToolUseId = null;  // tool_use_id to suppress rendering for
    this._suppressBlockIndex = null; // content block index being suppressed
  }

  /** Tell the renderer to suppress all output for a specific tool_use block */
  suppressToolUse(toolUseId) {
    this._suppressToolUseId = toolUseId;
  }

  renderEvent(event) {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          console.log(`${DIM}Session: ${event.session_id}${RESET}`);
          console.log(`${DIM}Model: ${event.model}${RESET}`);
        }
        break;

      case 'stream_event':
        this._renderStreamEvent(event.event);
        break;

      case 'assistant':
        // Full assistant message (only render if no streaming happened)
        break;

      case 'user':
        this._renderToolResult(event);
        break;

      case 'control_request':
        // Handled by main app (permission prompts)
        break;

      case 'result':
        if (this._inTextBlock) {
          process.stdout.write('\n');
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
        // Check if this tool_use is suppressed
        if (this._suppressToolUseId === ev.content_block.id) {
          this._suppressBlockIndex = ev.index;
          return;
        }

        if (this._inTextBlock) {
          process.stdout.write('\n');
          this._inTextBlock = false;
        }
        const name = ev.content_block.name;
        const color = TOOL_COLORS[name] || DIM;
        console.log(`\n${color}▶ ${name}${RESET}`);
      } else if (ev.content_block?.type === 'text') {
        this._inTextBlock = true;
      }
    } else if (ev.type === 'content_block_delta') {
      // Skip deltas for suppressed block
      if (this._suppressBlockIndex !== null && ev.index === this._suppressBlockIndex) return;

      if (ev.delta?.type === 'text_delta') {
        process.stdout.write(ev.delta.text || '');
        this._inTextBlock = true;
      } else if (ev.delta?.type === 'input_json_delta') {
        // Tool input streaming — show dimmed
        process.stdout.write(`${DIM}${ev.delta.partial_json || ''}${RESET}`);
      }
    } else if (ev.type === 'content_block_stop') {
      if (this._suppressBlockIndex !== null && ev.index === this._suppressBlockIndex) {
        this._suppressBlockIndex = null;
      }
    }
  }

  _renderToolResult(event) {
    const blocks = event.message?.content || [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === 'tool_result') {
        // Skip suppressed tool results
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
    const { tool_name, input } = request;
    const color = TOOL_COLORS[tool_name] || YELLOW;
    console.log(`\n${color}${BOLD}⚡ ${tool_name}${RESET} wants to run:`);
    const summary = getToolSummary(tool_name, input);
    if (summary) console.log(`  ${summary}`);
    process.stdout.write(`${YELLOW}Allow? (y/n): ${RESET}`);
  }

  renderQuestion(questions) {
    if (!questions || questions.length === 0) return;
    const q = questions[0];
    console.log(`\n${CYAN}${BOLD}❓ ${q.question}${RESET}`);
    if (q.options) {
      q.options.forEach((opt, i) => {
        console.log(`  ${BOLD}${i + 1}.${RESET} ${opt.label}${opt.description ? ` — ${DIM}${opt.description}${RESET}` : ''}`);
      });
    }
    process.stdout.write(`${CYAN}Your answer: ${RESET}`);
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
