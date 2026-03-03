import React from 'react';

export default function PermissionCard({ message, onRespond }) {
  const { permissionId, toolName, toolInput, summary, resolved, action } = message;

  const displaySummary = toolName === 'Bash' && toolInput?.description
    ? toolInput.description
    : summary || '';

  return (
    <div className={`permission-card${resolved ? ' permission-resolved' : ''}`}>
      <div className="permission-tool-name">{toolName}</div>
      {displaySummary && (
        <div className="permission-summary">{displaySummary}</div>
      )}
      {!resolved ? (
        <div className="permission-actions">
          <button
            className="permission-accept"
            onClick={() => onRespond(permissionId, 'allow')}
          >
            Accept
          </button>
          <button
            className="permission-deny"
            onClick={() => onRespond(permissionId, 'deny')}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="permission-result">
          {action === 'allow' ? 'Accepted' : 'Denied'}
        </div>
      )}
    </div>
  );
}
