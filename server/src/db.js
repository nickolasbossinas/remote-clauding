import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

export function initDb() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(path.join(dataDir, 'remote-clauding.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      auth_token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      verification_code_expires TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE NOT NULL,
      subscription_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  console.log('[DB] SQLite initialized');
  return db;
}

// --- User queries ---

export function createUser(email, passwordHash, authToken, { status = 'pending', emailVerified = 0 } = {}) {
  const stmt = db.prepare(
    'INSERT INTO users (email, password_hash, auth_token, status, email_verified) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(email, passwordHash, authToken, status, emailVerified ? 1 : 0);
  return { id: result.lastInsertRowid, email, auth_token: authToken, status, email_verified: emailVerified };
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

export function getUserByToken(authToken) {
  return db.prepare('SELECT * FROM users WHERE auth_token = ?').get(authToken) || null;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function getAllUsers() {
  return db.prepare('SELECT id, email, status, email_verified, created_at FROM users').all();
}

export function updateUserStatus(id, status) {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

// --- Email verification queries ---

export function setVerificationCode(userId, code, expiresAt) {
  db.prepare(
    'UPDATE users SET verification_code = ?, verification_code_expires = ? WHERE id = ?'
  ).run(code, expiresAt, userId);
}

export function verifyEmail(userId) {
  db.prepare(
    'UPDATE users SET email_verified = 1, verification_code = NULL, verification_code_expires = NULL WHERE id = ?'
  ).run(userId);
}

// --- Push subscription queries ---

export function upsertPushSubscription(userId, subscription) {
  const stmt = db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription_json)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      subscription_json = excluded.subscription_json
  `);
  stmt.run(userId, subscription.endpoint, JSON.stringify(subscription));
}

export function getPushSubscriptionsByUserId(userId) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

export function getAllPushSubscriptions() {
  return db.prepare('SELECT * FROM push_subscriptions').all();
}

export function deletePushSubscriptionByEndpoint(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}
