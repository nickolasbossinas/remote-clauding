import { config } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname2, '..', '..', '.env') });

import {
  initDb, createUser, getUserByEmail, getUserByToken, getUserById,
  getAllUsers, updateUserStatus,
  setVerificationCode, verifyEmail,
} from './db.js';
import { authMiddleware, validateToken, REQUIRE_EMAIL_VERIFICATION, REQUIRE_MODERATION } from './auth.js';
import { getAllSessions } from './sessions.js';
import { initPush, addSubscription, getVapidPublicKey } from './push.js';
import { initEmail, sendVerificationCode } from './email.js';
import { setupWebSocket } from './relay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

app.use(express.json());

// Serve PWA static files
const webDistPath = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(webDistPath));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// --- Auth helpers ---

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendCodeToUser(userId, email) {
  const code = generateVerificationCode();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  setVerificationCode(userId, code, expires);
  await sendVerificationCode(email, code);
}

// --- Auth routes ---

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = getUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const authToken = uuidv4();
    const status = REQUIRE_MODERATION ? 'pending' : 'approved';
    const emailVerified = REQUIRE_EMAIL_VERIFICATION ? 0 : 1;

    const user = createUser(email, passwordHash, authToken, { status, emailVerified });

    if (REQUIRE_EMAIL_VERIFICATION) {
      await sendCodeToUser(user.id, email);
    }

    // Build response message
    const steps = [];
    if (REQUIRE_EMAIL_VERIFICATION) steps.push('verify your email');
    if (REQUIRE_MODERATION) steps.push('wait for admin approval');
    const message = steps.length > 0
      ? `Registration successful. Please ${steps.join(' and ')}.`
      : 'Registration successful.';

    const response = { message, auth_token: user.auth_token };
    res.json(response);
  } catch (err) {
    console.error('[Auth] Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/verify-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.email_verified) {
    return res.status(400).json({ error: 'Email already verified' });
  }
  if (!user.verification_code || user.verification_code !== code) {
    return res.status(400).json({ error: 'Invalid verification code' });
  }
  if (new Date(user.verification_code_expires) < new Date()) {
    return res.status(400).json({ error: 'Verification code expired' });
  }

  verifyEmail(user.id);

  const message = (!REQUIRE_MODERATION || user.status === 'approved')
    ? 'Email verified.'
    : 'Email verified. Pending admin approval.';
  res.json({ message, auth_token: user.auth_token });
});

app.post('/api/auth/resend-code', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.email_verified) {
    return res.status(400).json({ error: 'Email already verified' });
  }

  try {
    await sendCodeToUser(user.id, email);
    res.json({ message: 'Verification code sent' });
  } catch (err) {
    console.error('[Auth] Resend code error:', err.message);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      return res.status(403).json({ error: 'Email not verified' });
    }
    if (REQUIRE_MODERATION && user.status === 'pending') {
      return res.status(403).json({ error: 'Account pending admin approval' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'Account has been rejected' });
    }
    res.json({ auth_token: user.auth_token });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// --- Account status (token lookup without approval check) ---

app.get('/api/auth/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  res.json({
    email: user.email,
    status: user.status,
    email_verified: !!user.email_verified,
  });
});

// --- Push routes ---

// Get VAPID public key for push subscription
app.get('/api/push/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) {
    return res.status(503).json({ error: 'Push not configured' });
  }
  res.json({ vapidPublicKey: key });
});

// Register push subscription (requires auth)
app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  addSubscription(req.user.id, subscription);
  res.json({ success: true });
});

// --- Admin routes (superuser only) ---

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = validateToken(token);
  if (!user?.isSuperUser) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.user = user;
  next();
}

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json({ users: getAllUsers() });
});

app.post('/api/admin/users/:id/approve', adminMiddleware, (req, res) => {
  updateUserStatus(Number(req.params.id), 'approved');
  res.json({ success: true });
});

app.post('/api/admin/users/:id/reject', adminMiddleware, (req, res) => {
  updateUserStatus(Number(req.params.id), 'rejected');
  res.json({ success: true });
});

// --- Session routes ---

// List active sessions (filtered by user)
app.get('/api/sessions', authMiddleware, (req, res) => {
  res.json({ sessions: getAllSessions(req.user.id) });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.sendFile(path.join(webDistPath, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Initialize: DB → Email → Push → WebSocket
initDb();
initEmail();
initPush();
setupWebSocket(server);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Relay server running on port ${PORT}`);
  console.log(`[Server] Email verification: ${REQUIRE_EMAIL_VERIFICATION ? 'ON' : 'OFF'}`);
  console.log(`[Server] Moderation: ${REQUIRE_MODERATION ? 'ON' : 'OFF'}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
});
