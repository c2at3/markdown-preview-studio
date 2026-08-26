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

// Auth redirects (before static so they intercept HTML pages)
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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// ===== AUTH MIDDLEWARE =====
app.use('/api', async (req, res, next) => {
  const publicPrefixes = ['/auth/', '/shared/', '/private/', '/private-edit/'];
  const apiPath = req.path;
  if (publicPrefixes.some(p => apiPath.startsWith(p))) return next();

  const authHeader = req.headers['authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    const key = await auth.validateApiKey(bearerMatch[1].trim());
    if (!key) return res.status(401).json({ error: 'Invalid API key' });
    // API keys (third-party integrations) may only call this one endpoint.
    // Everything else - files, folders, templates, sharing, apikeys - stays
    // reachable only via a logged-in session (the app's own web UI).
    const isUploadCall = apiPath === '/files/upload' && (req.method === 'POST' || req.method === 'DELETE');
    if (!isUploadCall) {
      return res.status(403).json({ error: 'This API key can only be used with POST/DELETE /api/files/upload' });
    }
    req.user = { id: 'api:' + key.id, username: key.name, role: 'admin' };
    req.apiKey = key;
    return next();
  }

  const token = req.cookies.session || req.headers['x-session-token'];
  const user = await auth.validateSession(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
});

// ===== API KEYS (session auth only, see middleware above) =====
app.get('/api/apikeys', async (req, res) => {
  res.json(await auth.listApiKeys());
});

app.post('/api/apikeys', async (req, res) => {
  const { name } = req.body;
  res.status(201).json(await auth.createApiKey(name));
});

app.delete('/api/apikeys/:id', async (req, res) => {
  const ok = await auth.revokeApiKey(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
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
  await deleteFolderCascade(req.params.id);
  res.json({ ok: true });
});

// ===== TEMPLATES =====
app.get('/api/templates', async (req, res) => {
  res.json(await db.query('SELECT * FROM templates ORDER BY sort_order, created_at'));
});

app.post('/api/templates', async (req, res) => {
  const id = nanoid(10);
  const { name, content } = req.body;
  const maxOrder = await db.get('SELECT MAX(sort_order) as m FROM templates');
  await db.run('INSERT INTO templates (id, name, content, sort_order) VALUES (?, ?, ?, ?)',
    [id, name || 'Untitled', content || '', (maxOrder?.m || 0) + 1]);
  res.status(201).json(await db.get('SELECT * FROM templates WHERE id = ?', [id]));
});

app.put('/api/templates/:id', async (req, res) => {
  const { name, content, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const result = await db.run(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`, vals);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json(await db.get('SELECT * FROM templates WHERE id = ?', [req.params.id]));
});

app.delete('/api/templates/:id', async (req, res) => {
  const result = await db.run('DELETE FROM templates WHERE id = ?', [req.params.id]);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ===== FILES =====
app.get('/api/files', async (req, res) => {
  res.json(await db.query(`
    SELECT id, name, folder_id, is_pinned, sort_order, icon, icon_color, created_at, updated_at,
      (share_id IS NOT NULL OR private_view_token IS NOT NULL OR private_edit_token IS NOT NULL) AS is_shared
    FROM files ORDER BY is_pinned DESC, sort_order, updated_at DESC
  `));
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

// Resolves a "Parent/Child/Grandchild" path to a folder id, creating segments
// that don't exist yet (unless autoCreate is false, in which case it throws).
async function resolveFolderPath(pathStr, autoCreate, defaultColor) {
  const segments = (pathStr || '').split('/').map(s => s.trim()).filter(Boolean);
  let parentId = null;
  const createdIds = [];
  for (const seg of segments) {
    const existing = parentId
      ? await db.get('SELECT id FROM folders WHERE name = ? AND parent_id = ?', [seg, parentId])
      : await db.get('SELECT id FROM folders WHERE name = ? AND parent_id IS NULL', [seg]);
    if (existing) { parentId = existing.id; continue; }
    if (!autoCreate) {
      const err = new Error(`Folder path not found: "${segments.join('/')}" (missing "${seg}")`);
      err.status = 404;
      throw err;
    }
    const id = nanoid(10);
    const maxOrder = parentId
      ? await db.get('SELECT MAX(sort_order) as m FROM folders WHERE parent_id = ?', [parentId])
      : await db.get('SELECT MAX(sort_order) as m FROM folders WHERE parent_id IS NULL');
    await db.run('INSERT INTO folders (id, name, parent_id, sort_order, color) VALUES (?, ?, ?, ?, ?)',
      [id, seg, parentId, (maxOrder?.m || 0) + 1, defaultColor || null]);
    parentId = id;
    createdIds.push(id);
  }
  return { folder_id: parentId, created_folder_ids: createdIds };
}

async function findFileInFolder(fname, folderId) {
  return folderId
    ? db.get('SELECT id FROM files WHERE name = ? AND folder_id = ?', [fname, folderId])
    : db.get('SELECT id FROM files WHERE name = ? AND folder_id IS NULL', [fname]);
}

async function deleteFolderCascade(id) {
  await db.run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [id]);
  const children = await db.query('SELECT id FROM folders WHERE parent_id = ?', [id]);
  for (const c of children) {
    await db.run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [c.id]);
    await db.run('DELETE FROM folders WHERE id = ?', [c.id]);
  }
  await db.run('DELETE FROM folders WHERE id = ?', [id]);
}

const COLOR_NAMES = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899', teal: '#14b8a6', gray: '#6b7280'
};
const VALID_ICONS = ['default', 'note', 'bug', 'vulnerability', 'lock', 'warning', 'work', 'checklist', 'idea', 'book', 'chart', 'star', 'flag', 'rocket', 'calendar', 'code'];

// Colors and icons are a closed set, not free-form input - resolves a color
// *name* (e.g. "red") to its hex value, or an icon key to itself, throwing a
// 400 if the caller passed something outside the set. Returns undefined
// unchanged so "field omitted" and "field invalid" stay distinguishable.
function resolveColorName(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const hex = COLOR_NAMES[String(value).toLowerCase()];
  if (!hex) {
    const err = new Error(`Invalid ${field}: "${value}". Must be one of: ${Object.keys(COLOR_NAMES).join(', ')}`);
    err.status = 400;
    throw err;
  }
  return hex;
}

function resolveIconKey(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!VALID_ICONS.includes(String(value).toLowerCase())) {
    const err = new Error(`Invalid icon: "${value}". Must be one of: ${VALID_ICONS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return String(value).toLowerCase();
}

// The single endpoint API keys are allowed to call (see the /api auth
// middleware below). Addresses a file by a human-readable "folder path +
// filename" instead of ids - POST creates it, or overwrites it in place
// (same id, no duplicate) if one already exists there; DELETE removes the
// file (with filename) or the folder itself (without filename).
app.post('/api/files/upload', async (req, res) => {
  const { folder, auto_create, filename, name, content } = req.body;
  const fname = filename || name;
  if (!fname) return res.status(400).json({ error: 'filename is required' });

  let icon, iconColor, resolved;
  try {
    icon = resolveIconKey(req.body.icon);
    iconColor = resolveColorName(req.body.color_file !== undefined ? req.body.color_file : req.body.icon_color, 'color_file');
    const folderColor = resolveColorName(req.body.color_folder, 'color_folder');
    resolved = await resolveFolderPath(folder, auto_create !== false, folderColor);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const fid = resolved.folder_id;

  const existing = await findFileInFolder(fname, fid);
  if (existing) {
    const sets = ['updated_at = NOW()'], vals = [];
    if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
    if (icon !== undefined) { sets.push('icon = ?'); vals.push(icon); }
    if (iconColor !== undefined) { sets.push('icon_color = ?'); vals.push(iconColor); }
    vals.push(existing.id);
    await db.run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals);
    const file = await db.get('SELECT * FROM files WHERE id = ?', [existing.id]);
    return res.json({ ...file, action: 'updated', created_folder_ids: resolved.created_folder_ids });
  }

  const id = nanoid(12);
  const maxOrder = fid
    ? await db.get('SELECT MAX(sort_order) as m FROM files WHERE folder_id = ?', [fid])
    : await db.get('SELECT MAX(sort_order) as m FROM files WHERE folder_id IS NULL');
  await db.run(
    'INSERT INTO files (id, name, content, folder_id, sort_order, icon, icon_color) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, fname, content || '', fid, (maxOrder?.m || 0) + 1, icon || null, iconColor || null]
  );
  const file = await db.get('SELECT * FROM files WHERE id = ?', [id]);
  res.status(201).json({ ...file, action: 'created', created_folder_ids: resolved.created_folder_ids });
});

app.delete('/api/files/upload', async (req, res) => {
  const { folder, filename, name } = req.body;
  const fname = filename || name;

  let resolved;
  try {
    resolved = await resolveFolderPath(folder, false);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const fid = resolved.folder_id;

  if (!fname) {
    if (!fid) return res.status(400).json({ error: 'Nothing to delete: no folder path given' });
    await deleteFolderCascade(fid);
    return res.json({ ok: true, deleted: 'folder', folder_id: fid });
  }
  const existing = await findFileInFolder(fname, fid);
  if (!existing) return res.status(404).json({ error: 'File not found' });
  await db.run('DELETE FROM files WHERE id = ?', [existing.id]);
  res.json({ ok: true, deleted: 'file', id: existing.id });
});

app.get('/api/files/:id', async (req, res) => {
  const file = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.put('/api/files/:id', async (req, res) => {
  const { name, content, is_pinned, folder_id, sort_order, icon, icon_color } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (is_pinned !== undefined) { sets.push('is_pinned = ?'); vals.push(!!is_pinned); }
  if (folder_id !== undefined) { sets.push('folder_id = ?'); vals.push(folder_id || null); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (icon !== undefined) { sets.push('icon = ?'); vals.push(icon || null); }
  if (icon_color !== undefined) { sets.push('icon_color = ?'); vals.push(icon_color || null); }
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

// A rejected promise inside an async route handler isn't caught by Express 4,
// so it becomes an unhandled rejection - which crashes the whole process
// (and every other user's request with it) unless we intercept it here.
process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err);
});
