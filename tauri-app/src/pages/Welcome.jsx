export default function Welcome({ onStart }) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 40 }}>
      <div style={{ fontSize: '4rem', marginBottom: 16 }}>&#x2728;</div>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 600, marginBottom: 12 }}>
        Welcome to Remote Clauding
      </h2>
      <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 32, maxWidth: 340, margin: '0 auto 32px' }}>
        Monitor and interact with your Claude Code sessions from your phone, anywhere.
      </p>
      <button className="btn btn-primary" onClick={onStart}>
        Get Started
      </button>
    </div>
  );
}
