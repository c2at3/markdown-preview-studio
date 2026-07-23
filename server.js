const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3456;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'markdown.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db;

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  return { changes: db.getRowsModified() };
}

function get(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDb, 300);
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Folder',
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      folder_id TEXT,
      share_id TEXT UNIQUE,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migrations
  try { db.run('ALTER TABLE files ADD COLUMN folder_id TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN private_view_token TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN private_edit_token TEXT'); } catch (e) {}

  db.run('CREATE INDEX IF NOT EXISTS idx_files_share_id ON files(share_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_files_pvt_view ON files(private_view_token)');
  db.run('CREATE INDEX IF NOT EXISTS idx_files_pvt_edit ON files(private_edit_token)');
  saveDb();
}

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}, express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ===== FOLDERS =====
app.get('/api/folders', (req, res) => {
  res.json(query('SELECT * FROM folders ORDER BY sort_order'));
});

app.post('/api/folders', (req, res) => {
  const id = nanoid(10);
  const { name, parent_id } = req.body;
  const maxOrder = get('SELECT MAX(sort_order) as m FROM folders WHERE parent_id IS ?', [parent_id || null]);
  const order = (maxOrder?.m || 0) + 1;
  run('INSERT INTO folders (id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)',
    [id, name || 'New Folder', parent_id || null, order]);
  scheduleSave();
  res.status(201).json(get('SELECT * FROM folders WHERE id = ?', [id]));
});

app.put('/api/folders/:id', (req, res) => {
  const { name, parent_id, collapsed, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (parent_id !== undefined) { sets.push('parent_id = ?'); vals.push(parent_id || null); }
  if (collapsed !== undefined) { sets.push('collapsed = ?'); vals.push(collapsed ? 1 : 0); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, vals);
  scheduleSave();
  res.json(get('SELECT * FROM folders WHERE id = ?', [req.params.id]));
});

app.delete('/api/folders/:id', (req, res) => {
  run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [req.params.id]);
  const children = query('SELECT id FROM folders WHERE parent_id = ?', [req.params.id]);
  children.forEach(c => {
    run('UPDATE files SET folder_id = NULL WHERE folder_id = ?', [c.id]);
    run('DELETE FROM folders WHERE id = ?', [c.id]);
  });
  run('DELETE FROM folders WHERE id = ?', [req.params.id]);
  scheduleSave();
  res.json({ ok: true });
});

// ===== FILES =====
app.get('/api/files', (req, res) => {
  const files = query('SELECT id, name, folder_id, is_pinned, sort_order, created_at, updated_at FROM files ORDER BY is_pinned DESC, sort_order, updated_at DESC');
  res.json(files);
});

