import { useState } from 'react';

export default function Complete({ onFinish }) {
  const [launchApp, setLaunchApp] = useState(true);

  return (
    <div>
      <div className="complete-icon">{'\u2713'}</div>
      <div className="complete-title">Installation Complete!</div>
      <div className="complete-msg">
        Remote Clauding has been installed successfully.
        Log in to start monitoring your Claude Code sessions.
      </div>

      <label className="checkbox-label" style={{ marginBottom: 24 }}>
        <input
          type="checkbox"
          checked={launchApp}
          onChange={(e) => setLaunchApp(e.target.checked)}
        />
        <span className="env-name">Launch Remote Clauding</span>
      </label>

      <button className="btn btn-primary" onClick={() => onFinish(launchApp)}>
        Finish
      </button>
    </div>
  );
}
