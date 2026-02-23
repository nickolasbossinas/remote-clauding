import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const STEP_ICONS = {
  pending: '\u25CB',   // ○
  running: '\u25E6',   // ◦ (will spin via CSS)
  done: '\u2713',      // ✓
  error: '\u2717',     // ✗
};

export default function Install({ data, onComplete }) {
  const [steps, setSteps] = useState([
    { id: 'check_node', label: 'Checking for Node.js...', status: 'pending', detail: '' },
    { id: 'download_node', label: 'Downloading Node.js', status: 'pending', detail: '', hidden: true },
    { id: 'install_npm', label: 'Installing Remote Clauding', status: 'pending', detail: '' },
    { id: 'setup', label: 'Installing VSCode extension', status: 'pending', detail: '', hidden: data.environments && !data.environments.includes('vscode') },
  ]);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [logs, setLogs] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);

  const updateStep = (id, updates) => {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...updates } : s))
    );
  };

  const addLog = (msg) => {
    setLogs((prev) => prev + msg + '\n');
  };

  useEffect(() => {
    if (running.current) return;
    running.current = true;

    const unlistenPromise = listen('install_progress', (event) => {
      const { step, status, message, percent } = event.payload;
      if (percent !== undefined) {
        setDownloadPercent(percent);
      }
      if (message) {
        addLog(message);
        updateStep(step, { detail: message });
      }
      if (status === 'done') {
        updateStep(step, { status: 'done' });
      } else if (status === 'error') {
        updateStep(step, { status: 'error' });
      }
    });

    runInstall();

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const runInstall = async () => {
    try {
      // Step 1: Check Node.js
      updateStep('check_node', { status: 'running' });
      const nodeResult = await invoke('check_node');
      addLog(`Node.js check: found=${nodeResult.found}, version=${nodeResult.version}`);

      if (nodeResult.found) {
        updateStep('check_node', {
          status: 'done',
          label: `Node.js ${nodeResult.version} found`,
          detail: nodeResult.portable ? '(portable)' : '(system)',
        });
      } else {
        updateStep('check_node', { status: 'done', label: 'Node.js not found', detail: '' });

        // Step 2: Download portable Node.js
        updateStep('download_node', { status: 'running', hidden: false });
        await invoke('download_portable_node');
        updateStep('download_node', { status: 'done' });
      }

      // Step 3: Install npm package
      updateStep('install_npm', { status: 'running' });
      const installResult = await invoke('install_npm_package');
      addLog(installResult);
      updateStep('install_npm', { status: 'done' });

      // Step 4: VSCode extension (if selected)
      if (data.environments && data.environments.includes('vscode')) {
        updateStep('setup', { status: 'running', hidden: false });
        try {
          const setupResult = await invoke('run_setup');
          addLog(setupResult);
          updateStep('setup', { status: 'done' });
        } catch (err) {
          addLog(`VSCode setup warning: ${err}`);
          updateStep('setup', { status: 'error', detail: 'VSCode not found or extension install failed' });
          // Non-fatal — continue
        }
      }

      // Mark installed
      await invoke('mark_installed');
      addLog('Installation complete!');

      // Small delay before enabling completion
      setTimeout(() => onComplete(), 500);
    } catch (err) {
      const errStr = String(err);
      addLog(`Error: ${errStr}`);
      setError(errStr);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', marginBottom: 16 }}>Installing</h2>

      <ul className="install-steps">
        {steps.filter((s) => !s.hidden).map((step) => (
          <li key={step.id} className="install-step">
            <span className={`step-icon ${step.status}`}>
              {STEP_ICONS[step.status]}
            </span>
            <div className="step-label">
              <div>{step.label}</div>
              {step.detail && <div className="step-detail">{step.detail}</div>}
              {step.id === 'download_node' && step.status === 'running' && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${downloadPercent}%` }} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {error && <div className="error" style={{ marginTop: 16 }}>{error}</div>}

      <div className="log-toggle" onClick={() => setShowLog(!showLog)}>
        {showLog ? 'Hide log' : 'Show log'}
      </div>
      {showLog && <div className="log-area">{logs}</div>}
    </div>
  );
}
