import React, { useState } from 'react';

function getPermissionQuestion(toolName, toolInput, summary) {
  switch (toolName) {
    case 'Edit': case 'Write': case 'NotebookEdit':
      return 'Make this edit to ' + (toolInput?.file_path || toolInput?.notebook_path || 'file') + '?';
    case 'Bash': {
      const cmd = toolInput?.command || '';
      const short = cmd.length > 200 ? cmd.substring(0, 200) + '...' : cmd;
      return 'Run this command?' + (short ? '\n' + short : '');
    }
    default: {
      const s = summary || '';
      const short = s.length > 200 ? s.substring(0, 200) + '...' : s;
      return 'Allow ' + toolName + '?' + (short ? '\n' + short : '');
    }
  }
}

export default function PermissionCard({ message, onRespond, onSendMessage, onToggleAutoAccept }) {
  const { permissionId, toolName, toolInput, summary } = message;
  const [otherText, setOtherText] = useState('');
  const [answered, setAnswered] = useState(false);

  const questionText = getPermissionQuestion(toolName, toolInput, summary);

  function handleAllow(allowAll) {
    setAnswered(true);
    onRespond(permissionId, 'allow');
    if (allowAll) onToggleAutoAccept(true);
  }

  function handleDeny() {
    setAnswered(true);
    onRespond(permissionId, 'deny');
  }

  function handleOtherSubmit() {
    const text = otherText.trim();
    if (!text) return;
    setAnswered(true);
    onRespond(permissionId, 'deny');
    onSendMessage(text);
  }

  return (
    <div className={`question-card${answered ? ' question-answered' : ''}`}>
      <div className="question-header">{toolName}</div>
      <div className="question-text">{questionText}</div>
      <div className="question-options">
        <button className="question-option" onClick={() => handleAllow(false)} disabled={answered}>
          <span className="question-option-label">Yes</span>
        </button>
        <button className="question-option" onClick={() => handleAllow(true)} disabled={answered}>
          <span className="question-option-label">Yes, allow all edits this session</span>
        </button>
        <button className="question-option" onClick={() => handleDeny()} disabled={answered}>
          <span className="question-option-label">No</span>
        </button>
      </div>
      <input
        className="question-other-input"
        placeholder="Tell Claude what to do instead"
        value={otherText}
        onChange={e => setOtherText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') handleOtherSubmit();
        }}
        disabled={answered}
      />
    </div>
  );
}
