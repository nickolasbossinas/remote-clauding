import React, { useState } from 'react';

export default function AskQuestion({ message, onAnswer, answered: externalAnswered }) {
  const { questions } = message;
  const [localAnswered, setLocalAnswered] = useState(false);
  const answered = externalAnswered || localAnswered;
  const [selectedMap, setSelectedMap] = useState({}); // questionIdx -> Set of labels
  const [otherText, setOtherText] = useState({});     // questionIdx -> string
  const [showOther, setShowOther] = useState({});      // questionIdx -> boolean

  if (!questions || questions.length === 0) return null;

  function handleSelect(qIdx, label, isMulti) {
    if (answered) return;

    if (isMulti) {
      setSelectedMap(prev => {
        const set = new Set(prev[qIdx] || []);
        if (set.has(label)) set.delete(label); else set.add(label);
        return { ...prev, [qIdx]: set };
      });
    } else {
      // Single select — answer immediately
      setLocalAnswered(true);
      if (onAnswer) onAnswer(label);
    }
  }

  function handleMultiSubmit(qIdx) {
    const selected = selectedMap[qIdx];
    if (!selected || selected.size === 0) return;
    setLocalAnswered(true);
    if (onAnswer) onAnswer(Array.from(selected).join(', '));
  }

  function handleOtherSubmit(qIdx) {
    const text = (otherText[qIdx] || '').trim();
    if (!text) return;
    setLocalAnswered(true);
    if (onAnswer) onAnswer(text);
  }

  return (
    <div className={`question-card${answered ? ' question-answered' : ''}`}>
      {questions.map((q, qIdx) => (
        <div key={qIdx} className="question-item">
          {q.header && <div className="question-header">{q.header}</div>}
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {(q.options || []).map((opt, oIdx) => (
              <button
                key={oIdx}
                className={`question-option${
                  selectedMap[qIdx]?.has(opt.label) ? ' selected' : ''
                }`}
                onClick={() => handleSelect(qIdx, opt.label, q.multiSelect)}
                disabled={answered}
              >
                <span className="question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="question-option-desc">{opt.description}</span>
                )}
              </button>
            ))}
            <button
              className="question-option"
              onClick={() => setShowOther(prev => ({ ...prev, [qIdx]: !prev[qIdx] }))}
              disabled={answered}
            >
              <span className="question-option-label">Other</span>
              <span className="question-option-desc">Type a custom response</span>
            </button>
          </div>

          {showOther[qIdx] && !answered && (
            <div className="question-other-row">
              <input
                className="question-other-input"
                placeholder="Type your response..."
                value={otherText[qIdx] || ''}
                onChange={e => setOtherText(prev => ({ ...prev, [qIdx]: e.target.value }))}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleOtherSubmit(qIdx);
                }}
                autoFocus
              />
              <button className="question-other-send" onClick={() => handleOtherSubmit(qIdx)}>
                Send
              </button>
            </div>
          )}

          {q.multiSelect && !answered && (
            <button
              className="question-multi-submit"
              onClick={() => handleMultiSubmit(qIdx)}
              disabled={!selectedMap[qIdx]?.size}
            >
              Submit
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
