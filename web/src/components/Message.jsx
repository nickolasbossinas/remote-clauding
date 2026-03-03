import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism/index.js';
import ToolCall from './ToolCall.jsx';

function TimelineItem({ dotClass, showLine, isCard, children }) {
  const dotOffset = isCard ? 11 : 6;
  const lineTop = 4 + dotOffset + 7; // padding + margin-top + dot height
  return (
    <div className="timeline-item">
      <div
        className={`timeline-dot ${dotClass}${isCard ? ' dot-offset-card' : ''}`}
        style={isCard ? { marginTop: 11 } : undefined}
      />
      <div
        className={`timeline-line${showLine ? ' visible' : ''}`}
        style={{ top: lineTop }}
      />
      <div className="timeline-content">
        {children}
      </div>
    </div>
  );
}

export default function Message({ message, showLine }) {
  const { type, role, content } = message;

  // User message — simple bordered box, no dot
  if (role === 'user') {
    return <div className="msg-user">{content}</div>;
  }

  // Questions, permissions, input_required — handled by overlay in SessionView
  if (type === 'ask_question' || type === 'permission_request' || type === 'input_required') {
    return null;
  }

  // Tool usage (merged with result by MessageList)
  if (type === 'tool_use_start') {
    const hasResult = message.result !== undefined;
    const dotClass = hasResult ? (message.isError ? 'dot-error' : 'dot-success') : 'dot-progress';
    return (
      <TimelineItem dotClass={dotClass} showLine={showLine} isCard>
        <ToolCall message={message} />
      </TimelineItem>
    );
  }

  // Error
  if (type === 'error') {
    return (
      <TimelineItem dotClass="dot-error" showLine={showLine}>
        <div className="msg-error">{content}</div>
      </TimelineItem>
    );
  }

  // Assistant message / delta
  if (type === 'assistant_message' || type === 'assistant_delta' || role === 'assistant') {
    const text = content || '';
    if (!text) return null;

    return (
      <TimelineItem dotClass="dot-success" showLine={showLine}>
        <div className="msg-assistant markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ node, inline, className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                if (!inline && match) {
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{
                        margin: '0.5em 0',
                        borderRadius: '6px',
                        fontSize: '13px',
                      }}
                      {...props}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  );
                }
                return (
                  <code className="inline-code" {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      </TimelineItem>
    );
  }

  // All other types (result, text, etc.) — skip silently
  return null;
}
