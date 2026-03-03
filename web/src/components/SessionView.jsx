import React from 'react';
import MessageList from './MessageList.jsx';
import InputBar from './InputBar.jsx';
import AskQuestion from './AskQuestion.jsx';
import PermissionCard from './PermissionCard.jsx';

export default function SessionView({
  session, messages, onSendMessage, onStopExecution,
  onPermissionRespond, onDismissQuestion, autoAccept, onToggleAutoAccept, status,
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

  // Find pending overlay: most recent unresolved question or permission
  const pendingQuestion = messages.findLast(m => m.type === 'ask_question' && !m.answered);
  const pendingPermission = messages.findLast(m => m.type === 'permission_request' && !m.resolved);
  const pendingOverlay = pendingPermission || pendingQuestion;

  const handleDismiss = () => {
    if (pendingOverlay.type === 'ask_question') {
      onDismissQuestion();
    } else {
      onPermissionRespond(pendingOverlay.permissionId, 'deny');
    }
  };

  return (
    <div className="session-view">
      <MessageList
        messages={messages}
        status={status}
      />
      {pendingOverlay ? (
        <div className="overlay-dialog">
          <button className="overlay-close" onClick={handleDismiss}>&times;</button>
          {pendingOverlay.type === 'ask_question' ? (
            <AskQuestion
              message={pendingOverlay}
              onAnswer={onSendMessage}
              answered={false}
            />
          ) : (
            <PermissionCard
              message={pendingOverlay}
              onRespond={onPermissionRespond}
              onSendMessage={onSendMessage}
              onToggleAutoAccept={onToggleAutoAccept}
            />
          )}
        </div>
      ) : (
        <>
          <InputBar
            onSend={onSendMessage}
            onStop={onStopExecution}
            disabled={!session || session.status === 'disconnected'}
            status={status}
          />
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
        </>
      )}
    </div>
  );
}
