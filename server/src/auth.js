const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token-change-me';

export function validateToken(token) {
  return token === AUTH_TOKEN;
}

export function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
