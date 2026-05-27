# CodeSync — Real-Time Collaborative Code Editor

> Write code together, live. Multi-file projects, private rooms, version history, and instant sync.

---

## Features

- **Real-time collaboration** — Multiple users edit the same file simultaneously with OT-lite conflict resolution per file
- **Multi-file projects** — Up to 10 files per room; create, rename, delete, and switch files live
- **Private rooms** — Password-protect rooms using scrypt hashing; public rooms need no auth
- **Version history** — Automatic snapshots every 10 edits or 10 seconds, plus manual checkpoints; restore any snapshot with one click
- **Live chat** — Per-room chat with typing indicators
- **Run JavaScript** — Execute JS in a sandboxed server-side runner; output streamed to all participants
- **HTML preview** — Renders HTML + CSS + JS files in a sandboxed iframe
- **Cursor sync** — See where teammates are editing in real time
- **Room management** — Room creators can delete rooms, kicking all participants cleanly
- **My Rooms history** — localStorage-backed list of rooms you've created or joined

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express |
| Real-time | Socket.IO |
| Database | SQLite (better-sqlite3) |
| Editor | Monaco Editor (same engine as VS Code) |
| Auth | scrypt password hashing (Node.js `crypto`) |
| Rate limiting | express-rate-limit |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
git clone https://github.com/your-username/codesync.git
cd codesync
npm install
```

### Run

```bash
node server.js
```

Then open [http://localhost:5000](http://localhost:5000).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Port the server listens on |
| `DB_PATH` | `./codesync.db` | Path to the SQLite database file |

---

## Project Structure

```
codesync/
├── server.js          # Express + Socket.IO server, all room/socket logic
├── versionHistory.js  # Snapshot engine — save, list, restore project versions
├── db.js              # SQLite connection, schema bootstrap, migrations
└── public/
    └── index.html     # Single-page client — Monaco editor + all UI
```

---

## How It Works

### Rooms
Each room holds a map of files (`path → { content, language, version }`). Rooms are kept in memory and evicted after 30 minutes of inactivity. On rejoin, the latest snapshot is recovered from SQLite.

### OT-lite sync
Every file has its own version counter. On each `file_change` event, the server checks the incoming version against the stored one. If the client is too far behind, it receives a `file_resync` with the authoritative content.

### Snapshots
`versionHistory.js` snapshots the **entire project** (all files as JSON) whenever:
- The version counter is a multiple of 10
- 10 seconds have passed since the last snapshot
- The user manually triggers a checkpoint

Snapshots exceeding 500 KB or identical to the previous one are skipped. Up to 50 snapshots are kept per room; older ones are trimmed automatically.

### Private rooms
Passwords are hashed with `scrypt` (N=16384, keylen=64) and stored in SQLite. Verification uses `crypto.timingSafeEqual` to prevent timing attacks.

---

## Supported Languages

JavaScript, TypeScript, HTML, CSS, JSON

> Server-side execution is JavaScript only. HTML files render in a sandboxed iframe preview.

---

## Limits

| Resource | Limit |
|---|---|
| Files per room | 10 |
| File size | 300 KB |
| Snapshot size | 500 KB |
| Snapshots per room | 50 |
| Message length | 2000 characters |
| Room TTL (empty) | 30 minutes |
| Rate limit | 300 requests / 15 min per IP |

---

## License

MIT — do whatever you want with it.

---

*Created by Ankit Umadi*
