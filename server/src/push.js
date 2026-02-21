import webPush from 'web-push';

const subscriptions = new Set();

export function initPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    console.warn('[Push] VAPID keys not set. Push notifications disabled.');
    console.warn('[Push] Generate keys with: npx web-push generate-vapid-keys');
    return false;
  }

  webPush.setVapidDetails(
    'mailto:remote-clauding@example.com',
    publicKey,
    privateKey
  );

  console.log('[Push] Web Push initialized');
  return true;
}

export function addSubscription(subscription) {
  // Store as JSON string for Set deduplication
  const key = JSON.stringify(subscription);
  for (const existing of subscriptions) {
    if (existing === key) return;
  }
  subscriptions.add(key);
  console.log(`[Push] Subscription added. Total: ${subscriptions.size}`);
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function sendNotification(title, body, data = {}) {
  const payload = JSON.stringify({ title, body, data });

  const stale = [];
  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(JSON.parse(sub), payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid
        stale.push(sub);
      } else {
        console.error('[Push] Send error:', err.message);
      }
    }
  }

  // Clean up stale subscriptions
  for (const sub of stale) {
    subscriptions.delete(sub);
  }
}
