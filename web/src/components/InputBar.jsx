import React, { useState, useRef } from 'react';

export default function InputBar({ onSend, disabled }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    inputRef.current?.focus();
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Disconnected...' : 'Message Claude...'}
        disabled={disabled}
        rows={1}
      />
      <button
        className="send-btn"
        onClick={handleSend}
        disabled={disabled || !text.trim()}
      >
        Send
      </button>
    </div>
  );
}
