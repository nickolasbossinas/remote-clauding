import React, { useEffect, useRef, useMemo, useState } from 'react';
import Message from './Message.jsx';

// Types to skip rendering entirely
const SKIP_TYPES = new Set([
  'tool_use_delta', 'text_block_start',
  'content_block_stop', 'message_start', 'message_stop',
  'system', 'rate_limit_event',
]);

// A message that gets a timeline dot (not user messages)
function isTimelineType(msg) {
  if (!msg) return false;
  if (msg.role === 'user') return false;
  return true;
}

const THINKING_LABELS = [
  'Thinking', 'Concocting', 'Clauding', 'Finagling',
  'Envisioning', 'Pondering', 'Musing', 'Ruminating',
  'Accomplishing', 'Baking', 'Brewing', 'Calculating',
  'Cerebrating', 'Cogitating', 'Computing', 'Crafting',
];
const SPARKLE_FRAMES = ['\u00B7', '\u2722', '*', '\u2736', '\u273B', '\u273D',
                        '\u273B', '\u2736', '*', '\u2722', '\u00B7'];

function ThinkingIndicator() {
  const [sparkleIdx, setSparkleIdx] = useState(0);
  const [textIdx, setTextIdx] = useState(() => Math.floor(Math.random() * THINKING_LABELS.length));

  useEffect(() => {
    const sparkle = setInterval(() => {
      setSparkleIdx(i => (i + 1) % SPARKLE_FRAMES.length);
    }, 120);
    const text = setInterval(() => {
      setTextIdx(i => (i + 1) % THINKING_LABELS.length);
    }, 3000);
    return () => { clearInterval(sparkle); clearInterval(text); };
  }, []);

  return (
    <div className="thinking-indicator">
      <span className="thinking-icon">{SPARKLE_FRAMES[sparkleIdx]}</span>
      <span className="thinking-text">{THINKING_LABELS[textIdx]}...</span>
    </div>
  );
}

export default function MessageList({ messages, status }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);

  // Preprocess: merge tool_result into matching tool_use_start, filter noise
  const processed = useMemo(() => {
    const result = [];
    const toolMap = new Map(); // toolId -> index in result array

    for (const msg of messages) {
      if (SKIP_TYPES.has(msg.type)) continue;

      if (msg.type === 'tool_use_start') {
        // AskUserQuestion is suppressed by agent; skip if it leaks through
        if (msg.toolName === 'AskUserQuestion') continue;
        const enriched = { ...msg };
        result.push(enriched);
        if (msg.toolId) toolMap.set(msg.toolId, result.length - 1);
      } else if (msg.type === 'tool_use_update') {
        // Skip all tool_use_updates (AskUserQuestion suppressed, others are noise)
      } else if (msg.type === 'tool_result' && msg.toolId) {
        const idx = toolMap.get(msg.toolId);
        if (idx !== undefined) {
          // Merge result into the tool card
          result[idx] = {
            ...result[idx],
            result: msg.content,
            isError: msg.isError,
          };
        }
        // Don't add tool_result as a separate message
      } else if (msg.type === 'result') {
        // Skip result messages (they duplicate assistant text)
        continue;
      } else {
        result.push(msg);
      }
    }

    // Compute showLine: true if next message is also a timeline type
    // Lines only connect between consecutive timeline items — never on the last one
    for (let i = 0; i < result.length; i++) {
      if (isTimelineType(result[i])) {
        result[i].showLine = isTimelineType(result[i + 1]);
      }
    }

    return result;
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [processed]);

  if (processed.length === 0) {
    return (
      <div className="message-list" ref={containerRef}>
        <div className="empty-state">
          <p className="empty-subtitle">Waiting for messages...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef}>
      {processed.map((msg, idx) => (
        <Message key={idx} message={msg} showLine={msg.showLine} />
      ))}
      {status === 'processing' && <ThinkingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
