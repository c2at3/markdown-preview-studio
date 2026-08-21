const { Pool } = require('pg');

let pool = null;

const db = {
  async init() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    pool = new Pool({ connectionString: url, max: 20 });
    await pool.query('SELECT 1');
    await db.migrate();
  },

  async query(sql, params = []) {
    const { rows } = await pool.query(toPg(sql), params);
    return rows;
  },

  async run(sql, params = []) {
    const result = await pool.query(toPg(sql), params);
    return { changes: result.rowCount };
  },

  async get(sql, params = []) {
    const rows = await db.query(sql, params);
    return rows[0] || null;
  },

  async migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'New Folder',
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        collapsed BOOLEAN NOT NULL DEFAULT FALSE,
        color TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        content TEXT NOT NULL DEFAULT '',
        folder_id TEXT,
        share_id TEXT UNIQUE,
        is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        private_view_token TEXT,
        private_edit_token TEXT,
        private_view_pw TEXT,
        private_edit_pw TEXT,
        icon TEXT,
        icon_color TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE files ADD COLUMN IF NOT EXISTS icon TEXT;
      ALTER TABLE files ADD COLUMN IF NOT EXISTS icon_color TEXT;

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        content TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_files_share_id ON files(share_id);
      CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_files_pvt_view ON files(private_view_token);
      CREATE INDEX IF NOT EXISTS idx_files_pvt_edit ON files(private_edit_token);
    `);
  },

  async close() {
    if (pool) await pool.end();
  }
};

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

module.exports = db;
