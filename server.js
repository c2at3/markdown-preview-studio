const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { authRateLimiter } = require('./lib/ratelimit');

const app = express();
const PORT = process.env.PORT || 3456;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function hashSharePw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k && v) req.cookies[k] = v;
  });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

// ===== HEALTH =====
app.get('/health', async (req, res) => {
  try {
    await db.get('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// ===== AUTH ROUTES (public) =====
app.get('/api/auth/status', async (req, res) => {
  const hasUsers = await auth.hasAnyUser();
  const token = req.cookies.session || req.headers['x-session-token'];
  const user = await auth.validateSession(token);
  res.json({ setup_done: hasUsers, logged_in: !!user, user: user ? { username: user.username, role: user.role } : null });
});

app.post('/api/auth/setup', authRateLimiter, async (req, res) => {
  const hasUsers = await auth.hasAnyUser();
  if (hasUsers) return res.status(400).json({ error: 'Setup already completed' });
  const { username, password } = req.body;
  if (!username || username.length < 3) return res.status(400).json({ error: 'Username min 3 chars' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  try {
    await auth.createUser(username, password, 'admin');
    const session = await auth.login(username, password);
    log(`Setup completed. Admin user "${username}" created.`);
    res.json({ ok: true, token: session.token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  const { username, password } = req.body;
  const session = await auth.login(username, password);
  if (!session) { log(`Login failed for "${username}" from ${req.ip}`); return res.status(401).json({ error: 'Invalid credentials' }); }
  log(`Login: "${username}" from ${req.ip}`);
  res.json({ token: session.token, user: session.user });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = req.cookies.session || req.headers['x-session-token'];
  if (token) await auth.logout(token);
  res.json({ ok: true });
});

// ===== STATIC =====
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}, express.static(UPLOAD_DIR));

app.use(express.static(path.join(__dirname, 'public')));

// Redirect to setup/login
app.get('/', async (req, res, next) => {
  const hasUsers = await auth.hasAnyUser();
  if (!hasUsers) return res.redirect('/setup.html');
  const user = await auth.validateSession(req.cookies.session);
  if (!user) return res.redirect('/login.html');
  next();
});

app.get('/login.html', async (req, res, next) => {
  const hasUsers = await auth.hasAnyUser();
  if (!hasUsers) return res.redirect('/setup.html');
  const user = await auth.validateSession(req.cookies.session);
  if (user) return res.redirect('/');
  next();
});

app.get('/setup.html', async (req, res, next) => {
  const hasUsers = await auth.hasAnyUser();
  if (hasUsers) return res.redirect('/');
  next();
});

// ===== AUTH MIDDLEWARE =====
app.use('/api', async (req, res, next) => {
  const publicPrefixes = ['/auth/', '/shared/', '/private/', '/private-edit/'];
  const apiPath = req.path;
  if (publicPrefixes.some(p => apiPath.startsWith(p))) return next();
  const token = req.cookies.session || req.headers['x-session-token'];
  const user = await auth.validateSession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
});

// ===== FOLDERS =====
app.get('/api/folders', async (req, res) => {
  res.json(await db.query('SELECT * FROM folders ORDER BY sort_order'));
});

app.post('/api/folders', async (req, res) => {
  const id = nanoid(10);
  const { name, parent_id } = req.body;
  const pid = parent_id || null;
  const maxOrder = pid
    ? await db.get('SELECT MAX(sort_order) as m FROM folders WHERE parent_id = ?', [pid])
    : await db.get('SELECT MAX(sort_order) as m FROM folders WHERE parent_id IS NULL');
  await db.run('INSERT INTO folders (id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)',
    [id, name || 'New Folder', pid, (maxOrder?.m || 0) + 1]);
  res.status(201).json(await db.get('SELECT * FROM folders WHERE id = ?', [id]));
});

app.put('/api/folders/:id', async (req, res) => {
  const { name, parent_id, collapsed, sort_order, color } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (parent_id !== undefined) { sets.push('parent_id = ?'); vals.push(parent_id || null); }
  if (collapsed !== undefined) { sets.push('collapsed = ?'); vals.push(!!collapsed); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (color !== undefined) { sets.push('color = ?'); vals.push(color || null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  await db.run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, vals);
  res.json(await db.get('SELECT * FROM folders WHERE id = ?', [req.params.id]));
});

app.delete('/api/folders/:id', async (req, res) => {
  await db.run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [req.params.id]);
  const children = await db.query('SELECT id FROM folders WHERE parent_id = ?', [req.params.id]);
  for (const c of children) {
    await db.run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [c.id]);
    await db.run('DELETE FROM folders WHERE id = ?', [c.id]);
  }
  await db.run('DELETE FROM folders WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ===== FILES =====
app.get('/api/files', async (req, res) => {
  res.json(await db.query('SELECT id, name, folder_id, is_pinned, sort_order, created_at, updated_at FROM files ORDER BY is_pinned DESC, sort_order, updated_at DESC'));
});

app.post('/api/files', async (req, res) => {
  const id = nanoid(12);
  const { name, content, folder_id } = req.body;
  const fid = folder_id || null;
  const maxOrder = fid
    ? await db.get('SELECT MAX(sort_order) as m FROM files WHERE folder_id = ?', [fid])
    : await db.get('SELECT MAX(sort_order) as m FROM files WHERE folder_id IS NULL');
  await db.run('INSERT INTO files (id, name, content, folder_id, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, name || 'Untitled', content || '', fid, (maxOrder?.m || 0) + 1]);
  res.status(201).json(await db.get('SELECT * FROM files WHERE id = ?', [id]));
});

app.get('/api/files/:id', async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.put('/api/files/:id', async (req, res) => {
  const { name, content, is_pinned, folder_id, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (is_pinned !== undefined) { sets.push('is_pinned = ?'); vals.push(!!is_pinned); }
  if (folder_id !== undefined) { sets.push('folder_id = ?'); vals.push(folder_id || null); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');
  vals.push(req.params.id);
  const result = await db.run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json(await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]));
});

app.delete('/api/files/:id', async (req, res) => {
  const result = await db.run('DELETE FROM files WHERE id = ?', [req.params.id]);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ===== SHARING =====
app.delete('/api/files/:id/share', async (req, res) => {
  await db.run('UPDATE files SET share_id = NULL WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/files/:id/share', async (req, res) => {
  const file = await db.get('SELECT share_id FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  let shareId = file.share_id;
  if (!shareId) { shareId = nanoid(8); await db.run('UPDATE files SET share_id = ? WHERE id = ?', [shareId, req.params.id]); }
  res.json({ share_id: shareId });
});

app.post('/api/files/:id/share-private', async (req, res) => {
  const file = await db.get('SELECT private_view_token, private_edit_token FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const { view_password, edit_password } = req.body;
  const sets = [], vals = [];
  let viewToken = file.private_view_token, editToken = file.private_edit_token;
  if (view_password) {
    if (!viewToken) viewToken = nanoid(16);
    sets.push('private_view_token = ?', 'private_view_pw = ?');
    vals.push(viewToken, hashSharePw(view_password));
  }
  if (edit_password) {
    if (!editToken) editToken = nanoid(16);
    sets.push('private_edit_token = ?', 'private_edit_pw = ?');
    vals.push(editToken, hashSharePw(edit_password));
  }
  if (sets.length) { vals.push(req.params.id); await db.run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals); }
  res.json({ view_token: view_password ? viewToken : file.private_view_token, edit_token: edit_password ? editToken : file.private_edit_token });
});

app.delete('/api/files/:id/share-private', async (req, res) => {
  const { type } = req.body || {};
  if (type === 'view') await db.run('UPDATE files SET private_view_token = NULL, private_view_pw = NULL WHERE id = ?', [req.params.id]);
  else if (type === 'edit') await db.run('UPDATE files SET private_edit_token = NULL, private_edit_pw = NULL WHERE id = ?', [req.params.id]);
  else await db.run('UPDATE files SET private_view_token = NULL, private_edit_token = NULL, private_view_pw = NULL, private_edit_pw = NULL WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Public share (no auth)
app.get('/api/shared/:shareId', async (req, res) => {
  const file = await db.get('SELECT id, name, content, share_id, created_at, updated_at FROM files WHERE share_id = ?', [req.params.shareId]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.post('/api/shared/:shareId/fork', async (req, res) => {
  const source = await db.get('SELECT name, content FROM files WHERE share_id = ?', [req.params.shareId]);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const id = nanoid(12);
  await db.run('INSERT INTO files (id, name, content) VALUES (?, ?, ?)', [id, source.name + ' (copy)', source.content]);
  res.status(201).json(await db.get('SELECT * FROM files WHERE id = ?', [id]));
});

// Private share (password-based, no auth)
app.get('/api/private/:token/check', async (req, res) => {
  const file = await db.get('SELECT id, name, private_view_pw FROM files WHERE private_view_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({ needs_password: !!file.private_view_pw, name: file.name });
});

app.post('/api/private/:token/auth', authRateLimiter, async (req, res) => {
  const file = await db.get('SELECT id, name, content, private_view_pw, created_at, updated_at FROM files WHERE private_view_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (file.private_view_pw && hashSharePw(req.body.password || '') !== file.private_view_pw) return res.status(403).json({ error: 'Wrong password' });
  res.json({ id: file.id, name: file.name, content: file.content, created_at: file.created_at, updated_at: file.updated_at });
});

app.get('/api/private-edit/:token/check', async (req, res) => {
  const file = await db.get('SELECT id, name, private_edit_pw FROM files WHERE private_edit_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json({ needs_password: !!file.private_edit_pw, name: file.name });
});

app.post('/api/private-edit/:token/auth', authRateLimiter, async (req, res) => {
  const file = await db.get('SELECT id, name, content, private_edit_pw, created_at, updated_at FROM files WHERE private_edit_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (file.private_edit_pw && hashSharePw(req.body.password || '') !== file.private_edit_pw) return res.status(403).json({ error: 'Wrong password' });
  res.json({ id: file.id, name: file.name, content: file.content, created_at: file.created_at, updated_at: file.updated_at });
});

app.put('/api/private-edit/:token', async (req, res) => {
  const { password, name, content } = req.body;
  const file = await db.get('SELECT id, private_edit_pw FROM files WHERE private_edit_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  if (file.private_edit_pw && hashSharePw(password || '') !== file.private_edit_pw) return res.status(403).json({ error: 'Wrong password' });
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = NOW()');
  vals.push(file.id);
  await db.run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals);
  res.json(await db.get('SELECT id, name, content, created_at, updated_at FROM files WHERE id = ?', [file.id]));
});

// ===== IMAGE UPLOAD =====
const ALLOWED_TYPES = { png: true, jpg: true, jpeg: true, gif: true, webp: true };
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAGIC_BYTES = { png: [0x89,0x50,0x4E,0x47], jpg: [0xFF,0xD8,0xFF], jpeg: [0xFF,0xD8,0xFF], gif: [0x47,0x49,0x46,0x38], webp: null };

function validateMagicBytes(buf, ext) {
  if (ext === 'webp') return buf.length >= 12 && buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 && buf[8]===0x57 && buf[9]===0x45 && buf[10]===0x42 && buf[11]===0x50;
  const expected = MAGIC_BYTES[ext];
  if (!expected) return false;
  for (let i = 0; i < expected.length; i++) { if (buf[i] !== expected[i]) return false; }
  return true;
}

app.post('/api/upload', (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'No data' });
  const match = data.match(/^data:image\/([a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format' });
  const claimedType = match[1].toLowerCase();
  if (!ALLOWED_TYPES[claimedType]) return res.status(400).json({ error: 'File type not allowed' });
  let buf;
  try { buf = Buffer.from(match[2], 'base64'); } catch (e) { return res.status(400).json({ error: 'Invalid base64' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > MAX_IMAGE_SIZE) return res.status(413).json({ error: 'Max 5MB' });
  if (!validateMagicBytes(buf, claimedType)) return res.status(400).json({ error: 'Content mismatch' });
  const ext = claimedType === 'jpeg' ? 'jpg' : claimedType;
  const name = nanoid(10) + '.' + ext;
  const filePath = path.join(UPLOAD_DIR, name);
  if (!filePath.startsWith(UPLOAD_DIR)) return res.status(400).json({ error: 'Invalid path' });
  fs.writeFileSync(filePath, buf);
  res.json({ url: '/uploads/' + name, name });
});

// ===== SPA =====
const serveIndex = (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'));
app.get('/s/:shareId', serveIndex);
app.get('/p/:token', serveIndex);
app.get('/e/:token', serveIndex);

// ===== START =====
async function start() {
  try {
    await db.init();
    log('PostgreSQL connected');
    await auth.ensureAdmin();
    setInterval(() => auth.cleanExpiredSessions(), 60 * 60 * 1000);
    app.listen(PORT, () => log(`Markdown Preview Studio running at http://localhost:${PORT}`));
  } catch (e) {
    console.error('Failed to start:', e.message);
    process.exit(1);
  }
}

start();

process.on('SIGINT', async () => { await db.close(); process.exit(); });
process.on('SIGTERM', async () => { await db.close(); process.exit(); });
