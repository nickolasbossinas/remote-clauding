import React, { useState } from 'react';
import { useRelay } from './hooks/useRelay.js';
import { usePush } from './hooks/usePush.js';
import SessionList from './components/SessionList.jsx';
import SessionView from './components/SessionView.jsx';
import StatusBar from './components/StatusBar.jsx';

export default function App() {
  const relay = useRelay();
  const push = usePush();
  const [view, setView] = useState('list'); // 'list' or 'session'

  const openSession = (sessionId) => {
    relay.subscribeSession(sessionId);
    setView('session');
  };

  const goBack = () => {
    relay.unsubscribeSession();
    setView('list');
  };

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
        />
      )}
    </div>
  );
}
