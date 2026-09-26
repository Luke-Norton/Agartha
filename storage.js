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
        seq: q.maxSeq.get().n,
      };
    },

    // --- writing (one call per change) -------------------------------------
    saveStructure(s) { q.putStructure.run(s.id, s.owner, s.x, s.z, s.updated || s.t || Date.now(), JSON.stringify(s)); },
    deleteStructure(id) { q.delStructure.run(id); },
    addChat(m) { q.addChat.run(m.t, JSON.stringify(m)); },
    addChronicle(e) { q.addChronicle.run(e.t, e.msg); },
    saveProject(p) { q.putProject.run(p.id, JSON.stringify(p)); },
    saveName(key, rec) { q.putName.run(key, JSON.stringify(rec)); },
    logEvent(e) { q.addEvent.run(e.seq, e.at, e.t, JSON.stringify(e)); },
    setMeta(k, v) { q.putMeta.run(k, String(v)); },

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
