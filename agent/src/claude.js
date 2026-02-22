import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';

export class ClaudeBridge extends EventEmitter {
  constructor(projectPath) {
    super();
    this.projectPath = projectPath;
    this.sessionId = null;
    this.isRunning = false;
    this.messageQueue = [];
    this._abortController = null;
    // Pending AskUserQuestion: { resolve, questions }
    this._pendingQuestion = null;
    // Dedup tracking
    this._streamedText = false;
    this._assistantTextEmitted = false;
    this._seenToolIds = new Set();
  }

  sendMessage(content) {
    // If waiting for a question answer, treat this as the answer
    if (this._pendingQuestion) {
      const { resolve, questions } = this._pendingQuestion;
      this._pendingQuestion = null;

      // Build answers map: question text → user's answer
      const answers = {};
      if (questions.length > 0) {
        answers[questions[0].question] = content;
      }

      resolve({
        behavior: 'allow',
        updatedInput: { questions, answers },
      });
      this.emit('output', { type: 'question_answered' });
      this.emit('status', 'processing');
      return Promise.resolve();
    }

    if (this.isRunning) {
      return new Promise((resolve, reject) => {
        this.messageQueue.push({ content, resolve, reject });
        console.log(`[Claude] Message queued (${this.messageQueue.length} in queue)`);
      });
    }
    return this._processMessage(content);
  }

  async _processMessage(content) {
    this.isRunning = true;
    this._streamedText = false;
    this._assistantTextEmitted = false;
    this._seenToolIds.clear();
    this._abortController = new AbortController();
    this.emit('status', 'processing');

    // Remove CLAUDECODE env var to allow spawning inside a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const options = {
      abortController: this._abortController,
      cwd: this.projectPath,
      env,
      allowedTools: [
        'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep',
        'WebFetch', 'WebSearch', 'TodoWrite', 'Task',
        'NotebookEdit', 'AskUserQuestion',
      ],
      permissionMode: 'bypassPermissions',
      canUseTool: async (toolName, input, { signal }) => {
        if (toolName === 'AskUserQuestion' && input.questions) {
          // Emit the question to VSCode/phone and wait for answer
          this.emit('output', {
            type: 'ask_question',
            questions: input.questions,
          });
          this.emit('input_required', {
            prompt: input.questions[0]?.question || 'Claude needs your input',
          });

          // Wait for user to respond via sendMessage()
          return new Promise((resolve) => {
            this._pendingQuestion = { resolve, questions: input.questions };

            // If aborted while waiting, deny
            signal.addEventListener('abort', () => {
              if (this._pendingQuestion) {
                this._pendingQuestion = null;
                resolve({ behavior: 'deny', message: 'Session aborted' });
              }
            });
          });
        }

        // Auto-allow all other tools
        return { behavior: 'allow', updatedInput: input };
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    console.log(`[Claude] Running query: "${content.substring(0, 100)}"`);
    console.log(`[Claude] CWD: ${this.projectPath}, resume: ${this.sessionId || 'new'}`);

    try {
      for await (const msg of query({ prompt: content, options })) {
        this._handleSDKMessage(msg);
      }
    } catch (err) {
      console.error(`[Claude] Error:`, err.message);
      this.emit('output', { type: 'error', content: err.message });
    }

    this.isRunning = false;
    this._abortController = null;
    this.emit('done', { code: 0 });
    this._processQueue();
  }

  _handleSDKMessage(msg) {
    // Extract session ID
    if (msg.session_id && !this.sessionId) {
      this.sessionId = msg.session_id;
      console.log(`[Claude] Session ID: ${this.sessionId}`);
    } else if (msg.session_id) {
      this.sessionId = msg.session_id;
    }

    if (msg.type === 'assistant') {
      const message = msg.message || msg;
      const contentBlocks = message.content || [];

      for (const block of Array.isArray(contentBlocks) ? contentBlocks : []) {
        if (block.type === 'text' && block.text) {
          if (!this._streamedText) {
            this._assistantTextEmitted = true;
            this.emit('output', {
              type: 'assistant_message',
              role: 'assistant',
              content: block.text,
            });
          }
        } else if (block.type === 'tool_use') {
          // AskUserQuestion is handled via canUseTool callback, skip here
          if (block.name === 'AskUserQuestion') continue;

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
    } else if (msg.type === 'user') {
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
    } else if (msg.type === 'stream_event') {
      // Partial streaming events
      const event = msg.event;
      if (!event) return;

      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'tool_use') {
          this._seenToolIds.add(event.content_block.id);
          if (event.content_block.name !== 'AskUserQuestion') {
            this.emit('output', {
              type: 'tool_use_start',
              toolName: event.content_block.name,
              toolId: event.content_block.id,
              toolInput: event.content_block.input,
              summary: this.getToolSummary(event.content_block.name, event.content_block.input),
            });
          }
        } else if (event.content_block?.type === 'text') {
          this.emit('output', { type: 'text_block_start' });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'input_json_delta') {
          this.emit('output', {
            type: 'tool_use_delta',
            content: event.delta.partial_json || '',
          });
        } else if (event.delta?.type === 'text_delta') {
          this._streamedText = true;
          this.emit('output', {
            type: 'assistant_delta',
            content: event.delta.text || '',
          });
        }
      }
    } else if (msg.type === 'result') {
      const resultContent = msg.result || '';
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
    // All other types silently dropped
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
    if (this._pendingQuestion) {
      this._pendingQuestion.resolve({ behavior: 'deny', message: 'Aborted' });
      this._pendingQuestion = null;
    }
    if (this._abortController) {
      this._abortController.abort();
    }
    this.isRunning = false;
  }
}
