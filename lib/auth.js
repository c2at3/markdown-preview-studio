const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('./db');

const SESSION_DAYS = 7;

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
  const pwHash = hashPassword(password);
  await db.run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)', [id, username, pwHash, role]);
  return id;
}

async function login(username, password) {
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const token = nanoid(48);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await db.run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, user.id, now.toISOString(), expires.toISOString()]);
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

async function logout(token) {
  await db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function validateSession(token) {
  if (!token) return null;
  const session = await db.get('SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?',
    [token, new Date().toISOString()]);
  if (!session) return null;
  return { id: session.user_id, username: session.username, role: session.role };
}

async function hasAnyUser() {
  const row = await db.get('SELECT COUNT(*) as c FROM users');
  return row && row.c > 0;
}

function authMiddleware(req, res, next) {
  if (!db.isSetupDone()) return res.status(503).json({ error: 'Setup required' });

  const publicPaths = ['/api/auth/login', '/api/auth/setup', '/api/auth/status',
    '/api/shared/', '/api/private/', '/api/private-edit/'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();

  const token = req.cookies?.session || req.headers['x-session-token'];
  validateSession(token).then(user => {
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, hashSimple, createUser, login, logout, validateSession, hasAnyUser, authMiddleware };
