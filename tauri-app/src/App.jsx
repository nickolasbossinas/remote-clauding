import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Welcome from './pages/Welcome.jsx';
import SelectEnvironment from './pages/SelectEnvironment.jsx';
import Register from './pages/Register.jsx';
import Install from './pages/Install.jsx';
import Complete from './pages/Complete.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

export default function App() {
  const [mode, setMode] = useState(null); // 'installer' | 'app'
  const [installerStep, setInstallerStep] = useState(0);
  const [config, setConfig] = useState(null);
  const [installerData, setInstallerData] = useState({
    environments: ['vscode'],
    email: '',
  });

  useEffect(() => {
    Promise.all([
      invoke('check_install_state'),
      invoke('read_config'),
    ]).then(([state, cfg]) => {
      setMode(state);
      setConfig(cfg);
    });
  }, []);

  if (mode === null) {
    return <div className="loading">Loading...</div>;
  }

  if (mode === 'installer') {
    // Step 0 = Welcome, steps 1-4 = setup flow
    const setupStep = installerStep - 1;
    const stepDots = [0, 1, 2, 3].map((i) => (
      <div
        key={i}
        className={`step-dot ${i === setupStep ? 'active' : ''} ${i < setupStep ? 'done' : ''}`}
      />
    ));

    if (installerStep === 0) {
      return (
        <div className="app">
          <div className="logo">
            <h1>Remote Clauding</h1>
          </div>
          <Welcome onStart={() => setInstallerStep(1)} />
        </div>
      );
    }

    const pages = [
      <SelectEnvironment
        key="env"
        data={installerData}
        onNext={(data) => { setInstallerData(data); setInstallerStep(2); }}
      />,
      <Register
        key="reg"
        data={installerData}
        onNext={(data) => { setInstallerData(data); setInstallerStep(3); }}
        onSkip={() => setInstallerStep(3)}
      />,
      <Install
        key="inst"
        data={installerData}
        onComplete={() => setInstallerStep(4)}
      />,
      <Complete
        key="done"
        onFinish={() => {
          invoke('read_config').then(setConfig);
          setMode('app');
        }}
      />,
    ];

    const subtitles = ['Environment', 'Account', 'Installing...', 'Complete'];

    return (
      <div className="app">
        <div className="logo">
          <h1>Remote Clauding</h1>
          <div className="subtitle">{subtitles[setupStep]}</div>
        </div>
        <div className="steps">{stepDots}</div>
        {pages[setupStep]}
      </div>
    );
  }

  // App mode
  if (!config?.auth_token) {
    return (
      <div className="app">
        <div className="logo">
          <h1>Remote Clauding</h1>
          <div className="subtitle">Sign in to continue</div>
        </div>
        <Login onLogin={(cfg) => setConfig(cfg)} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="logo">
        <h1>Remote Clauding</h1>
      </div>
      <Dashboard config={config} onLogout={() => setConfig({})} />
    </div>
  );
}
