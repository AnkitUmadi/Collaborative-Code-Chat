// db.js — SQLite connection + schema bootstrap
const Database = require("better-sqlite3");
const path     = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "codesync.db");

let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  console.error("[db] Failed to open database:", err.message);
  module.exports = null;
  return;
}

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ─────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id            TEXT    PRIMARY KEY,
    language      TEXT    NOT NULL DEFAULT 'javascript',
    is_private    INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- versions now stores the entire project snapshot as JSON
  -- project_snapshot: { files: { "main.js": { content, language }, ... }, activeFile }
  CREATE TABLE IF NOT EXISTS versions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id          TEXT    NOT NULL,
    version_number   INTEGER NOT NULL,
    project_snapshot TEXT    NOT NULL,
    saved_by         TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_versions_room_created
    ON versions (room_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_versions_room_version
    ON versions (room_id, version_number);
`);

// ─────────────────────────────────────────────────────────────
// MIGRATIONS — safe for existing databases
// ─────────────────────────────────────────────────────────────
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}
function tableExists(table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

// rooms table privacy columns (added in a previous session)
if (!columnExists("rooms", "is_private")) {
  db.exec("ALTER TABLE rooms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0");
  console.log("[db] migration: added rooms.is_private");
}
if (!columnExists("rooms", "password_hash")) {
  db.exec("ALTER TABLE rooms ADD COLUMN password_hash TEXT");
  console.log("[db] migration: added rooms.password_hash");
}

// versions table: migrate code_snapshot → project_snapshot
// Old rows that only have code_snapshot get wrapped into the new JSON format
if (columnExists("versions", "code_snapshot") && !columnExists("versions", "project_snapshot")) {
  db.exec(`ALTER TABLE versions ADD COLUMN project_snapshot TEXT`);
  // Wrap all old snapshots into the new JSON format
  const rows = db.prepare("SELECT id, code_snapshot FROM versions WHERE project_snapshot IS NULL").all();
  const upd  = db.prepare("UPDATE versions SET project_snapshot=? WHERE id=?");
  const wrap = db.transaction(() => {
    for (const row of rows) {
      const proj = JSON.stringify({
        files:      { "main.js": { content: row.code_snapshot, language: "javascript" } },
        activeFile: "main.js",
      });
      upd.run(proj, row.id);
    }
  });
  wrap();
  console.log(`[db] migration: wrapped ${rows.length} old snapshots into project_snapshot`);
} else if (!columnExists("versions", "project_snapshot")) {
  // Fresh versions table with no code_snapshot — column already correct from schema above
}

console.log("[db] SQLite ready:", DB_PATH);
module.exports = db;