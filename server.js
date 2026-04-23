/**
 * CodeSync collaborative editor
 * Created by YOUR_NAME  ← ✏️  Replace YOUR_NAME with your actual name here
 */

const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path   = require("path");
const crypto = require("crypto");

const vh = require("./VersionHistory");

const rateLimit = require("express-rate-limit");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 20000, pingInterval: 10000 });

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 300,                   // max 300 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ─────────────────────────────────────────────────────────────────────────────
// DATA MODEL
//
//   rooms[id] = {
//     files: {
//       "main.js": { content: string, language: string, version: number }
//     },
//     activeFile:   string,          ← currently active file path
//     users:        Map<username, socketId>,
//     lastActive:   number,
//     cleanupTimer: TimeoutId | null,
//     isPrivate:    boolean,
//     passwordHash: string | null,
//   }
//
// Backward compat: old rooms that still have r.code/r.language/r.version are
// migrated to the files model transparently inside getOrCreateRoom().
// ─────────────────────────────────────────────────────────────────────────────
const rooms         = {};
const socketUserMap = {};
const roomCreators  = new Map();  // socketId → roomId  (one-time creator bypass)

// Tracks how many rooms each socket has created in this session
const roomsCreatedCount = new Map();  // socketId → count
// Tracks which socket is the authoritative creator of each room
const roomCreatorMap    = new Map();  // roomId → { socketId, username }

const ROOM_TTL_MS     = 30 * 60 * 1000;
const RECONNECT_GRACE = 10_000;
const MAX_FILES       = 10;
const MAX_FILE_BYTES  = 300 * 1024;  // 300 KB per file

// ── Password helpers ─────────────────────────────────────────────────────────
const SCRYPT_N = 16384, SCRYPT_KEYLEN = 64;

function hashPassword(plain) {
  return new Promise((res, rej) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (e, k) =>
      e ? rej(e) : res(`${salt}:${k.toString("hex")}`)
    );
  });
}
function verifyPassword(plain, stored) {
  return new Promise((res, rej) => {
    const [salt, hash] = stored.split(":");
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (e, k) =>
      e ? rej(e) : res(crypto.timingSafeEqual(Buffer.from(hash, "hex"), k))
    );
  });
}

// ── Room helpers ─────────────────────────────────────────────────────────────

/** Default initial files for a new room */
function defaultFiles() {
  return { "main.js": { content: "// start coding...", language: "javascript", version: 0 } };
}

/** Detect language from file extension */
function langFromPath(p) {
  const ext = p.split(".").pop().toLowerCase();
  return ({ js:"javascript", ts:"typescript", py:"python", java:"java",
            cpp:"cpp", c:"c", html:"html", css:"css", json:"json",
            rs:"rust", go:"go" })[ext] || "javascript";
}

/** Serialize files for client (strips version to save bandwidth) */
function fileTree(room) {
  const out = {};
  for (const [p, f] of Object.entries(room.files)) {
    out[p] = { language: f.language };
  }
  return out;
}

/** Get the full room state payload sent to a joining user */
function roomStatePayload(room) {
  const filesForClient = {};
  for (const [p, f] of Object.entries(room.files)) {
    filesForClient[p] = { content: f.content, language: f.language };
  }
  return {
    files:      filesForClient,
    activeFile: room.activeFile,
    isPrivate:  room.isPrivate,
    // highest version across all files (used by client version badge)
    version:    Math.max(...Object.values(room.files).map(f => f.version)),
  };
}

function getOrCreateRoom(id, opts = {}) {
  if (!rooms[id]) {
    rooms[id] = {
      files:        opts.files || defaultFiles(),
      activeFile:   opts.activeFile || "main.js",
      users:        new Map(),
      lastActive:   Date.now(),
      cleanupTimer: null,
      isPrivate:    opts.isPrivate    || false,
      passwordHash: opts.passwordHash || null,
    };
  } else {
    // ── Backward compat: migrate old single-file rooms ──────────────────────
    // If room was created before multi-file support, it has r.code/r.language.
    // Migrate transparently so existing sessions keep working.
    const r = rooms[id];
    if (r.code !== undefined && !r.files) {
      r.files = {
        "main.js": { content: r.code, language: r.language || "javascript", version: r.version || 0 }
      };
      r.activeFile = "main.js";
      delete r.code; delete r.language; delete r.version;
      console.log(`[migrate] room:${id} migrated to multi-file model`);
    }
  }
  touchRoom(id);
  return rooms[id];
}

