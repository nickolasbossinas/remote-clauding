import { useState, useEffect, useRef, useCallback } from 'react';

// Post-process message history to mark questions/permissions as resolved
// based on subsequent question_answered / permission_resolved events
function reconcileHistory(messages) {
  const result = [];
  for (const m of messages) {
    result.push(m);
  }
  // Walk forward: when we see a resolution event, mark the matching request
  for (let i = 0; i < result.length; i++) {
    if (result[i].type === 'question_answered') {
      // Mark the most recent preceding unanswered ask_question
      for (let j = i - 1; j >= 0; j--) {
        if ((result[j].type === 'ask_question' ||
             (result[j].type === 'tool_use_start' && result[j].toolName === 'AskUserQuestion'))
            && !result[j].answered) {
          result[j] = { ...result[j], answered: true };
          break;
        }
      }
    } else if (result[i].type === 'permission_resolved') {
      // Mark matching permission_request by permissionId
      for (let j = i - 1; j >= 0; j--) {
        if (result[j].type === 'permission_request' &&
            result[j].permissionId === result[i].permissionId &&
            !result[j].resolved) {
          result[j] = { ...result[j], resolved: true, action: result[i].action };
          break;
        }
      }
    }
  }
  return result;
}

export function useRelay(sessionToken) {
  const token = sessionToken || localStorage.getItem('auth_token') || 'dev-token-change-me';
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [autoAccept, setAutoAccept] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);

  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    return `${protocol}//${host}/ws/client?token=${encodeURIComponent(token)}`;
  }, [token]);

  const connect = useCallback(() => {
    // Close existing connection (e.g. token changed, need new URL)
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      // Reset stale state for fresh connection
      setSessions([]);
      setMessages([]);
      setActiveSessionId(null);
    }

    const url = getWsUrl();
    console.log('[WS] Connecting...');
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WS] Connected');
      setConnected(true);
      reconnectDelay.current = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch {
        console.error('[WS] Invalid message');
      }
    };

    ws.onclose = () => {
      // Only handle if this is still the active connection
      if (wsRef.current !== ws) return;
      console.log('[WS] Disconnected');
      setConnected(false);
      wsRef.current = null;

      // Auto-reconnect
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
        connect();
      }, reconnectDelay.current);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    wsRef.current = ws;
  }, [getWsUrl]);

  const handleMessage = useCallback((msg) => {
    switch (msg.type) {
      case 'sessions_updated':
        setSessions(msg.sessions || []);
        break;

      case 'auto_subscribed':
        setActiveSessionId(msg.sessionId);
        if (msg.autoAccept !== undefined) setAutoAccept(msg.autoAccept);
        break;

      case 'message_history':
        setMessages(reconcileHistory(msg.messages || []));
        break;

      case 'claude_output':
        if (msg.message?.type === 'question_answered') {
          // Mark the most recent ask_question message as answered
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if ((updated[i].type === 'ask_question' ||
                   (updated[i].type === 'tool_use_start' && updated[i].toolName === 'AskUserQuestion'))
                  && !updated[i].answered) {
                updated[i] = { ...updated[i], answered: true };
                break;
              }
            }
            return updated;
          });
        } else if (msg.message?.type === 'permission_resolved') {
          // Mark matching permission_request as resolved
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].type === 'permission_request' &&
                  updated[i].permissionId === msg.message.permissionId) {
                updated[i] = { ...updated[i], resolved: true, action: msg.message.action };
                break;
              }
            }
            return updated;
          });
        } else {
          setMessages((prev) => [...prev, msg.message]);
        }
        break;

      case 'session_status':
        setSessions((prev) =>
          prev.map((s) =>
            s.id === msg.sessionId ? { ...s, status: msg.status } : s
          )
        );
        break;

      case 'auto_accept_changed':
        setAutoAccept(msg.autoAccept);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === msg.sessionId ? { ...s, autoAccept: msg.autoAccept } : s
          )
        );
        break;

      case 'input_required':
        setSessions((prev) =>
          prev.map((s) =>
            s.id === msg.sessionId ? { ...s, status: 'input_required' } : s
          )
        );
        break;

      case 'session_closed':
        setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
        break;

      case 'active_check':
        // Server asking if PWA is active — respond immediately
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'active_response',
            checkId: msg.checkId,
            isActive: !document.hidden,
          }));
        }
        break;

      case 'error':
        console.error('[Relay] Error:', msg.error);
        break;
    }
  }, []);

  const subscribeSession = useCallback(
    (sessionId) => {
      setActiveSessionId(sessionId);
      setMessages([]);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'subscribe_session',
            sessionId,
            since: 0,
          })
        );
      }
    },
    []
  );

  const unsubscribeSession = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
      wsRef.current.send(
        JSON.stringify({
          type: 'unsubscribe_session',
        })
      );
    }
    setActiveSessionId(null);
    setMessages([]);
  }, [activeSessionId]);

  const sendMessage = useCallback(
    (content) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
        wsRef.current.send(
          JSON.stringify({
            type: 'user_message',
            sessionId: activeSessionId,
            content,
          })
        );
        // Immediately mark any pending ask_question as answered so overlay dismisses
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].type === 'ask_question' && !updated[i].answered) {
              updated[i] = { ...updated[i], answered: true };
              break;
            }
          }
          return updated;
        });
      }
    },
    [activeSessionId]
  );

  const stopExecution = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
      wsRef.current.send(
        JSON.stringify({
          type: 'stop_message',
          sessionId: activeSessionId,
        })
      );
    }
  }, [activeSessionId]);

  const sendPermissionResponse = useCallback(
    (permissionId, action) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
        wsRef.current.send(
          JSON.stringify({
            type: 'permission_response',
            sessionId: activeSessionId,
            permissionId,
            action,
          })
        );
      }
    },
    [activeSessionId]
  );

  const dismissQuestion = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
      wsRef.current.send(
        JSON.stringify({
          type: 'dismiss_question',
          sessionId: activeSessionId,
        })
      );
    }
  }, [activeSessionId]);

  const toggleAutoAccept = useCallback(
    (value) => {
      if (wsRef.current?.readyState === WebSocket.OPEN && activeSessionId) {
        wsRef.current.send(
          JSON.stringify({
            type: 'set_auto_accept',
            sessionId: activeSessionId,
            autoAccept: value,
          })
        );
      }
      setAutoAccept(value); // Optimistic update
    },
    [activeSessionId]
  );

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // Listen for service worker notification clicks
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type === 'notification-click' && event.data.sessionId) {
        subscribeSession(event.data.sessionId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', handler);
    };
  }, [subscribeSession]);

  return {
    connected,
    sessions,
    messages,
    activeSessionId,
    autoAccept,
    subscribeSession,
    unsubscribeSession,
    sendMessage,
    stopExecution,
    sendPermissionResponse,
    dismissQuestion,
    toggleAutoAccept,
  };
}
