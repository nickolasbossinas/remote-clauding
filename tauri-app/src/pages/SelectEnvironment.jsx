import { useState } from 'react';

const ENVIRONMENTS = [
  { id: 'vscode', name: 'VSCode', available: true },
  { id: 'cli', name: 'CLI', available: false, badge: 'Coming soon' },
  { id: 'intellij', name: 'IntelliJ', available: false, badge: 'Coming soon' },
];

export default function SelectEnvironment({ data, onNext }) {
  const [selected, setSelected] = useState(data.environments);

  const toggle = (id) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]
    );
  };

  return (
    <div>
      <h2 style={{ fontSize: '1.1rem', marginBottom: 16 }}>Select Environment</h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 20 }}>
        Choose where you want to use Remote Clauding.
      </p>

      {ENVIRONMENTS.map((env) => (
        <div className="checkbox-group" key={env.id}>
          <label className={`checkbox-label ${!env.available ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={selected.includes(env.id)}
              disabled={!env.available}
              onChange={() => env.available && toggle(env.id)}
            />
            <span className="env-name">{env.name}</span>
            {env.badge && <span className="env-badge">{env.badge}</span>}
          </label>
        </div>
      ))}

      <button
        className="btn btn-primary"
        style={{ marginTop: 24 }}
        disabled={selected.length === 0}
        onClick={() => onNext({ ...data, environments: selected })}
      >
        Next
      </button>
    </div>
  );
}