app.post('/api/files', (req, res) => {
  const id = nanoid(12);
  const { name, content, folder_id } = req.body;
  const maxOrder = get('SELECT MAX(sort_order) as m FROM files WHERE folder_id IS ?', [folder_id || null]);
  const order = (maxOrder?.m || 0) + 1;
  run('INSERT INTO files (id, name, content, folder_id, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, name || 'Untitled', content || '', folder_id || null, order]);
  scheduleSave();
  res.status(201).json(get('SELECT * FROM files WHERE id = ?', [id]));
});

app.get('/api/files/:id', (req, res) => {
  const file = get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.put('/api/files/:id', (req, res) => {
  const { name, content, is_pinned, folder_id, sort_order } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (is_pinned !== undefined) { sets.push('is_pinned = ?'); vals.push(is_pinned ? 1 : 0); }
  if (folder_id !== undefined) { sets.push('folder_id = ?'); vals.push(folder_id || null); }
  if (sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(sort_order); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  const result = run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  scheduleSave();
  res.json(get('SELECT * FROM files WHERE id = ?', [req.params.id]));
});

app.delete('/api/files/:id', (req, res) => {
  const result = run('DELETE FROM files WHERE id = ?', [req.params.id]);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  scheduleSave();
  res.json({ ok: true });
});

// ===== SHARING =====
// Public share (short token)
app.post('/api/files/:id/share', (req, res) => {
  const file = get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  let shareId = file.share_id;
  if (!shareId) {
    shareId = nanoid(8);
    run('UPDATE files SET share_id = ? WHERE id = ?', [shareId, req.params.id]);
    scheduleSave();
  }
  res.json({ share_id: shareId });
});

// Private share (long tokens)
app.post('/api/files/:id/share-private', (req, res) => {
  const file = get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  let viewToken = file.private_view_token;
  let editToken = file.private_edit_token;
  if (!viewToken) { viewToken = nanoid(32); run('UPDATE files SET private_view_token = ? WHERE id = ?', [viewToken, req.params.id]); }
  if (!editToken) { editToken = nanoid(32); run('UPDATE files SET private_edit_token = ? WHERE id = ?', [editToken, req.params.id]); }
  scheduleSave();
  res.json({ view_token: viewToken, edit_token: editToken });
});

// Revoke private tokens
app.delete('/api/files/:id/share-private', (req, res) => {
  const { type } = req.body || {};
  if (type === 'view') run('UPDATE files SET private_view_token = NULL WHERE id = ?', [req.params.id]);
  else if (type === 'edit') run('UPDATE files SET private_edit_token = NULL WHERE id = ?', [req.params.id]);
  else { run('UPDATE files SET private_view_token = NULL, private_edit_token = NULL WHERE id = ?', [req.params.id]); }
  scheduleSave();
  res.json({ ok: true });
});

// Public share endpoints
app.get('/api/shared/:shareId', (req, res) => {
  const file = get('SELECT id, name, content, share_id, created_at, updated_at FROM files WHERE share_id = ?', [req.params.shareId]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.post('/api/shared/:shareId/fork', (req, res) => {
  const source = get('SELECT name, content FROM files WHERE share_id = ?', [req.params.shareId]);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const id = nanoid(12);
  run('INSERT INTO files (id, name, content) VALUES (?, ?, ?)', [id, source.name + ' (copy)', source.content]);
  scheduleSave();
  res.status(201).json(get('SELECT * FROM files WHERE id = ?', [id]));
});

// Private view endpoint
app.get('/api/private/:token', (req, res) => {
  const file = get('SELECT id, name, content, created_at, updated_at FROM files WHERE private_view_token = ? OR private_edit_token = ?', [req.params.token, req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

// Private edit endpoints
app.get('/api/private-edit/:token', (req, res) => {
  const file = get('SELECT id, name, content, created_at, updated_at FROM files WHERE private_edit_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.json(file);
});

app.put('/api/private-edit/:token', (req, res) => {
  const file = get('SELECT id FROM files WHERE private_edit_token = ?', [req.params.token]);
  if (!file) return res.status(404).json({ error: 'Not found' });
  const { name, content } = req.body;
  const sets = [], vals = [];
  if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  vals.push(file.id);
  run(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`, vals);
  scheduleSave();
  res.json(get('SELECT id, name, content, created_at, updated_at FROM files WHERE id = ?', [file.id]));
});

// ===== IMAGE UPLOAD =====
const ALLOWED_TYPES = { png: true, jpg: true, jpeg: true, gif: true, webp: true };
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

const MAGIC_BYTES = {
  png:  [0x89, 0x50, 0x4E, 0x47],
  jpg:  [0xFF, 0xD8, 0xFF],
  jpeg: [0xFF, 0xD8, 0xFF],
  gif:  [0x47, 0x49, 0x46, 0x38],
  webp: null // checked separately: RIFF....WEBP
};

function validateMagicBytes(buf, ext) {
  if (ext === 'webp') {
    return buf.length >= 12
      && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  const expected = MAGIC_BYTES[ext];
  if (!expected) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[i] !== expected[i]) return false;
  }
  return true;
}

app.post('/api/upload', (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'string') return res.status(400).json({ error: 'No data' });

  const match = data.match(/^data:image\/([a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format' });

  const claimedType = match[1].toLowerCase();
  if (!ALLOWED_TYPES[claimedType]) {
    return res.status(400).json({ error: 'File type not allowed. Use: png, jpg, gif, webp' });
  }

  let buf;
  try {
    buf = Buffer.from(match[2], 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid base64 data' });
  }

  if (buf.length === 0) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > MAX_IMAGE_SIZE) {
    return res.status(413).json({ error: 'File too large. Max ' + (MAX_IMAGE_SIZE / 1024 / 1024) + 'MB' });
  }

  if (!validateMagicBytes(buf, claimedType)) {
    return res.status(400).json({ error: 'File content does not match declared type' });
  }

  const ext = claimedType === 'jpeg' ? 'jpg' : claimedType;
  const name = nanoid(10) + '.' + ext;
  const filePath = path.join(UPLOAD_DIR, name);

  if (!filePath.startsWith(UPLOAD_DIR)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  fs.writeFileSync(filePath, buf);
  res.json({ url: '/uploads/' + name, name });
});

// ===== SPA FALLBACK =====
const serveIndex = (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'));
app.get('/s/:shareId', serveIndex);
app.get('/p/:token', serveIndex);
app.get('/e/:token', serveIndex);

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Markdown Live Preview running at http://localhost:${PORT}`);
  });
});

process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });
