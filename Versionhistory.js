// versionHistory.js — project-level snapshot history
// All DB writes deferred via setImmediate; never in the realtime path.

const db = require("./db");

const SNAPSHOT_EVERY_N_VERSIONS = 10;
const SNAPSHOT_EVERY_N_SECONDS  = 10;
const MAX_VERSIONS_PER_ROOM     = 50;
const MAX_SNAPSHOT_BYTES        = 500 * 1024;  // 500KB

// per-room tracking (ephemeral, in-memory only)
const snapshotState = {};

function getSnapshotState(roomId) {
  if (!snapshotState[roomId]) {
    snapshotState[roomId] = {
      lastSnapshotVersion: -1,
      lastSnapshotTime:    0,
      lastProjectHash:     null,   // quick-change-detect via JSON length
    };
  }
  return snapshotState[roomId];
}

// ── Prepared statements ───────────────────────────────────────────────────────
let stmts = null;
function getStmts() {
  if (stmts) return stmts;
  if (!db)   return null;
  stmts = {
    upsertRoom: db.prepare(`
      INSERT INTO rooms (id, language, is_private, password_hash, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        language      = excluded.language,
        is_private    = excluded.is_private,
        password_hash = excluded.password_hash
    `),
    insertVersion: db.prepare(`
      INSERT INTO versions (room_id, version_number, project_snapshot, saved_by, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
    `),
    listVersions: db.prepare(`
      SELECT id, version_number, saved_by,
             datetime(created_at, 'unixepoch', 'localtime') AS created_at
      FROM versions WHERE room_id = ?
      ORDER BY created_at DESC LIMIT ?
    `),
    getVersion: db.prepare(`
      SELECT project_snapshot, version_number
      FROM versions WHERE room_id = ? AND version_number = ?
      LIMIT 1
    `),
    getLatestVersion: db.prepare(`
      SELECT v.project_snapshot, v.version_number, r.language
      FROM versions v JOIN rooms r ON r.id = v.room_id
      WHERE v.room_id = ?
      ORDER BY v.created_at DESC LIMIT 1
    `),
    countVersions:    db.prepare("SELECT COUNT(*) AS cnt FROM versions WHERE room_id = ?"),
    deleteOldVersions: db.prepare(`
      DELETE FROM versions WHERE room_id = ?
        AND id NOT IN (
          SELECT id FROM versions WHERE room_id = ?
          ORDER BY created_at DESC LIMIT ?
        )
    `),
  };
  return stmts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the project snapshot JSON from a room object.
 * room.files = { "main.js": { content, language, version }, ... }
 */
function buildSnapshot(room) {
  const files = {};
  for (const [path, f] of Object.entries(room.files)) {
    files[path] = { content: f.content, language: f.language };
  }
  return JSON.stringify({ files, activeFile: room.activeFile });
}

// ── Public API ────────────────────────────────────────────────────────────────

function ensureRoom(roomId, language = "javascript", isPrivate = false, passwordHash = null) {
  const s = getStmts();
  if (!s) return;
  try { s.upsertRoom.run(roomId, language, isPrivate ? 1 : 0, passwordHash); }
  catch (err) { console.error("[db] ensureRoom:", err.message); }
}

function loadRoomMeta(roomId) {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT is_private, password_hash FROM rooms WHERE id = ?").get(roomId);
    if (!row) return null;
    return { isPrivate: Boolean(row.is_private), passwordHash: row.password_hash };
  } catch (err) { console.error("[db] loadRoomMeta:", err.message); return null; }
}

/**
 * maybeSnapshot — called after every file_change.
 * Snapshots the ENTIRE project (all files) not just the changed file.
 * Uses JSON length as a quick dirty-check to skip identical snapshots.
 */
