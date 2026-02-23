import { getUserByToken } from './db.js';

const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-me';

export const REQUIRE_EMAIL_VERIFICATION = process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';
export const REQUIRE_MODERATION = process.env.REQUIRE_MODERATION !== 'false';

/**
 * Validate a token and return a user-like object or null.
 * - Global AUTH_TOKEN maps to superuser { id: 0, isSuperUser: true }
 * - Per-user tokens: must pass email verification and moderation checks
 */
export function validateToken(token) {
  if (!token) return null;
  if (token === AUTH_TOKEN) {
    return { id: 0, email: 'superuser', isSuperUser: true };
  }
  const user = getUserByToken(token);
  if (!user) return null;
  if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) return null;
  if (REQUIRE_MODERATION && user.status !== 'approved') return null;
  if (!REQUIRE_MODERATION && user.status === 'rejected') return null;
  return user;
}

export function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = validateToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
}
