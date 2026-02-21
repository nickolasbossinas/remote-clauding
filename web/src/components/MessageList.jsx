import React, { useEffect, useRef, useMemo } from 'react';
import Message from './Message.jsx';

// Types to skip rendering entirely
const SKIP_TYPES = new Set([
  'tool_use_delta', 'text_block_start',
  'content_block_stop', 'message_start', 'message_stop',
  'system', 'rate_limit_event',
]);

export default function MessageList({ messages, onSendMessage }) {
  const bottomRef = useRef(null);
  const containerRef = useRef(null);

  // Preprocess: merge tool_result into matching tool_use_start, filter noise
  const processed = useMemo(() => {
    const result = [];
    const toolMap = new Map(); // toolId -> index in result array

    for (const msg of messages) {
      if (SKIP_TYPES.has(msg.type)) continue;

      if (msg.type === 'tool_use_start') {
        const enriched = { ...msg };
        result.push(enriched);
        if (msg.toolId) toolMap.set(msg.toolId, result.length - 1);
      } else if (msg.type === 'tool_use_update') {
        // AskUserQuestion may arrive as tool_use_update with full input
        if (msg.toolName === 'AskUserQuestion' && msg.toolInput?.questions) {
          const idx = msg.toolId ? toolMap.get(msg.toolId) : undefined;
          if (idx !== undefined) {
            // Replace the generic tool card with the question
            result[idx] = {
              type: 'ask_question',
              toolId: msg.toolId,
              questions: msg.toolInput.questions,
            };
          } else {
            // No existing card — add as new question
            result.push({
              type: 'ask_question',
              toolId: msg.toolId,
              questions: msg.toolInput.questions,
            });
          }
        }
        // Other tool_use_update types are skipped (noise)
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
        <Message key={idx} message={msg} onSendMessage={onSendMessage} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
