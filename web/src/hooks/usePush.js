import { useState, useEffect } from 'react';

const AUTH_TOKEN = localStorage.getItem('auth_token') || 'dev-token-change-me';

export function usePush() {
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);

  useEffect(() => {
    const supported =
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
    setPushSupported(supported);

    if (supported && Notification.permission === 'granted') {
      setPushEnabled(true);
    }
  }, []);

  async function enablePush() {
    if (!pushSupported) return false;

    try {
      // Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        return false;
      }

      // Get VAPID public key from server
      const resp = await fetch('/api/push/vapid-key');
      if (!resp.ok) {
        console.error('[Push] VAPID key not available');
        return false;
      }
      const { vapidPublicKey } = await resp.json();

      // Subscribe to push
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      // Send subscription to server
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify(subscription),
      });

      setPushEnabled(true);
      return true;
    } catch (err) {
      console.error('[Push] Enable failed:', err);
      return false;
    }
  }

  return { pushEnabled, pushSupported, enablePush };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
