import React from 'react';
import MessageList from './MessageList.jsx';
import InputBar from './InputBar.jsx';

export default function SessionView({ session, messages, onSendMessage }) {
  if (!session) {
    return (
      <div className="session-view">
        <div className="empty-state">
          <p>Session not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="session-view">
      <MessageList messages={messages} onSendMessage={onSendMessage} />
      <InputBar
        onSend={onSendMessage}
        disabled={!session || session.status === 'disconnected'}
      />
    </div>
  );
}
