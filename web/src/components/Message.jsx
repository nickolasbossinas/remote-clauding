import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism/index.js';
import ToolCall from './ToolCall.jsx';
import AskQuestion from './AskQuestion.jsx';

export default function Message({ message, onSendMessage }) {
  const { type, role, content } = message;

  // User message
  if (role === 'user') {
    return (
      <div className="message message-user">
        <div className="message-label">You</div>
        <div className="message-content">{content}</div>
      </div>
    );
  }

  // Input required prompt
  if (type === 'input_required') {
    return (
      <div className="message message-input-required">
        <div className="message-label">Input Required</div>
        <div className="message-content">{content}</div>
      </div>
    );
  }

  // AskUserQuestion — interactive question with options
  if (type === 'ask_question') {
    return <AskQuestion message={message} onAnswer={onSendMessage} answered={message.answered} />;
  }

  // Tool usage (merged with result by MessageList)
  if (type === 'tool_use_start') {
    // AskUserQuestion arrives as tool_use_start with toolName check
    if (message.toolName === 'AskUserQuestion' && message.toolInput?.questions) {
      return <AskQuestion message={{ questions: message.toolInput.questions }} onAnswer={onSendMessage} answered={message.answered} />;
    }
    return <ToolCall message={message} />;
  }

  // Error
  if (type === 'error') {
    return (
      <div className="message message-error">
        <div className="message-label">Error</div>
        <div className="message-content">{content}</div>
      </div>
    );
  }

  // Assistant message / delta
  if (type === 'assistant_message' || type === 'assistant_delta' || role === 'assistant') {
    const text = content || '';
    if (!text) return null;

    return (
      <div className="message message-assistant">
        <div className="message-label">Claude</div>
        <div className="message-content markdown-body">
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
      </div>
    );
  }

  // All other types (result, text, etc.) — skip silently
  return null;
}
