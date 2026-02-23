import React, { useState } from 'react';

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
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { toolName, toolInput, summary, result, isError } = message;

  const name = toolName || 'Tool';
  const inputText = formatInput(name, toolInput);
  const hasResult = result !== undefined;

  // Bash: prefer description for header, command stays in IN row
  let displaySummary = summary || '';
  if (name === 'Bash' && toolInput?.description) {
    displaySummary = toolInput.description;
  }

  // Truncate result for display
  const maxLen = 5000;
  const resultText = typeof result === 'string'
    ? (result.length > maxLen ? result.substring(0, maxLen) + '\n... (truncated)' : result)
    : result ? JSON.stringify(result, null, 2) : '';

  const handleHeaderClick = () => {
    if (collapsed) {
      setCollapsed(false);
    } else {
      setCollapsed(true);
      setExpanded(false);
    }
  };

  const handleBodyClick = () => {
    setExpanded(!expanded);
  };

  return (
    <div className={`tool-card${isError ? ' error' : ''}${collapsed ? ' collapsed' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="tool-header" onClick={handleHeaderClick}>
        <span className="tool-name">{name}</span>
        {displaySummary && <span className="tool-summary">{displaySummary}</span>}
      </div>
      <div className="tool-body" onClick={handleBodyClick}>
        <div className="tool-grid">
          <div className="tool-grid-row">
            <div className="tool-grid-label">IN</div>
            <div className="tool-grid-content">{inputText || '...'}</div>
          </div>
          <div className="tool-grid-row">
            <div className="tool-grid-label">OUT</div>
            <div className={`tool-grid-content${isError ? ' is-error' : ''}`}>
              {hasResult ? resultText : 'Running...'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
