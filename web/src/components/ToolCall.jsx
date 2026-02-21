import React, { useState } from 'react';

const TOOL_ICONS = {
  Read: '\u{1F4C4}', Edit: '\u{270F}\u{FE0F}', Write: '\u{1F4DD}',
  Bash: '\u{1F4BB}', Glob: '\u{1F4C2}', Grep: '\u{1F50E}',
  WebFetch: '\u{1F310}', WebSearch: '\u{1F50D}',
  TodoWrite: '\u{2705}', Task: '\u{1F4CB}',
  NotebookEdit: '\u{1F4D3}',
};

function formatInput(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Bash': return input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': {
      let s = input.file_path || '';
      if (input.old_string) s += '\n--- old\n' + input.old_string + '\n+++ new\n' + (input.new_string || '');
      return s;
    }
    case 'Glob': return input.pattern || '';
    case 'Grep': return (input.pattern || '') + (input.path ? '  in ' + input.path : '');
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    default:
      return typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);
  }
}

export default function ToolCall({ message }) {
  const [expanded, setExpanded] = useState(false);
  const { toolName, toolInput, summary, result, isError } = message;

  const name = toolName || 'Tool';
  const icon = TOOL_ICONS[name] || '\u{1F527}';
  const inputText = formatInput(name, toolInput);
  const hasResult = result !== undefined;

  // Truncate result for display
  const maxLen = 5000;
  const resultText = typeof result === 'string'
    ? (result.length > maxLen ? result.substring(0, maxLen) + '\n... (truncated)' : result)
    : result ? JSON.stringify(result, null, 2) : '';

  return (
    <div className={`tool-card${isError ? ' tool-card-error' : ''}`}>
      <button
        className="tool-card-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-card-icon">{icon}</span>
        <span className="tool-card-name">{name}</span>
        {summary && <span className="tool-card-summary">{summary}</span>}
        <span className={`tool-card-status ${hasResult ? (isError ? 'status-error' : 'status-success') : 'status-running'}`}>
          {hasResult ? (isError ? '\u2717' : '\u2713') : '\u25CB'}
        </span>
      </button>

      {expanded && (
        <div className="tool-card-body">
          {inputText && (
            <>
              <div className="tool-section-label">Input</div>
              <pre className="tool-card-input">{inputText}</pre>
            </>
          )}
          {hasResult && (
            <>
              <div className="tool-section-label">Output</div>
              <pre className={`tool-card-output${isError ? ' output-error' : ''}`}>{resultText}</pre>
            </>
          )}
          {!inputText && !hasResult && (
            <div className="tool-card-empty">No details available</div>
          )}
        </div>
      )}
    </div>
  );
}
