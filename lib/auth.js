const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('./db');

const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || '7');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  return test === hash;
}

function hashSimple(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

async function createUser(username, password, role = 'admin') {
  const id = nanoid(12);
  await db.run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
    [id, username, hashPassword(password), role]);
  return id;
}

async function ensureAdmin() {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return;
  const existing = await db.get('SELECT id FROM users WHERE username = ?', [user]);
  if (existing) return;
  await createUser(user, pass, 'admin');
  console.log(`Admin user "${user}" created`);
}

async function login(username, password) {
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const token = nanoid(48);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    [token, user.id, expires.toISOString()]);
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

async function logout(token) {
  await db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function validateSession(token) {
  if (!token) return null;
  const row = await db.get(
    'SELECT s.user_id, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > NOW()',
    [token]);
  return row || null;
}

async function hasAnyUser() {
  const row = await db.get('SELECT COUNT(*)::int as c FROM users');
  return row && row.c > 0;
}

async function cleanExpiredSessions() {
  await db.run('DELETE FROM sessions WHERE expires_at < NOW()');
}

const API_KEY_PREFIX = 'mdpk_';

async function createApiKey(name) {
  const id = nanoid(12);
  const secret = crypto.randomBytes(24).toString('base64url');
  const rawKey = API_KEY_PREFIX + secret;
  const keyHash = hashSimple(rawKey);
  const keyPrefix = rawKey.slice(0, API_KEY_PREFIX.length + 6);
  await db.run('INSERT INTO api_keys (id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)',
    [id, name || 'API Key', keyHash, keyPrefix]);
  return { id, name: name || 'API Key', key_prefix: keyPrefix, raw_key: rawKey };
}

async function listApiKeys() {
  return db.query('SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC');
}

async function revokeApiKey(id) {
  const result = await db.run('DELETE FROM api_keys WHERE id = ?', [id]);
  return result.changes > 0;
}

async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX)) return null;
  const row = await db.get('SELECT id, name FROM api_keys WHERE key_hash = ?', [hashSimple(rawKey)]);
  if (!row) return null;
  await db.run('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]);
  return row;
}

module.exports = { hashPassword, verifyPassword, hashSimple, createUser, ensureAdmin, login, logout, validateSession, hasAnyUser, cleanExpiredSessions, createApiKey, listApiKeys, revokeApiKey, validateApiKey };
