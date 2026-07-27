const initSqlJs = require('sql.js');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let driver = null;
let sqliteDb = null;
let pgPool = null;

function getConfigPath() {
  return path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'config.json');
}

function loadConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveConfig(config) {
  const dir = path.dirname(getConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function isSetupDone() {
  return !!loadConfig();
}

// ===== SQLite driver =====
let sqliteSaveTimer = null;
function sqliteSave() {
  const dbPath = loadConfig()?.sqlite_path || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'markdown.db');
  const data = sqliteDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}
function sqliteScheduleSave() {
  clearTimeout(sqliteSaveTimer);
  sqliteSaveTimer = setTimeout(sqliteSave, 300);
}

const sqliteDriver = {
  async init(config) {
    const SQL = await initSqlJs();
    const dbPath = config.sqlite_path || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'markdown.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) {
      sqliteDb = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      sqliteDb = new SQL.Database();
    }
    driver = 'sqlite';
  },
  query(sql, params = []) {
    const stmt = sqliteDb.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },
  run(sql, params = []) {
    sqliteDb.run(sql, params);
    sqliteScheduleSave();
    return { changes: sqliteDb.getRowsModified() };
  },
  get(sql, params = []) {
    const rows = sqliteDriver.query(sql, params);
    return rows[0] || null;
  },
  close() { if (sqliteDb) { sqliteSave(); sqliteDb.close(); } }
};

// ===== PostgreSQL driver =====
const pgDriver = {
  async init(config) {
    pgPool = new Pool({ connectionString: config.pg_connection });
    await pgPool.query('SELECT 1');
    driver = 'pg';
  },
  async query(sql, params = []) {
    const s = toPgPlaceholders(sql);
    const { rows } = await pgPool.query(s, params);
    return rows;
  },
  async run(sql, params = []) {
    const s = toPgPlaceholders(sql);
    const result = await pgPool.query(s, params);
    return { changes: result.rowCount };
  },
  async get(sql, params = []) {
    const rows = await pgDriver.query(sql, params);
    return rows[0] || null;
  },
  async close() { if (pgPool) await pgPool.end(); }
};

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// ===== Unified interface =====
const db = {
  isSetupDone,
  loadConfig,
  saveConfig,

  async init(config) {
    if (config.db_type === 'pg') {
      await pgDriver.init(config);
    } else {
      await sqliteDriver.init(config);
    }
    await db.migrate();
  },

  async query(sql, params) {
    return driver === 'pg' ? pgDriver.query(sql, params) : sqliteDriver.query(sql, params);
  },
  async run(sql, params) {
    return driver === 'pg' ? pgDriver.run(sql, params) : sqliteDriver.run(sql, params);
  },
  async get(sql, params) {
    return driver === 'pg' ? pgDriver.get(sql, params) : sqliteDriver.get(sql, params);
  },

  async migrate() {
    const textType = driver === 'pg' ? 'TEXT' : 'TEXT';
    const intType = driver === 'pg' ? 'INTEGER' : 'INTEGER';
    const defaultNow = driver === 'pg' ? 'NOW()' : "datetime('now')";

    await db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (${defaultNow})
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${defaultNow}),
      expires_at TEXT NOT NULL
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'New Folder',
      parent_id TEXT,
      sort_order ${intType} NOT NULL DEFAULT 0,
      collapsed ${intType} NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (${defaultNow})
    )`);

    await db.run(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Untitled',
      content TEXT NOT NULL DEFAULT '',
      folder_id TEXT,
      share_id TEXT UNIQUE,
      is_pinned ${intType} NOT NULL DEFAULT 0,
      sort_order ${intType} NOT NULL DEFAULT 0,
      private_view_token TEXT,
      private_edit_token TEXT,
      private_view_pw TEXT,
      private_edit_pw TEXT,
      created_at TEXT NOT NULL DEFAULT (${defaultNow}),
      updated_at TEXT NOT NULL DEFAULT (${defaultNow})
    )`);

    // Migrations for existing tables
    const safeMigrate = async (sql) => { try { await db.run(sql); } catch (e) {} };
    await safeMigrate('ALTER TABLE files ADD COLUMN folder_id TEXT');
    await safeMigrate('ALTER TABLE files ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    await safeMigrate('ALTER TABLE files ADD COLUMN private_view_token TEXT');
    await safeMigrate('ALTER TABLE files ADD COLUMN private_edit_token TEXT');
    await safeMigrate('ALTER TABLE files ADD COLUMN private_view_pw TEXT');
    await safeMigrate('ALTER TABLE files ADD COLUMN private_edit_pw TEXT');
    await safeMigrate('ALTER TABLE folders ADD COLUMN color TEXT');

    if (driver === 'sqlite') {
      await db.run('CREATE INDEX IF NOT EXISTS idx_files_share_id ON files(share_id)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)');
    }
  },

  close() {
    if (driver === 'pg') pgDriver.close();
    else sqliteDriver.close();
  },

  now() {
    return driver === 'pg' ? 'NOW()' : "datetime('now')";
  }
};

module.exports = db;
