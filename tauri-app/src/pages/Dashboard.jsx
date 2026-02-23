import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

const STATUS_DISPLAY = {
  approved: { label: 'Approved', dot: 'green' },
  pending: { label: 'Pending Approval', dot: 'yellow' },
  rejected: { label: 'Rejected', dot: 'red' },
  error: { label: 'Unable to check', dot: 'red' },
};

export default function Dashboard({ config, onLogout }) {
  const [agentRunning, setAgentRunning] = useState(null);
  const [relayReachable, setRelayReachable] = useState(null);
  const [accountStatus, setAccountStatus] = useState(null); // 'approved' | 'pending' | 'rejected' | null
  const [actionLoading, setActionLoading] = useState('');
  const interval = useRef(null);

  const checkStatus = async () => {
    try {
      const [agent, relay] = await Promise.all([
        invoke('check_agent_health'),
        invoke('check_relay_health'),
      ]);
      setAgentRunning(agent.running);
      setRelayReachable(relay.running);
    } catch {
      // Ignore check errors
    }
  };

  const checkAccountStatus = async () => {
    try {
      const result = await invoke('check_account_status');
      setAccountStatus(result.status);
    } catch (err) {
      console.error('check_account_status failed:', err);
      setAccountStatus('error');
    }
  };

  useEffect(() => {
    checkStatus();
    checkAccountStatus();
    interval.current = setInterval(() => {
      checkStatus();
      if (accountStatus !== 'approved') checkAccountStatus();
    }, 5000);
    return () => clearInterval(interval.current);
  }, [accountStatus]);

  const handleStartAgent = async () => {
    setActionLoading('start');
    try {
      await invoke('start_agent');
      await new Promise((r) => setTimeout(r, 2500));
      await checkStatus();
    } catch {
      // Ignore
    }
    setActionLoading('');
  };

  const handleStopAgent = async () => {
    setActionLoading('stop');
    try {
      await invoke('stop_agent');
      await new Promise((r) => setTimeout(r, 1000));
      await checkStatus();
    } catch {
      // Ignore
    }
    setActionLoading('');
  };

  const handleLogout = async () => {
    setActionLoading('logout');
    try {
      await invoke('logout');
    } catch {
      // Ignore
    }
    setActionLoading('');
    onLogout();
  };

  const statusInfo = STATUS_DISPLAY[accountStatus] || { label: 'Checking...', dot: 'yellow' };

  return (
    <div>
      <div className="card">
        <div className="status-row">
          <span className="status-label">Account</span>
          <span className="status-value">{config.email || 'Unknown'}</span>
        </div>
        <div className="status-row">
          <span className="status-label">Status</span>
          <span className="status-value">
            <span className={`status-dot ${statusInfo.dot}`} />
            {statusInfo.label}
          </span>
        </div>
        <div className="status-row">
          <span className="status-label">Agent</span>
          <span className="status-value">
            <span className={`status-dot ${agentRunning === null ? 'yellow' : agentRunning ? 'green' : 'red'}`} />
            {agentRunning === null ? 'Checking...' : agentRunning ? 'Running' : 'Stopped'}
          </span>
        </div>
        <div className="status-row">
          <span className="status-label">Relay</span>
          <span className="status-value">
            <span className={`status-dot ${relayReachable === null ? 'yellow' : relayReachable ? 'green' : 'red'}`} />
            {relayReachable === null ? 'Checking...' : relayReachable ? 'Connected' : 'Unreachable'}
          </span>
        </div>
      </div>

      {accountStatus === 'pending' && (
        <div className="status-notice pending">
          <div className="status-notice-icon">&#x23F3;</div>
          <div className="status-notice-text">
            <strong>Account Pending Approval</strong>
            <p>You cannot connect your phone or use the relay until an administrator approves your account.</p>
          </div>
        </div>
      )}

      {accountStatus === 'rejected' && (
        <div className="status-notice rejected">
          <div className="status-notice-icon">&#x26D4;</div>
          <div className="status-notice-text">
            <strong>Account Rejected</strong>
            <p>Your account has been rejected. You cannot connect to the relay.</p>
          </div>
        </div>
      )}

      {agentRunning === false ? (
        <button
          className="btn btn-primary"
          onClick={handleStartAgent}
          disabled={actionLoading === 'start'}
        >
          {actionLoading === 'start' ? 'Starting...' : 'Start Agent'}
        </button>
      ) : agentRunning === true ? (
        <button
          className="btn btn-secondary"
          onClick={handleStopAgent}
          disabled={actionLoading === 'stop'}
        >
          {actionLoading === 'stop' ? 'Stopping...' : 'Stop Agent'}
        </button>
      ) : null}

      <button
        className="btn btn-danger"
        onClick={handleLogout}
        disabled={!!actionLoading}
      >
        {actionLoading === 'logout' ? 'Logging out...' : 'Log Out'}
      </button>
    </div>
  );
}
