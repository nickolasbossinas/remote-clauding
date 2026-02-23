export default function Complete({ onFinish }) {
  return (
    <div>
      <div className="complete-icon">{'\u2713'}</div>
      <div className="complete-title">Installation Complete!</div>
      <div className="complete-msg">
        Remote Clauding has been installed successfully.
        Log in to start monitoring your Claude Code sessions.
      </div>

      <button className="btn btn-primary" onClick={() => onFinish()}>
        Finish
      </button>
    </div>
  );
}
