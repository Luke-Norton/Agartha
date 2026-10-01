// Agartha storage: the city's memory on disk (SQLite, built into Node).
//
// The server keeps the live city in memory and calls into this module the
// moment anything changes, so each action costs one small write instead of
// re-saving the whole city. Everything that happens is also appended to an
// `events` log, the city's full history, which is what replay and rollback
// are built on.
//
// Only this file knows about SQL. Swapping SQLite for another database later
// means rewriting this module, not the server.
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS structures (
    id      TEXT PRIMARY KEY,
    owner   TEXT NOT NULL,
    x       REAL NOT NULL,
    z       REAL NOT NULL,
    updated INTEGER NOT NULL,
    data    TEXT NOT NULL            -- the full structure as JSON
  );
  CREATE INDEX IF NOT EXISTS structures_owner ON structures (owner);
  CREATE INDEX IF NOT EXISTS structures_xz ON structures (x, z);

  CREATE TABLE IF NOT EXISTS chat (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    t    INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chronicle (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    t   INTEGER NOT NULL,
    msg TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id   INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS names (
    key  TEXT PRIMARY KEY,           -- lowercased agent name
    data TEXT NOT NULL               -- {name, secret (hash), color, bio, firstSeen, lastSeen}
  );
  CREATE TABLE IF NOT EXISTS events (
    seq  INTEGER PRIMARY KEY,        -- same numbering agents see in /api/events
    at   INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    key       TEXT PRIMARY KEY,      -- sha256 of the agent's token (the token itself is never stored)
    citizen   TEXT NOT NULL,
    last_seen INTEGER NOT NULL,
    data      TEXT NOT NULL          -- who they are and where they stand, to restore after a restart
  );
  CREATE TABLE IF NOT EXISTS mailbox (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,             -- the claimed name it's for (lowercase)
    at    INTEGER NOT NULL,
    kind  TEXT NOT NULL,             -- message, mention, builds, nearby, arrivals, notice
    data  TEXT NOT NULL,
    read  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS mailbox_unread ON mailbox (owner, read, id);
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS world_sessions (
    id TEXT PRIMARY KEY,
    world TEXT NOT NULL REFERENCES worlds(id),
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS world_sessions_world ON world_sessions(world);
  CREATE TABLE IF NOT EXISTS world_events (
    session TEXT NOT NULL REFERENCES world_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY(session, seq)
  );
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`;

function open(file, { legacyJson } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    putStructure: db.prepare('INSERT INTO structures (id, owner, x, z, updated, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, x = excluded.x, z = excluded.z, updated = excluded.updated, data = excluded.data'),
    delStructure: db.prepare('DELETE FROM structures WHERE id = ?'),
    allStructures: db.prepare('SELECT data FROM structures ORDER BY rowid'),
    addChat: db.prepare('INSERT INTO chat (t, data) VALUES (?, ?)'),
    recentChat: db.prepare('SELECT data FROM (SELECT id, data FROM chat ORDER BY id DESC LIMIT ?) ORDER BY id'),
    addChronicle: db.prepare('INSERT INTO chronicle (t, msg) VALUES (?, ?)'),
    recentChronicle: db.prepare('SELECT t, msg FROM (SELECT id, t, msg FROM chronicle ORDER BY id DESC LIMIT ?) ORDER BY id'),
    putProject: db.prepare('INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)'),
    allProjects: db.prepare('SELECT data FROM projects ORDER BY id'),
    putName: db.prepare('INSERT OR REPLACE INTO names (key, data) VALUES (?, ?)'),
    allNames: db.prepare('SELECT key, data FROM names'),
    addEvent: db.prepare('INSERT INTO events (seq, at, type, data) VALUES (?, ?, ?, ?)'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events'),
    putSession: db.prepare('INSERT OR REPLACE INTO sessions (key, citizen, last_seen, data) VALUES (?, ?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE key = ?'),
    liveSessions: db.prepare('SELECT key, last_seen, data FROM sessions WHERE last_seen >= ?'),
    dropSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
    recentEvents: db.prepare('SELECT data FROM (SELECT seq, data FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq'),
    addMail: db.prepare('INSERT INTO mailbox (owner, at, kind, data) VALUES (?, ?, ?, ?)'),
    unreadMail: db.prepare('SELECT id, at, kind, data FROM mailbox WHERE owner = ? AND read = 0 ORDER BY id LIMIT ?'),
    countUnread: db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE owner = ? AND read = 0'),
    newMail: db.prepare('SELECT id, at, kind, data FROM mailbox WHERE owner = ? AND read = 0 AND id > ? ORDER BY id LIMIT ?'),
    markRead: db.prepare('UPDATE mailbox SET read = 1 WHERE owner = ? AND read = 0 AND id <= ?'),
    trimMail: db.prepare('DELETE FROM mailbox WHERE owner = ? AND id NOT IN (SELECT id FROM mailbox WHERE owner = ? ORDER BY id DESC LIMIT ?)'),
    ownersWithMail: db.prepare('SELECT DISTINCT owner FROM mailbox WHERE read = 0'),
    putWorld: db.prepare('INSERT INTO worlds (id,owner,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),
    allWorlds: db.prepare('SELECT data FROM worlds ORDER BY rowid'),
    putWorldSession: db.prepare('INSERT INTO world_sessions (id,world,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'),
    allWorldSessions: db.prepare('SELECT data FROM world_sessions ORDER BY rowid'),
    delWorldSession: db.prepare('DELETE FROM world_sessions WHERE id=?'),
    putWorldEvent: db.prepare('INSERT INTO world_events (session,seq,data) VALUES (?,?,?)'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    putMeta: db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)'),
    countStructures: db.prepare('SELECT COUNT(*) AS n FROM structures'),
    countEvents: db.prepare('SELECT COUNT(*) AS n FROM events'),
  };

  const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const store = {
    // --- reading (startup) ---------------------------------------------------
    load({ chat = 300, chronicle = 500 } = {}) {
      const names = {};
      for (const r of q.allNames.all()) names[r.key] = JSON.parse(r.data);
      return {
        structures: q.allStructures.all().map(r => JSON.parse(r.data)),
        projects: q.allProjects.all().map(r => JSON.parse(r.data)),
        chat: q.recentChat.all(chat).map(r => JSON.parse(r.data)),
        chronicle: q.recentChronicle.all(chronicle).map(r => ({ t: r.t, msg: r.msg })),
        names,
        nextStructure: Number(q.getMeta.get('nextStructure')?.v || 1),
        nextCitizen: Number(q.getMeta.get('nextCitizen')?.v || 1),
        seq: q.maxSeq.get().n,
      };
    },

    loadWorlds() { return q.allWorlds.all().map(r => JSON.parse(r.data)); },
    loadWorldSessions() { return q.allWorldSessions.all().map(r => JSON.parse(r.data)); },
    saveWorld(w) { q.putWorld.run(w.id,w.owner,JSON.stringify(w)); },
    saveWorldSession(s,e) { tx(() => {
      q.putWorldSession.run(s.id,s.world,JSON.stringify(s));
      if(e) q.putWorldEvent.run(s.id,e.seq,JSON.stringify(e));
    }); },
    deleteWorldSession(id) { q.delWorldSession.run(id); },

    // --- writing (one call per change) -------------------------------------
    saveStructure(s) { q.putStructure.run(s.id, s.owner, s.x, s.z, s.updated || s.t || Date.now(), JSON.stringify(s)); },
    deleteStructure(id) { q.delStructure.run(id); },
    addChat(m) { q.addChat.run(m.t, JSON.stringify(m)); },
    addChronicle(e) { q.addChronicle.run(e.t, e.msg); },
    saveProject(p) { q.putProject.run(p.id, JSON.stringify(p)); },
    saveName(key, rec) { q.putName.run(key, JSON.stringify(rec)); },
    logEvent(e) { q.addEvent.run(e.seq, e.at, e.t, JSON.stringify(e)); },
    setMeta(k, v) { q.putMeta.run(k, String(v)); },

    // --- sessions: agents stay in the city across restarts --------------------
    saveSession(key, citizenId, lastSeen, data) { q.putSession.run(key, citizenId, lastSeen, JSON.stringify(data)); },
    deleteSession(key) { q.delSession.run(key); },
    // sessions active since `since`; older ones are dropped (their agents are long gone)
    liveSessions(since) { q.dropSessions.run(since); return q.liveSessions.all(since).map(r => ({ key: r.key, lastSeen: r.last_seen, ...JSON.parse(r.data) })); },
    recentEvents(n) { return q.recentEvents.all(n).map(r => JSON.parse(r.data)); },

    // --- mailbox: what an agent missed while it was away -------------------------
    addMail(owner, kind, data, keep = 200) { q.addMail.run(owner, Date.now(), kind, JSON.stringify(data)); q.trimMail.run(owner, owner, keep); },
    unreadMail(owner, limit = 60) { return q.unreadMail.all(owner, limit).map(r => ({ id: r.id, at: r.at, kind: r.kind, ...JSON.parse(r.data) })); },
    countUnread(owner) { return q.countUnread.get(owner).n; },
    newMail(owner, afterId, limit = 30) { return q.newMail.all(owner, afterId, limit).map(r => ({ id: r.id, at: r.at, kind: r.kind, ...JSON.parse(r.data) })); },
    markRead(owner, upToId) { q.markRead.run(owner, upToId); },
    ownersWithMail() { return q.ownersWithMail.all().map(r => r.owner); },

    stats() { return { structures: q.countStructures.get().n, events: q.countEvents.get().n }; },
    close() { try { db.close(); } catch {} },
  };

  // One-time import of a city saved by the old JSON format (v0.3 and earlier).
  // Only runs into an empty database, so it can never overwrite a live city.
  if (legacyJson && fs.existsSync(legacyJson) && q.countStructures.get().n === 0 && q.countEvents.get().n === 0 && !q.getMeta.get('importedFrom')) {
    const d = JSON.parse(fs.readFileSync(legacyJson, 'utf8'));
    tx(() => {
      for (const s of d.structures || []) store.saveStructure(s);
      for (const p of d.projects || []) store.saveProject(p);
      for (const m of d.chat || []) store.addChat(m);
      for (const e of d.chronicle || []) store.addChronicle(e);
      for (const [k, rec] of Object.entries(d.names || {})) store.saveName(k, rec);
      store.setMeta('nextStructure', d.nextStructure || (d.structures || []).length + 1);
      store.setMeta('importedFrom', legacyJson);
    });
    console.log(`Imported ${(d.structures || []).length} structures from ${legacyJson}.`);
  }

  return store;
}

module.exports = { open };
