import webPush from 'web-push';
import {
  upsertPushSubscription,
  getPushSubscriptionsByUserId,
  getAllPushSubscriptions,
  deletePushSubscriptionByEndpoint,
} from './db.js';

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

export function addSubscription(userId, subscription) {
  upsertPushSubscription(userId, subscription);
  console.log(`[Push] Subscription added for user ${userId}`);
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function sendNotification(userId, title, body, data = {}) {
  const payload = JSON.stringify({ title, body, data });

  // Get subscriptions: user-scoped or all (for superuser id=0)
  const rows = (userId && userId !== 0)
    ? getPushSubscriptionsByUserId(userId)
    : getAllPushSubscriptions();

  const staleEndpoints = [];
  for (const row of rows) {
    try {
      await webPush.sendNotification(JSON.parse(row.subscription_json), payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        staleEndpoints.push(row.endpoint);
      } else {
        console.error('[Push] Send error:', err.message);
      }
    }
  }

  for (const endpoint of staleEndpoints) {
    deletePushSubscriptionByEndpoint(endpoint);
  }
}
