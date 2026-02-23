import React, { useState, useRef, useCallback } from 'react';

export default function InputBar({ onSend, onStop, disabled, status }) {
  const isProcessing = status === 'processing';
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  const autoResize = useCallback((el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  const handleChange = (e) => {
    setText(e.target.value);
    autoResize(e.target);
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="input-bar">
      <textarea
        ref={inputRef}
        className="input-field"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Disconnected...' : 'Message Claude...'}
        disabled={disabled}
        rows={1}
      />
      {isProcessing ? (
        <button
          className="send-btn stop-btn"
          onClick={onStop}
        />
      ) : (
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={disabled || !text.trim()}
        >
          <svg viewBox="0 0 24 24">
            <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z"/>
          </svg>
        </button>
      )}
    </div>
  );
}
