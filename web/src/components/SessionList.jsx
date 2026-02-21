import React from 'react';

const STATUS_LABELS = {
  idle: 'Idle',
  processing: 'Working...',
  input_required: 'Needs Input',
  error: 'Error',
  disconnected: 'Disconnected',
};

const STATUS_CLASSES = {
  idle: 'status-idle',
  processing: 'status-processing',
  input_required: 'status-input',
  error: 'status-error',
  disconnected: 'status-disconnected',
};

export default function SessionList({ sessions, onSelectSession, connected }) {
  if (!connected) {
    return (
      <div className="session-list">
        <div className="empty-state">
          <p>Connecting to server...</p>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="session-list">
        <div className="empty-state">
          <p className="empty-title">No Active Sessions</p>
          <p className="empty-subtitle">
            Click "Share to Mobile" in VSCode to start sharing a Claude session
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="session-list">
      {sessions.map((session) => (
        <button
          key={session.id}
          className="session-card"
          onClick={() => onSelectSession(session.id)}
        >
          <div className="session-card-header">
            <span className="session-name">{session.projectName}</span>
            <span className={`session-status ${STATUS_CLASSES[session.status] || ''}`}>
              {STATUS_LABELS[session.status] || session.status}
            </span>
          </div>
          {session.lastMessage && (
            <p className="session-preview">{session.lastMessage}</p>
          )}
          <span className="session-meta">
            {session.messageCount || 0} messages
          </span>
        </button>
      ))}
    </div>
  );
}
