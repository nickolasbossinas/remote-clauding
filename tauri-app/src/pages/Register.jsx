import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function Register({ data, onNext, onSkip }) {
  const [view, setView] = useState('register'); // 'register' | 'verify' | 'pending'
  const [email, setEmail] = useState(data.email || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }

    setLoading(true);
    try {
      const result = await invoke('register', { email, password });
      const msg = (result.message || '').toLowerCase();

      if (result.message) {
        setMessage(result.message);
      }

      if (msg.includes('verify')) {
        setView('verify');
      } else if (msg.includes('approval') || msg.includes('admin')) {
        setView('pending');
      } else {
        // No verification or moderation needed — proceed directly
        onNext({ ...data, email });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await invoke('verify_email', { email, code: code.trim() });
      const msg = (result.message || '').toLowerCase();

      if (msg.includes('pending') || msg.includes('approval')) {
        setView('pending');
      } else {
        // Verified and approved — proceed directly
        onNext({ ...data, email });
      }
    } catch (err) {
      const errStr = String(err).toLowerCase();
      if (errStr.includes('already verified') || errStr.includes('already been verified')) {
        setView('pending');
      } else {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  };

  if (view === 'pending') {
    return (
      <div>
        <h2 style={{ fontSize: '1.1rem', marginBottom: 16 }}>Registration Pending</h2>
        <div className="success">
          Your account has been created. An administrator will review and approve your registration.
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 24, lineHeight: 1.6 }}>
          You can continue with the installation now. You will be able to log in once your account is approved.
        </p>
        <button className="btn btn-primary" onClick={() => onNext({ ...data, email })}>
          Continue
        </button>
      </div>
    );
  }

  if (view === 'verify') {
    return (
      <div>
        <h2 style={{ fontSize: '1.1rem', marginBottom: 16 }}>Verify Email</h2>
        {message && <div className="success">{message}</div>}
        {error && <div className="error">{error}</div>}
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 20 }}>
          We sent a 6-digit code to <strong>{email}</strong>. Enter it below.
        </p>
        <form onSubmit={handleVerify}>
          <div className="form-group">
            <label>Verification Code</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              maxLength={6}
              autoFocus
            />
          </div>
          <button className="btn btn-primary" disabled={loading || code.length < 6}>
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', marginBottom: 16 }}>Create Account</h2>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      <form onSubmit={handleRegister}>
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
        <div className="form-group">
          <label>Confirm Password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
          />
        </div>
        <button className="btn btn-primary" disabled={loading}>
          {loading ? 'Creating account...' : 'Create Account'}
        </button>
      </form>
      <p className="text-center" style={{ marginTop: 16 }}>
        <span className="link" onClick={onSkip}>Already have an account? Skip</span>
      </p>
    </div>
  );
}
