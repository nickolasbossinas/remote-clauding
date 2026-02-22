import React, { useState, useEffect } from 'react';
import { useRelay } from './hooks/useRelay.js';
import { usePush } from './hooks/usePush.js';
import SessionList from './components/SessionList.jsx';
import SessionView from './components/SessionView.jsx';
import StatusBar from './components/StatusBar.jsx';
import QRScanner from './components/QRScanner.jsx';

function getPairToken() {
  const hash = window.location.hash;
  const match = hash.match(/^#\/pair\/(.+)$/);
  if (match) {
    const token = decodeURIComponent(match[1]);
    localStorage.setItem('session_token', token);
    history.replaceState(null, '', window.location.pathname);
    return token;
  }
  return localStorage.getItem('session_token') || null;
}

export default function App() {
  const [pairToken, setPairToken] = useState(getPairToken);
  const relay = useRelay(pairToken);
  const push = usePush();
  const [view, setView] = useState(pairToken ? 'session' : 'list');
  const [showScanner, setShowScanner] = useState(false);

  const handleScan = (token) => {
    localStorage.setItem('session_token', token);
    window.location.reload();
  };

  const openSession = (sessionId) => {
    relay.subscribeSession(sessionId);
    setView('session');
  };

  const goBack = () => {
    relay.unsubscribeSession();
    setView('list');
  };

  // Auto-switch to session view when auto-subscribed via token
  useEffect(() => {
    if (relay.activeSessionId) {
      setView('session');
    }
  }, [relay.activeSessionId]);

  const activeSession = relay.sessions.find(
    (s) => s.id === relay.activeSessionId
  );

  return (
    <div className="app">
      <StatusBar
        connected={relay.connected}
        push={push}
        view={view}
        onBack={goBack}
        onScan={() => setShowScanner(true)}
        sessionName={activeSession?.projectName}
      />

      {showScanner && (
        <QRScanner
          onScan={handleScan}
          onClose={() => setShowScanner(false)}
        />
      )}

      {view === 'list' ? (
        <SessionList
          sessions={relay.sessions}
          onSelectSession={openSession}
          connected={relay.connected}
          onScan={() => setShowScanner(true)}
        />
      ) : (
        <SessionView
          session={activeSession}
          messages={relay.messages}
          onSendMessage={relay.sendMessage}
          onStopExecution={relay.stopExecution}
          status={activeSession?.status}
        />
      )}
    </div>
  );
}