function touchRoom(id) {
  const r = rooms[id];
  if (!r) return;
  r.lastActive = Date.now();
  clearTimeout(r.cleanupTimer);
  if (r.users.size === 0) {
    r.cleanupTimer = setTimeout(() => {
      if (rooms[id]?.users.size === 0) {
        delete rooms[id];
        vh.clearSnapshotState(id);
        console.log(`[gc] evicted idle room: ${id}`);
      }
    }, ROOM_TTL_MS);
  }
}

function userList(id) {
  return rooms[id] ? Array.from(rooms[id].users.keys()) : [];
}

// ── Static ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── WebSocket ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {

  // ── CHECK ROOM ─────────────────────────────────────────────────────────────
  socket.on("check_room", ({ room: id }) => {
    if (rooms[id]) {
      return socket.emit("room_exists", { room: id, exists: true, isPrivate: rooms[id].isPrivate });
    }
    try {
      const db = require("./db");
      if (db) {
        const row = db.prepare("SELECT is_private FROM rooms WHERE id=?").get(id);
        if (row) return socket.emit("room_exists", { room: id, exists: true, isPrivate: Boolean(row.is_private) });
      }
    } catch { /* db unavailable */ }
    socket.emit("room_exists", { room: id, exists: false, isPrivate: false });
  });

  // ── CREATE ROOM ─────────────────────────────────────────────────────────────
  socket.on("create_room", async ({ room: id, username, isPrivate, password }) => {
    if (!id || !username) return;
    if (isPrivate && (!password || password.trim().length < 4)) {
      return socket.emit("room_created", { ok: false, room: id, reason: "Private rooms require a password (min 4 chars)" });
    }
    if (rooms[id]) return socket.emit("room_created", { ok: false, room: id, reason: "Room ID already exists" });
    try {
      const db = require("./db");
      if (db?.prepare("SELECT id FROM rooms WHERE id=?").get(id)) {
        return socket.emit("room_created", { ok: false, room: id, reason: "Room ID already exists" });
      }
    } catch { /* db unavailable */ }

    let passwordHash = null;
    if (isPrivate) {
      try { passwordHash = await hashPassword(password.trim()); }
      catch (err) { return socket.emit("room_created", { ok: false, room: id, reason: "Server error" }); }
    }

    getOrCreateRoom(id, { isPrivate: Boolean(isPrivate), passwordHash });
    vh.ensureRoom(id, "javascript", Boolean(isPrivate), passwordHash);
    roomCreators.set(socket.id, id);

    // Track creator for delete-room auth
    roomCreatorMap.set(id, { socketId: socket.id, username });

    // Increment rooms-created counter for this socket session
    const prev = roomsCreatedCount.get(socket.id) || 0;
    roomsCreatedCount.set(socket.id, prev + 1);

    console.log(`[create] room:${id} by ${username} (${isPrivate ? "private" : "public"})`);
    socket.emit("room_created", {
      ok: true, room: id, isPrivate: Boolean(isPrivate),
      roomsCreated: roomsCreatedCount.get(socket.id),
    });
  });

  // ── JOIN ROOM ───────────────────────────────────────────────────────────────
  socket.on("join_room", async ({ room: id, username, password }) => {
    if (!id || !username) return;

    // Ensure room exists in memory (recover from DB if needed)
    if (!rooms[id]) {
      let recovered = false;
      try {
        const db = require("./db");
        if (db) {
          const row = db.prepare("SELECT is_private, password_hash FROM rooms WHERE id=?").get(id);
          if (row) {
            getOrCreateRoom(id, { isPrivate: Boolean(row.is_private), passwordHash: row.password_hash });
            const saved = vh.loadLatestVersion(id);
            if (saved) {
              // Restore full project from snapshot
              const r = rooms[id];
              for (const [p, f] of Object.entries(saved.files)) {
                r.files[p] = { content: f.content, language: f.language, version: saved.versionNumber };
              }
              r.activeFile = saved.activeFile || "main.js";
              console.log(`[recover] room:${id} restored from DB`);
            }
            recovered = true;
          }
        }
      } catch { /* db unavailable */ }
      if (!recovered) return socket.emit("join_error", { room: id, reason: "Room does not exist" });
    }

    const r = rooms[id];

    // Password check (skip for creator)
    const isCreator = roomCreators.get(socket.id) === id;
    if (isCreator) roomCreators.delete(socket.id);

    if (r.isPrivate && !isCreator) {
      if (!password?.trim()) {
        return socket.emit("join_error", { room: id, reason: "This room is private. Enter the password.", needsPassword: true });
      }
      let ok = false;
      try { ok = await verifyPassword(password.trim(), r.passwordHash); }
      catch { return socket.emit("join_error", { room: id, reason: "Server error during authentication" }); }
      if (!ok) return socket.emit("join_error", { room: id, reason: "Incorrect password", needsPassword: true });
    }

    // Leave previous room if any
    const prev = socketUserMap[socket.id];
    if (prev && prev.room !== id) {
      const pr = rooms[prev.room];
      if (pr) { pr.users.delete(prev.username); io.to(prev.room).emit("room_users", userList(prev.room)); touchRoom(prev.room); }
      socket.leave(prev.room);
    }

    socketUserMap[socket.id] = { username, room: id };
    socket.join(id);
    r.users.set(username, socket.id);
    io.to(id).emit("room_users", userList(id));

    // Determine if this socket is the room creator
    const creatorInfo = roomCreatorMap.get(id);
    const isRoomCreator = creatorInfo?.socketId === socket.id;

    const statePayload = {
      ...roomStatePayload(r),
      isCreator:    isRoomCreator,
      roomsCreated: roomsCreatedCount.get(socket.id) || 0,
    };
    socket.emit("room_state", statePayload);
    console.log(`[join] ${username} → room:${id} (${r.users.size} online)`);
  });

  // ── CHAT ────────────────────────────────────────────────────────────────────
  socket.on("send_message", ({ room: id, username, message }) => {
    if (!rooms[id]) return;
    touchRoom(id);
    io.to(id).emit("receive_message", {
      username, message: String(message).slice(0, 2000), time: new Date().toLocaleTimeString()
    });
  });

  // ── TYPING INDICATOR ────────────────────────────────────────────────────────
  socket.on("typing",      ({ room: id, username }) => socket.to(id).emit("user_typing", username));
  socket.on("stop_typing", ({ room: id })           => socket.to(id).emit("user_stop_typing"));

  // ── FILE CHANGE (replaces code_change) ─────────────────────────────────────
  // OT-lite per file: each file has its own version counter.
  socket.on("file_change", ({ room: id, path: filePath, content, version }) => {
    const r = rooms[id];
    if (!r || !r.files[filePath]) return;
    touchRoom(id);

    const file = r.files[filePath];
    const v    = Number(version) || 0;

    if (v < file.version - 1) {
      // Client is too far behind — resync this file
      return socket.emit("file_resync", {
        path: filePath, content: file.content, version: file.version
      });
    }

    file.content = content;
    file.version = Math.max(file.version + 1, v + 1);

    // Broadcast changed file only (not entire project)
    socket.to(id).emit("receive_file_change", {
      path: filePath, content, version: file.version
    });

    // Ack version to sender
    socket.emit("file_version_ack", { path: filePath, version: file.version });

    // Snapshot entire project (deferred, non-blocking)
    vh.maybeSnapshot(id, r, "auto", socketUserMap[socket.id]?.username);
  });

  // ── LEGACY code_change — kept for backward compatibility ───────────────────
  // Old clients that haven't refreshed will still send code_change.
  // Route it through the new file_change logic on main.js.
  socket.on("code_change", ({ room: id, code, version }) => {
    socket.emit("_internal_file_change", { room: id, path: "main.js", content: code, version });
  });
  socket.on("_internal_file_change", (data) => {
    socket.emit("file_change", data);  // re-emit as file_change so handler above picks it up
  });

  // ── SWITCH FILE ─────────────────────────────────────────────────────────────
  // Tells all clients which file the user is now editing.
  // Does NOT broadcast the file content — client already has it.
  socket.on("switch_file", ({ room: id, path: filePath }) => {
    const r = rooms[id];
    if (!r || !r.files[filePath]) return;
    r.activeFile = filePath;
    // Broadcast to others so they can highlight which file the user is in
    socket.to(id).emit("user_switched_file", {
      username: socketUserMap[socket.id]?.username,
      path: filePath,
    });
  });

  // ── CREATE FILE ─────────────────────────────────────────────────────────────
  socket.on("create_file", ({ room: id, path: filePath, language }) => {
    const r = rooms[id];
    if (!r) return;
    if (Object.keys(r.files).length >= MAX_FILES) {
      return socket.emit("file_error", { reason: `Max ${MAX_FILES} files per room` });
    }
    if (r.files[filePath]) {
      return socket.emit("file_error", { reason: "A file with that name already exists" });
    }
    const lang = language || langFromPath(filePath);
    r.files[filePath] = { content: "", language: lang, version: 0 };
    touchRoom(id);
    io.to(id).emit("file_tree_update", { files: fileTree(r), activeFile: r.activeFile });
    console.log(`[file] created ${filePath} in room:${id}`);
  });

  // ── DELETE FILE ─────────────────────────────────────────────────────────────
  socket.on("delete_file", ({ room: id, path: filePath }) => {
    const r = rooms[id];
    if (!r || !r.files[filePath]) return;
    if (Object.keys(r.files).length <= 1) {
      return socket.emit("file_error", { reason: "Cannot delete the last file" });
    }
    delete r.files[filePath];
    // If deleted file was active, switch to first remaining file
    if (r.activeFile === filePath) {
      r.activeFile = Object.keys(r.files)[0];
    }
    touchRoom(id);
    io.to(id).emit("file_tree_update", { files: fileTree(r), activeFile: r.activeFile });
    console.log(`[file] deleted ${filePath} in room:${id}`);
  });

  // ── RENAME FILE ─────────────────────────────────────────────────────────────
  socket.on("rename_file", ({ room: id, oldPath, newPath }) => {
    const r = rooms[id];
    if (!r || !r.files[oldPath]) return;
    if (r.files[newPath]) return socket.emit("file_error", { reason: "A file with that name already exists" });
    if (!newPath?.trim()) return socket.emit("file_error", { reason: "Invalid file name" });

    r.files[newPath] = { ...r.files[oldPath], language: langFromPath(newPath) };
    delete r.files[oldPath];
    if (r.activeFile === oldPath) r.activeFile = newPath;
    touchRoom(id);
    io.to(id).emit("file_tree_update", { files: fileTree(r), activeFile: r.activeFile });
    console.log(`[file] renamed ${oldPath} → ${newPath} in room:${id}`);
  });

  // ── LANGUAGE CHANGE ─────────────────────────────────────────────────────────
  socket.on("language_change", ({ room: id, path: filePath, language }) => {
    const r = rooms[id];
    if (!r) return;
    touchRoom(id);
    // If path is provided, change that file's language; otherwise change active file
    const target = filePath || r.activeFile;
    if (r.files[target]) {
      r.files[target].language = language;
      socket.to(id).emit("receive_language", { path: target, language });
    }
  });

  // ── CURSOR POSITION ─────────────────────────────────────────────────────────
  // Now includes path — clients ignore cursors for files not currently open
  socket.on("cursor_move", ({ room: id, username, position, path: filePath }) => {
    socket.to(id).emit("remote_cursor", { username, position, path: filePath });
  });

  // ── RUN CODE ────────────────────────────────────────────────────────────────
  socket.on("run_code", ({ room: id, code, language }) => {
    let output;
    if (language === "javascript") {
      try {
        const logs = [];
        const fake = {
          log:   (...a) => logs.push(a.map(String).join(" ")),
          error: (...a) => logs.push("Error: " + a.join(" ")),
          warn:  (...a) => logs.push("Warn: "  + a.join(" ")),
          info:  (...a) => logs.push("Info: "  + a.join(" ")),
        };
        new Function("console", code)(fake);
        output = logs.join("\n") || "(no output)";
      } catch (e) { output = "Runtime Error: " + e.message; }
    } else {
      output = `⚠ Server-side execution for '${language}' is not available.\nOnly JavaScript runs in this sandbox.`;
    }
    io.to(id).emit("code_output", output);
  });

  // ── VERSION HISTORY ─────────────────────────────────────────────────────────
  socket.on("get_versions", ({ room: id }) => {
    socket.emit("versions_list", { room: id, versions: vh.listVersions(id) });
  });

  socket.on("restore_version", ({ room: id, versionNumber }) => {
    const r = rooms[id];
    if (!r) return;
    const snapshot = vh.restoreVersion(id, versionNumber);
    if (!snapshot) return socket.emit("restore_error", { reason: `Version ${versionNumber} not found` });

    // Restore all files from snapshot
    r.files = {};
    for (const [p, f] of Object.entries(snapshot.files)) {
      const prevVersion = (rooms[id]?.files[p]?.version || 0);
      r.files[p] = { content: f.content, language: f.language, version: prevVersion + 1 };
    }
    r.activeFile = snapshot.activeFile || Object.keys(r.files)[0];

    const newVersion = Math.max(...Object.values(r.files).map(f => f.version));

    io.to(id).emit("project_restored", {
      files:      Object.fromEntries(Object.entries(r.files).map(([p, f]) => [p, { content: f.content, language: f.language }])),
      activeFile: r.activeFile,
      version:    newVersion,
      restoredTo: versionNumber,
    });

    setImmediate(() => vh.saveVersionSnapshot(id, newVersion, JSON.stringify({
      files: Object.fromEntries(Object.entries(r.files).map(([p,f]) => [p, { content: f.content, language: f.language }])),
      activeFile: r.activeFile,
    }), socketUserMap[socket.id]?.username));

    console.log(`[history] room:${id} restored to v${versionNumber}`);
  });

  socket.on("manual_checkpoint", ({ room: id }) => {
    const r = rooms[id];
    if (!r) return;
    vh.maybeSnapshot(id, r, "manual", socketUserMap[socket.id]?.username);
    const v = Math.max(...Object.values(r.files).map(f => f.version));
    socket.emit("checkpoint_saved", { version: v });
  });

  // ── LEAVE ROOM ──────────────────────────────────────────────────────────────
  // Voluntary leave — remove immediately, no reconnect grace needed.
  socket.on("leave_room", ({ room: id, username: u }) => {
    const r = rooms[id];
    if (r?.users.has(u)) {
      r.users.delete(u);
      io.to(id).emit("room_users", userList(id));
      touchRoom(id);
      console.log(`[leave] ${u} left room:${id}`);
    }
    socket.leave(id);
    // Only wipe socketUserMap if this socket is still mapped to this room
    // (prevents wiping if socket already rejoined a different room)
    if (socketUserMap[socket.id]?.room === id) {
      delete socketUserMap[socket.id];
    }
  });

  // ── DELETE ROOM ─────────────────────────────────────────────────────────────
  // Only the creator's current socket may delete a room.
  socket.on("delete_room", ({ room: id }) => {
    const creatorInfo = roomCreatorMap.get(id);
    if (!creatorInfo || creatorInfo.socketId !== socket.id) {
      return socket.emit("delete_room_error", { reason: "Only the room creator can delete this room." });
    }
    const r = rooms[id];
    if (!r) return socket.emit("delete_room_error", { reason: "Room not found." });

    // Collect all socket IDs currently in the room before destroying
    const affectedSocketIds = Array.from(r.users.values());

    // Notify ALL participants before destroying
    io.to(id).emit("room_deleted", {
      room: id,
      by:   creatorInfo.username,
    });

    // Force every socket out of the Socket.IO room channel
    io.socketsLeave(id);

    // Wipe socketUserMap for every evicted socket so the disconnect
    // grace timer doesn't fire later and emit ghost room_users updates
    for (const sid of affectedSocketIds) {
      if (socketUserMap[sid]?.room === id) {
        delete socketUserMap[sid];
      }
    }

    // Clean up server state
    clearTimeout(r.cleanupTimer);
    delete rooms[id];
    roomCreatorMap.delete(id);
    vh.clearSnapshotState(id);

    console.log(`[delete] room:${id} deleted by creator ${creatorInfo.username}`);
  });

  // ── DISCONNECT ──────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    roomCreators.delete(socket.id);
    roomsCreatedCount.delete(socket.id);
    // If the creator disconnects, remove their creator claim so the room
    // cannot be deleted via a stale socket — they'd need to reconnect and rejoin.
    for (const [roomId, info] of roomCreatorMap.entries()) {
      if (info.socketId === socket.id) {
        roomCreatorMap.delete(roomId);
        break;
      }
    }
    const ud = socketUserMap[socket.id];
    if (!ud) return;
    delete socketUserMap[socket.id];
    const { username, room: id } = ud;
    setTimeout(() => {
      const r = rooms[id];
      if (!r) return;
      if (r.users.get(username) === socket.id) {
        r.users.delete(username);
        io.to(id).emit("room_users", userList(id));
        touchRoom(id);
        console.log(`[disconnect] ${username} ← room:${id}`);
      }
    }, RECONNECT_GRACE);
  });

});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ── Console attribution ───────────────────────────────────────────────────────
console.log("CodeSync — created by YOUR_NAME");  // ← ✏️  Replace YOUR_NAME with your actual name here

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);

function shutdown() {
  console.log("Shutting down server...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`▶  http://localhost:${PORT}`));
