import React, { useState, useEffect } from 'react';
import { useRelay } from './hooks/useRelay.js';
import { usePush } from './hooks/usePush.js';
import SessionList from './components/SessionList.jsx';
import SessionView from './components/SessionView.jsx';
import StatusBar from './components/StatusBar.jsx';

function getPairToken() {
  const hash = window.location.hash;
  const match = hash.match(/^#\/pair\/(.+)$/);
  if (match) {
    const token = decodeURIComponent(match[1]);
    localStorage.setItem('session_token', token);
    // Clean up hash so it doesn't persist in URL
    history.replaceState(null, '', window.location.pathname);
    return token;
  }
  return localStorage.getItem('session_token') || null;
}

export default function App() {
  const [pairToken] = useState(getPairToken);
  const relay = useRelay(pairToken);
  const push = usePush();
  const [view, setView] = useState(pairToken ? 'session' : 'list');

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
        sessionName={activeSession?.projectName}
      />

      {view === 'list' ? (
        <SessionList
          sessions={relay.sessions}
          onSelectSession={openSession}
          connected={relay.connected}
        />
      ) : (
        <SessionView
          session={activeSession}
          messages={relay.messages}
          onSendMessage={relay.sendMessage}
          status={activeSession?.status}
        />
      )}
    </div>
  );
}
