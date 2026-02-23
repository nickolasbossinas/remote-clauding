import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [accountStatus, setAccountStatus] = useState(null); // 'pending' | 'rejected' | null
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setAccountStatus(null);

    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }

    setLoading(true);
    try {
      const result = await invoke('login', { email, password });

      if (result.auth_token) {
        // Auto-start agent after login
        try {
          await invoke('start_agent');
        } catch {
          // Agent start is best-effort
        }
        onLogin({ auth_token: result.auth_token, email });
      } else {
        setError('Login failed: no token received.');
      }
    } catch (err) {
      const errStr = String(err).toLowerCase();
      if (errStr.includes('pending')) {
        setAccountStatus('pending');
      } else if (errStr.includes('rejected')) {
        setAccountStatus('rejected');
      } else {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {accountStatus === 'pending' && (
        <div className="status-notice pending">
          <div className="status-notice-icon">&#x23F3;</div>
          <div className="status-notice-text">
            <strong>Account Pending Approval</strong>
            <p>Your account is waiting for admin approval. Please try again later.</p>
          </div>
        </div>
      )}
      {accountStatus === 'rejected' && (
        <div className="status-notice rejected">
          <div className="status-notice-icon">&#x26D4;</div>
          <div className="status-notice-text">
            <strong>Account Rejected</strong>
            <p>Your account has been rejected by an administrator.</p>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoFocus
          />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
        </div>
        <button className="btn btn-primary" disabled={loading}>
          {loading ? 'Logging in...' : 'Log In'}
        </button>
      </form>
      {accountStatus === 'pending' && (
        <p className="text-center" style={{ marginTop: 16 }}>
          <span className="link" onClick={handleSubmit}>Check again</span>
        </p>
      )}
    </div>
  );
}
