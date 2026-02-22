import React from 'react';
import MessageList from './MessageList.jsx';
import InputBar from './InputBar.jsx';

export default function SessionView({ session, messages, onSendMessage, onStopExecution, status }) {
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
      <MessageList messages={messages} onSendMessage={onSendMessage} status={status} />
      <InputBar
        onSend={onSendMessage}
        onStop={onStopExecution}
        disabled={!session || session.status === 'disconnected'}
        status={status}
      />
    </div>
  );
}