function maybeSnapshot(roomId, room, triggeredBy = "auto", savedBy = null) {
  const state = getSnapshotState(roomId);
  const now   = Date.now();

  // Use the highest version across all files as the "room version"
  const version = Math.max(...Object.values(room.files).map(f => f.version));

  const snapshot = buildSnapshot(room);
  if (Buffer.byteLength(snapshot, "utf8") > MAX_SNAPSHOT_BYTES) return;
  if (snapshot === state.lastProjectHash) return;  // nothing changed

  const versionTrigger = (version % SNAPSHOT_EVERY_N_VERSIONS === 0);
  const timeTrigger    = (now - state.lastSnapshotTime) >= SNAPSHOT_EVERY_N_SECONDS * 1000;
  const manualTrigger  = (triggeredBy === "manual");
  if (!versionTrigger && !timeTrigger && !manualTrigger) return;

  state.lastSnapshotVersion = version;
  state.lastSnapshotTime    = now;
  state.lastProjectHash     = snapshot;

  setImmediate(() => saveVersionSnapshot(roomId, version, snapshot, savedBy));
}

function saveVersionSnapshot(roomId, versionNumber, snapshotJson, savedBy = null) {
  const s = getStmts();
  if (!s) return;
  try {
    s.insertVersion.run(roomId, versionNumber, snapshotJson, savedBy);
    console.log(`[history] snapshot saved room:${roomId} v${versionNumber}`);
    cleanupOldVersions(roomId);
  } catch (err) { console.error("[db] saveVersionSnapshot:", err.message); }
}

/**
 * loadLatestVersion — returns the full project state for a room.
 * Returns { files: { path: { content, language } }, activeFile, versionNumber }
 * Falls back to a single main.js if the snapshot is in the old format.
 */
function loadLatestVersion(roomId) {
  const s = getStmts();
  if (!s) return null;
  try {
    const row = s.getLatestVersion.get(roomId);
    if (!row) return null;
    return parseSnapshot(row.project_snapshot, row.version_number);
  } catch (err) { console.error("[db] loadLatestVersion:", err.message); return null; }
}

function listVersions(roomId, limit = MAX_VERSIONS_PER_ROOM) {
  const s = getStmts();
  if (!s) return [];
  try { return s.listVersions.all(roomId, limit); }
  catch (err) { console.error("[db] listVersions:", err.message); return []; }
}

/**
 * restoreVersion — returns the full project state for a specific snapshot.
 */
function restoreVersion(roomId, versionNumber) {
  const s = getStmts();
  if (!s) return null;
  try {
    const row = s.getVersion.get(roomId, versionNumber);
    if (!row) return null;
    return parseSnapshot(row.project_snapshot, row.version_number);
  } catch (err) { console.error("[db] restoreVersion:", err.message); return null; }
}

/**
 * parseSnapshot — parses stored JSON, handles backward compat with old
 * plain-text code_snapshot that was already migrated to wrapped JSON in db.js.
 */
function parseSnapshot(json, versionNumber) {
  try {
    const parsed = JSON.parse(json);
    // New format: { files: {...}, activeFile }
    if (parsed && parsed.files) {
      return { files: parsed.files, activeFile: parsed.activeFile || "main.js", versionNumber };
    }
  } catch { /* fall through */ }
  // Old plain-text fallback (shouldn't occur after migration but be safe)
  return {
    files:      { "main.js": { content: String(json), language: "javascript" } },
    activeFile: "main.js",
    versionNumber,
  };
}

function cleanupOldVersions(roomId) {
  const s = getStmts();
  if (!s) return;
  try {
    const { cnt } = s.countVersions.get(roomId);
    if (cnt > MAX_VERSIONS_PER_ROOM) {
      s.deleteOldVersions.run(roomId, roomId, MAX_VERSIONS_PER_ROOM);
      console.log(`[history] trimmed room:${roomId} to ${MAX_VERSIONS_PER_ROOM} snapshots`);
    }
  } catch (err) { console.error("[db] cleanupOldVersions:", err.message); }
}

function clearSnapshotState(roomId) { delete snapshotState[roomId]; }

module.exports = {
  ensureRoom, loadRoomMeta,
  maybeSnapshot, saveVersionSnapshot,
  loadLatestVersion, listVersions,
  restoreVersion, cleanupOldVersions,
  clearSnapshotState,
};