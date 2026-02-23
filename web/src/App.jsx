import { useState, useEffect } from 'react';
import { useRelay } from './hooks/useRelay.js';
import { usePush } from './hooks/usePush.js';
import SessionList from './components/SessionList.jsx';
import SessionView from './components/SessionView.jsx';
import StatusBar from './components/StatusBar.jsx';
import QRScanner from './components/QRScanner.jsx';

const STANDALONE = window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

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

function InstallPage() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  return (
    <div className="app">
      <div className="install-page">
        <div className="install-icon">
          <img src="/icon-192.png" alt="Remote Clauding" width="80" height="80" />
        </div>
        <h1 className="install-title">Remote Clauding</h1>
        <p className="install-subtitle">Control Claude Code from your phone</p>

        <div className="install-steps">
          <h2>Install as App</h2>
          {isIOS ? (
            <ol>
              <li>Tap the <strong>Share</strong> button in Safari</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
              <li>Tap <strong>Add</strong> to confirm</li>
            </ol>
          ) : (
            <ol>
              <li>Tap the <strong>menu</strong> (three dots) in your browser</li>
              <li>Tap <strong>Install app</strong> or <strong>Add to Home Screen</strong></li>
              <li>Tap <strong>Install</strong> to confirm</li>
            </ol>
          )}
        </div>

        <p className="install-hint">Then open the app from your home screen.</p>
      </div>
    </div>
  );
}

function MainApp() {
  const [pairToken] = useState(getPairToken);
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

export default function App() {
  if (!STANDALONE) {
    return <InstallPage />;
  }
  return <MainApp />;
}
