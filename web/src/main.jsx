import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/app.css';

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    console.log('[SW] Registered:', reg.scope);
  }).catch((err) => {
    console.error('[SW] Registration failed:', err);
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
