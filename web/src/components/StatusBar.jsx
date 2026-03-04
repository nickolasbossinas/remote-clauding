import React from 'react';

export default function StatusBar({ connected, push, view, onBack, onScan, sessionName }) {
  return (
    <header className="status-bar">
      <div className="status-bar-left">
        {view === 'session' && (
          <button className="back-btn" onClick={onBack}>
            &larr;
          </button>
        )}
        <h1 className="status-bar-title">
          {view === 'session' && sessionName
            ? sessionName
            : 'Remote Clauding'}
        </h1>
      </div>

      <div className="status-bar-right">
        {view === 'list' && (
          <button className="scan-btn" onClick={onScan} title="Scan QR Code">
            Scan QR
          </button>
        )}
        {push.pushSupported && (
          <button
            className={`push-btn${push.pushEnabled ? ' push-enabled' : ''}`}
            onClick={push.pushEnabled ? push.disablePush : push.enablePush}
            title={push.pushEnabled ? 'Disable notifications' : 'Enable notifications'}
          >
            {push.pushEnabled ? 'Notifications On' : 'Enable Notifications'}
          </button>
        )}
        <span
          className={`connection-dot ${connected ? 'connected' : 'disconnected'}`}
          title={connected ? 'Connected' : 'Disconnected'}
        />
      </div>
    </header>
  );
}
