import React from 'react';
import MessageList from './MessageList.jsx';
import InputBar from './InputBar.jsx';

export default function SessionView({
  session, messages, onSendMessage, onStopExecution,
  onPermissionRespond, autoAccept, onToggleAutoAccept, status,
}) {
  if (!session) {
    return (
      <div className="session-view">
        <div className="empty-state">
          <p>Connecting to session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="session-view">
      <div className="auto-accept-bar">
        <label className="auto-accept-label">
          <input
            type="checkbox"
            className="auto-accept-toggle"
            checked={autoAccept}
            onChange={(e) => onToggleAutoAccept(e.target.checked)}
          />
          Auto-accept edits
        </label>
      </div>
      <MessageList
        messages={messages}
        onSendMessage={onSendMessage}
        onPermissionRespond={onPermissionRespond}
        status={status}
      />
      <InputBar
        onSend={onSendMessage}
        onStop={onStopExecution}
        disabled={!session || session.status === 'disconnected'}
        status={status}
      />
    </div>
  );
}
