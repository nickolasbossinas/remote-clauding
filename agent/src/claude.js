import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the claude CLI script directly (avoids Windows .cmd shell issues)
const CLAUDE_CLI_SCRIPT = path.join(
  __dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'
);

export class ClaudeBridge extends EventEmitter {
  constructor(projectPath) {
    super();
    this.projectPath = projectPath;
    this.process = null;
    this.sessionId = null;
    this.isRunning = false;
    this.messageQueue = [];
    // Dedup tracking: streaming events vs full assistant message
    this._streamedText = false;
    this._seenToolIds = new Set();
  }

  sendMessage(content) {
    if (this.isRunning) {
      // Queue the message and process it when current one finishes
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ content, resolve, reject });
        console.log(`[Claude] Message queued (${this.messageQueue.length} in queue)`);
      });
    }
    return this._processMessage(content);
  }

  _processMessage(content) {
    return new Promise((resolve, reject) => {

      this.isRunning = true;
      this._streamedText = false;
      this._assistantTextEmitted = false;
      this._seenToolIds.clear();
      this.emit('status', 'processing');

      // Build command args
      const args = [
        '-p', content,
        '--output-format', 'stream-json',
        '--verbose',
      ];

      // Continue previous conversation if we have a session
      if (this.sessionId) {
        args.unshift('--resume', this.sessionId);
      }

      console.log(`[Claude] Running: node ${CLAUDE_CLI_SCRIPT} ${args.join(' ')}`);
      console.log(`[Claude] CWD: ${this.projectPath}`);

      // Remove CLAUDECODE env var to allow spawning inside a Claude Code session
      const env = { ...process.env };
      delete env.CLAUDECODE;

      this.process = spawn(process.execPath, [CLAUDE_CLI_SCRIPT, ...args], {
        cwd: this.projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      console.log(`[Claude] Process PID: ${this.process.pid}`);

      let buffer = '';
      const messages = [];

      this.process.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleStreamMessage(parsed);
            messages.push(parsed);
          } catch {
            // Not JSON, might be plain text output
            this.emit('output', {
              type: 'text',
              content: line,
            });
          }
        }
      });

      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        console.error(`[Claude stderr] ${text}`);
        this.emit('output', {
          type: 'error',
          content: text,
        });
      });

      this.process.on('close', (code) => {
        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            this.handleStreamMessage(parsed);
            messages.push(parsed);
          } catch {
            // ignore
          }
        }

        this.isRunning = false;
        this.process = null;
        this.emit('done', { code, messages });

        if (code === 0) {
          resolve(messages);
        } else {
          reject(new Error(`Claude exited with code ${code}`));
        }

        // Process next queued message
        this._processQueue();
      });

      this.process.on('error', (err) => {
        this.isRunning = false;
        this.process = null;
        this.emit('status', 'error');
        reject(err);
      });
    });
  }

  handleStreamMessage(msg) {
    // Extract session ID from initial message if available
    if (msg.session_id && !this.sessionId) {
      this.sessionId = msg.session_id;
      console.log(`[Claude] Session ID: ${this.sessionId}`);
    }

    // Suppress noise: system init, rate_limit, content_block_stop, message_start/stop
    if (msg.type === 'system' || msg.type === 'rate_limit_event' ||
        msg.type === 'content_block_stop' || msg.type === 'message_start' ||
        msg.type === 'message_stop') {
      // Update session_id from result-like messages
      if (msg.session_id) this.sessionId = msg.session_id;
      return;
    }

    if (msg.type === 'assistant') {
      // Complete assistant message with all content blocks.
      // CLI v2.1.50 does NOT emit content_block_start/delta events,
      // so this is the primary source of text and tool_use data.
      const message = msg.message || msg;
      const contentBlocks = message.content || [];

      for (const block of Array.isArray(contentBlocks) ? contentBlocks : []) {
        if (block.type === 'text' && block.text) {
          // Only emit if not already delivered via streaming deltas
          if (!this._streamedText) {
            this._assistantTextEmitted = true;
            this.emit('output', {
              type: 'assistant_message',
              role: 'assistant',
              content: block.text,
            });
          }
        } else if (block.type === 'tool_use') {
          // AskUserQuestion gets special treatment — render as interactive question
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            this._seenToolIds.add(block.id);
            this.emit('output', {
              type: 'ask_question',
              toolId: block.id,
              questions: block.input.questions,
            });
          } else {
            const summary = this.getToolSummary(block.name, block.input);
            if (this._seenToolIds.has(block.id)) {
              this.emit('output', {
                type: 'tool_use_update',
                toolId: block.id,
                toolName: block.name,
                toolInput: block.input,
                summary,
              });
            } else {
              this._seenToolIds.add(block.id);
              this.emit('output', {
                type: 'tool_use_start',
                toolName: block.name,
                toolId: block.id,
                toolInput: block.input,
                summary,
              });
            }
          }
        }
      }
    } else if (msg.type === 'content_block_start') {
      if (msg.content_block?.type === 'tool_use') {
        this._seenToolIds.add(msg.content_block.id);
        // Don't emit tool_use_start for AskUserQuestion — wait for full data in assistant message
        if (msg.content_block.name !== 'AskUserQuestion') {
          this.emit('output', {
            type: 'tool_use_start',
            toolName: msg.content_block.name,
            toolId: msg.content_block.id,
            toolInput: msg.content_block.input,
            summary: this.getToolSummary(msg.content_block.name, msg.content_block.input),
          });
        }
      } else if (msg.content_block?.type === 'text') {
        this.emit('output', { type: 'text_block_start' });
      }
    } else if (msg.type === 'content_block_delta') {
      if (msg.delta?.type === 'input_json_delta') {
        this.emit('output', {
          type: 'tool_use_delta',
          content: msg.delta.partial_json || '',
        });
      } else {
        this._streamedText = true;
        this.emit('output', {
          type: 'assistant_delta',
          content: msg.delta?.text || '',
        });
      }
    } else if (msg.type === 'user') {
      // Tool results sent back to Claude
      const message = msg.message || msg;
      const contentBlocks = message.content || [];

      for (const block of Array.isArray(contentBlocks) ? contentBlocks : []) {
        if (block.type === 'tool_result') {
          this.emit('output', {
            type: 'tool_result',
            toolId: block.tool_use_id,
            content: block.content || msg.tool_use_result || '',
            isError: !!block.is_error,
          });
        }
      }
    } else if (msg.type === 'result') {
      this.sessionId = msg.session_id || this.sessionId;

      if (msg.subtype === 'input_required' || msg.is_input_required) {
        this.emit('input_required', {
          prompt: msg.result || 'Claude needs your input',
        });
      }

      // Show result text only if no text was emitted via assistant or streaming
      const resultContent = this.extractTextContent(msg);
      if (!this._streamedText && !this._assistantTextEmitted && resultContent) {
        this.emit('output', {
          type: 'assistant_message',
          role: 'assistant',
          content: resultContent,
        });
      }

      this.emit('output', {
        type: 'result',
        sessionId: this.sessionId,
        subtype: msg.subtype,
      });
    }
    // All other types are silently dropped
  }

  getToolSummary(toolName, input) {
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

  extractTextContent(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    }
    if (msg.result) return msg.result;
    return '';
  }

  _processQueue() {
    if (this.messageQueue.length === 0) {
      this.emit('status', 'idle');
      return;
    }
    const next = this.messageQueue.shift();
    console.log(`[Claude] Processing queued message (${this.messageQueue.length} remaining)`);
    this._processMessage(next.content).then(next.resolve).catch(next.reject);
  }

  abort() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.isRunning = false;
    }
  }
}
