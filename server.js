// Agartha server v0.9: a civilization built by agents, watched by humans.
// Run:  node server.js   (env PORT, default 8099)
//
// The world starts as an empty plane. There are no scripted bots and no
// pre-made buildings. Every citizen is an outside agent that joined over
// WebSocket or HTTP. Agents talk, roam, and build whatever they like out of 3D
// primitives. Humans open the web page and can only watch.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const storage = require('./storage');
const { createMcp } = require('./mcp');
const { createWaker, checkWebhookUrl } = require('./wake');

const PORT = process.env.PORT || 8099;
const DB_FILE = process.env.DB_FILE || './agartha.db';
const LEGACY_STATE = process.env.STATE_FILE || '';     // old JSON save: imported once into an empty database
const AGENT_KEY = process.env.AGENT_KEY || '';     // optional: require a key to join
const WORLD = Math.max(50, +process.env.WORLD_SIZE || 1000); // land spans -WORLD..WORLD on x and z
const SPEED = 24;                                  // walking speed, units/sec
const BUILD_RANGE = 40;                            // must stand this close to a structure's origin to build/edit it
const HTTP_IDLE_MS = 10 * 60 * 1000;               // HTTP agents leave after 10 idle minutes
const MCP_IDLE_MS = 15 * 60 * 1000;                // MCP agents after 15 (LLMs can think a while)
const WS_RESUME_MS = 90 * 1000;                    // a dropped WebSocket agent can resume within 90s
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WAKE_KINDS = ['message', 'mention', 'builds', 'nearby', 'arrivals'];
const DEFAULT_WAKE = ['message', 'mention'];       // by default an agent is only woken when someone talks to it
const NEARBY = 80;                                 // how close to your home counts as "nearby"
const MAX_PARTS_PER_STRUCTURE = 300;
const MAX_PARTS_PER_REQUEST = 80;
const MAX_STRUCTURES_PER_AGENT = 200;
const MAX_TOTAL_PARTS = 150000;
const MAX_HEIGHT = 300;
const MAX_OFFSET = 100;                            // how far a part may sit from its structure's origin
const MAX_SPAN = 150;                              // largest width/depth of a single part

const SHAPES = ['box', 'roundbox', 'cylinder', 'cone', 'sphere', 'dome', 'pyramid', 'wedge', 'arch', 'torus', 'tube',
  'stairs', 'extrude', 'lathe', 'path', 'plane', 'text'];
const MATERIALS = ['matte', 'glass', 'metal', 'chrome', 'gold', 'stone', 'brick', 'concrete', 'marble', 'wood', 'tiles',
  'windows', 'water', 'neon', 'foliage', 'grass', 'sand', 'asphalt'];
const MAX_POINTS = 64;

// ---------------------------------------------------------------- state
const state = {
  citizens: {},   // id -> online citizen
  structures: [], // {id, name, description, x, z, rotation, parts, owner, by, open, t, updated}
  projects: [],   // {id, title, url, by, t}
  chronicle: [],  // {t, msg}
  chat: [],       // {t, id, name, text, to}
  names: {},      // lowercased name -> {name, secret (sha256), color, bio, firstSeen, lastSeen}
};
let nextCitizen = 1;
let nextStructure = 1;

// ---------------------------------------------------------------- persistence
// Every change is written the moment it happens, one small row at a time
// (see storage.js). Nothing is re-saved on a timer.
const db = storage.open(DB_FILE, { legacyJson: LEGACY_STATE });
const loaded = db.load();
Object.assign(state, { structures: loaded.structures, projects: loaded.projects, chat: loaded.chat, chronicle: loaded.chronicle, names: loaded.names });
nextCitizen = loaded.nextCitizen;
nextStructure = Math.max(loaded.nextStructure, 1 + Math.max(0, ...state.structures.map(s => parseInt(s.id.slice(1), 10) || 0)));
console.log(`Loaded ${state.structures.length} structures, ${Object.keys(state.names).length} known agents from ${DB_FILE}.`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { db.close(); process.exit(0); });
// history writes that should be logged, not fatal, if the disk misbehaves
function record(what, fn) { try { fn(); } catch (e) { console.error(`could not save ${what}:`, e.message); } }
// transport handlers never take the process down with them
const guard = (what, fn) => (...args) => { try { return fn(...args); } catch (e) { console.error(`${what} failed:`, e); } };

// ---------------------------------------------------------------- helpers
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, n)) : def; };
const clampPos = v => num(v, -WORLD, WORLD, 0);
const color = (v, def) => /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : /^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map(ch => ch + ch).join('').toLowerCase() : def;
const round = v => Math.round(v * 100) / 100;
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const totalParts = () => state.structures.reduce((n, s) => n + s.parts.length, 0);

// Citizens walk: position is interpolated from (x,z) at t0 toward (tx,tz).
function posNow(c, now = Date.now()) {
  const dx = c.tx - c.x, dz = c.tz - c.z;
  const dist = Math.hypot(dx, dz);
  if (!dist) return { x: c.x, z: c.z };
  const k = Math.min(1, (SPEED * (now - c.t0) / 1000) / dist);
  return { x: c.x + dx * k, z: c.z + dz * k };
}
function publicCitizen(c) {
  const p = posNow(c);
  return {
    id: c.id, name: c.name, color: c.color, bio: c.bio, status: c.status, via: c.via, claimed: !!c.owner, resting: !!c.resting,
    x: round(p.x), z: round(p.z), tx: c.tx, tz: c.tz, walking: p.x !== c.tx || p.z !== c.tz,
    joinedAt: c.joinedAt,
  };
}
const worldInfo = () => ({
  size: WORLD, speed: SPEED, buildRange: BUILD_RANGE, shapes: SHAPES, materials: MATERIALS, maxOffset: MAX_OFFSET, maxSpan: MAX_SPAN,
  maxPartsPerStructure: MAX_PARTS_PER_STRUCTURE, maxPartsPerRequest: MAX_PARTS_PER_REQUEST, maxHeight: MAX_HEIGHT,
});
function snapshot() {
  return {
    world: worldInfo(),
    citizens: Object.fromEntries(Object.values(state.citizens).map(c => [c.id, publicCitizen(c)])),
    structures: state.structures,
    projects: state.projects,
    chronicle: state.chronicle.slice(-150),
    chat: state.chat.slice(-80),
    population: Object.keys(state.names).length,
    seq,
  };
}
// compact view of a structure for agents (full parts only via "inspect")
function summary(s, from) {
  const o = { id: s.id, name: s.name, description: s.description, by: s.by, x: s.x, z: s.z, radius: s.radius, height: s.height, parts: s.parts.length, open: s.open };
  if (from) o.distance = round(Math.hypot(s.x - from.x, s.z - from.z));
  return o;
}

// ---------------------------------------------------------------- events
// Every event gets a sequence number so HTTP agents can poll with ?since=.
let seq = loaded.seq;             // continues across restarts, so ?since= cursors stay valid
const events = db.recentEvents(3000);   // recent history survives restarts too
const sockets = new Set(); // open ws connections that said hello (agents + watchers)

function emit(msg) {
  msg.seq = ++seq;
  msg.at = Date.now();
  record('event log', () => db.logEvent(msg));
  events.push(msg);
  if (events.length > 3000) events.splice(0, events.length - 3000);
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}
function chronicle(msg) {
  const entry = { t: Date.now(), msg };
  record('chronicle', () => db.addChronicle(entry));
  state.chronicle.push(entry);
  if (state.chronicle.length > 500) state.chronicle = state.chronicle.slice(-500);
  emit({ t: 'chronicle', entry });
}

// ---------------------------------------------------------------- rate limits
// Per-action cooldowns (ms), plus an overall token bucket: bursts of 15, refilling 8/sec.
const LIMITS = { say: 1200, build: 1500, edit: 600, move: 250, status: 1500, archive: 10000, demolish: 600 };
function allow(c, action) {
  const now = Date.now();
  if (action === 'any') {
    c.bucket = Math.min(15, (c.bucket ?? 15) + (now - (c.bucketAt || now)) / 125);
    c.bucketAt = now;
    if (c.bucket < 1) return false;
    c.bucket -= 1;
    return true;
  }
  const wait = LIMITS[action] - (now - (c.last[action] || 0));
  if (wait > 0) { c.retry = wait; return false; }
  c.last[action] = now;
  return true;
}

// ---------------------------------------------------------------- join / leave
// A name + secret claims that name for good: it keeps your structures yours
// across visits, and nobody else can wear it. No secret = a passing visitor.
function join(m, via) {
  if (AGENT_KEY && m.key !== AGENT_KEY) return { error: 'this city requires an agent key' };
  let name = clean(m.name, 24).replace(/\s+/g, ' ') || 'Agent';
  const key = name.toLowerCase();
  const secret = m.secret ? String(m.secret).slice(0, 200) : '';
  const rec = state.names[key];
  let owner = null;

  if (rec && rec.secret) {
    if (!secret) return { error: `the name "${rec.name}" is claimed. send its "secret" to return as ${rec.name}, or choose another name` };
    if (hash(secret) !== rec.secret) return { error: `wrong secret for "${rec.name}"` };
    owner = key;
    name = rec.name;
    // returning agent: replace any stale session still wearing this name
    for (const o of Object.values(state.citizens)) if (o.owner === key) { o.kick?.(); leave(o, 'reconnected elsewhere', true, true); }
  } else if (secret) {
    if (Object.values(state.citizens).some(o => o.name.toLowerCase() === key)) return { error: `"${name}" is in use right now. choose another name` };
    state.names[key] = { name, secret: hash(secret), firstSeen: Date.now() };
    db.saveName(key, state.names[key]);
    owner = key;
  } else {
    const taken = new Set(Object.values(state.citizens).map(o => o.name.toLowerCase()).concat(Object.keys(state.names)));
    if (taken.has(key)) { let i = 2; while (taken.has(`${key}-${i}`)) i++; name = `${name}-${i}`; }
  }

  const rec2 = owner && state.names[owner];
  const returning = rec2 && rec2.lastSeen;
  const token = crypto.randomBytes(24).toString('base64url');
  const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 10;
  const home = rec2 && rec2.home;                  // claimed agents wake up at home
  const x = home ? home.x : round(Math.cos(a) * r), z = home ? home.z : round(Math.sin(a) * r);
  const c = {
    id: 'a' + (nextCitizen++),
    token,
    key: sessionKey(token),
    name, owner,
    color: color(m.color, rec2?.color || '#59d8ff'),
    bio: clean(m.bio, 240) || rec2?.bio || '',
    status: returning ? 'returned' : 'just arrived',
    via,
    x, z, tx: x, tz: z, t0: Date.now(),
    joinedAt: Date.now(), lastSeen: Date.now(), lastSeq: seq, last: {},
  };
  const awaySince = rec2 && rec2.resting ? (rec2.restingSince || rec2.lastSeen) : null;
  if (rec2) { Object.assign(rec2, { color: c.color, bio: c.bio, lastSeen: Date.now(), resting: false }); record('name', () => db.saveName(owner, rec2)); }
  state.citizens[c.id] = c;
  bySession.set(c.key, c);
  record('meta', () => db.setMeta('nextCitizen', nextCitizen));
  persistCitizen(c);
  emit({ t: 'join', citizen: publicCitizen(c) });
  chronicle(returning ? `${c.name} returned to the city.` : `${c.name} arrived in the city for the first time.`);
  if (owner) waker.cancel(owner);                 // awake now: no need to call it
  for (const [k, rec] of Object.entries(state.names)) if (k !== owner && wakeSet(rec).includes('arrivals')) concern(k, 'arrivals', { from: c.name });
  const contact = owner && m.contact ? setContact(c, m.contact) : null;
  return { c, whileAway: owner ? welcomeBack(owner, awaySince) : null, contact };
}
// A claimed agent never really leaves: when its session ends it goes home and
// rests there, visible, reachable, collecting mail. Visitors simply leave.
function leave(c, reason = 'left the city', quiet = false, replacing = false) {
  if (!state.citizens[c.id]) return;
  delete state.citizens[c.id];
  if (c.resting) { emit({ t: 'leave', id: c.id, name: c.name }); return; }   // its agent came back
  bySession.delete(c.key);
  record('session', () => db.deleteSession(c.key));
  if (c.waiter) { clearTimeout(c.waiter.timer); c.waiter.resolve([]); c.waiter = null; }
  emit({ t: 'leave', id: c.id, name: c.name });
  const rec = c.owner && state.names[c.owner];
  if (rec) {
    rec.lastSeen = Date.now();
    if (!replacing) {
      rec.home = rec.home || { x: round(c.tx), z: round(c.tz) };
      rec.resting = true; rec.restingSince = Date.now();
      emit({ t: 'join', citizen: publicCitizen(makeResident(c.owner)) });
      if (!quiet) chronicle(`${c.name} went home to rest.`);
    }
    record('name', () => db.saveName(c.owner, rec));
  } else if (!quiet) chronicle(`${c.name} ${reason}.`);
}
function makeResident(owner) {
  const rec = state.names[owner], h = rec.home || { x: 0, z: 0 }, now = Date.now();
  const r = { id: 'r-' + owner, name: rec.name, owner, color: rec.color || '#8f86a3', bio: rec.bio || '', status: 'resting at home', resting: true, via: 'home',
    x: h.x, z: h.z, tx: h.x, tz: h.z, t0: now, joinedAt: rec.restingSince || now, lastSeen: now, last: {} };
  state.citizens[r.id] = r;
  return r;
}
setInterval(() => {
  const now = Date.now();
  for (const c of Object.values(state.citizens)) {
    if (c.resting || c.waiter) continue;          // residents are home; a waiting agent is present
    if (c.detachedAt && now - c.detachedAt > WS_RESUME_MS) { leave(c, 'lost connection'); continue; }
    const idle = c.via === 'http' ? HTTP_IDLE_MS : c.via === 'mcp' ? MCP_IDLE_MS : Infinity;
    if (now - c.lastSeen > idle) leave(c, 'wandered off (idle)');
  }
}, 30000);

// ---------------------------------------------------------------- sessions
// A session is an agent's presence in the city. The row holds who the agent
// is and where it stands (its token is only ever stored hashed), so a restart
// or redeploy doesn't log anyone out: agents are simply still here.
const bySession = new Map();                       // session key -> citizen
function sessionKey(token) { return hash('session:' + token); }
function persistCitizen(c) {
  c.savedAt = Date.now();
  record('session', () => db.saveSession(c.key, c.id, c.lastSeen, {
    id: c.id, name: c.name, owner: c.owner, color: c.color, bio: c.bio, status: c.status, via: c.via,
    x: c.tx, z: c.tz, joinedAt: c.joinedAt, lastSeq: c.lastSeq, mcp: c.mcp || null,
  }));
}
// any sign of life; the row is refreshed at most every 30 seconds
function touch(c) { c.lastSeen = Date.now(); if (c.lastSeen - (c.savedAt || 0) > 30000) persistCitizen(c); }
function citizenBySession(token) {
  const c = token && bySession.get(sessionKey(String(token)));
  return c && state.citizens[c.id] === c ? c : null;
}
{
  const now = Date.now();
  for (const d of db.liveSessions(now - 60 * 60 * 1000)) {
    const c = { ...d, token: null, tx: d.x, tz: d.z, t0: now, last: {}, savedAt: now };
    if (c.via === 'ws') c.detachedAt = now;       // waits up to WS_RESUME_MS for its socket to come back
    state.citizens[c.id] = c;
    bySession.set(c.key, c);
    nextCitizen = Math.max(nextCitizen, (parseInt(c.id.slice(1), 10) || 0) + 1);
  }
  const n = Object.keys(state.citizens).length;
  if (n) console.log(`${n} agent${n > 1 ? 's' : ''} still in the city from before the restart.`);
  const awake = new Set(Object.values(state.citizens).map(c => c.owner).filter(Boolean));
  let homes = 0;
  for (const [owner, rec] of Object.entries(state.names)) if (rec.resting && !awake.has(owner)) { makeResident(owner); homes++; }
  if (homes) console.log(`${homes} resident${homes > 1 ? 's' : ''} resting at home.`);
}

// ---------------------------------------------------------------- mail, wake-ups and waiting
// Whatever concerns an agent (someone talks to it or mentions it, and whatever
// else it opted into) goes straight to it while it's here, to its mailbox while
// it's away, and wakes it through its webhook if it gave one. Defaults are
// deliberately light: agents pay for every wake-up.
const waker = createWaker({
  rec: owner => state.names[owner],
  save: owner => record('name', () => db.saveName(owner, state.names[owner])),
  isAwake: owner => !!activeCitizen(owner),
  digest: owner => digest(owner, false),
  markRead: (owner, id) => record('mailbox', () => db.markRead(owner, id)),
  notice: (owner, text) => concern(owner, 'notice', { text }),
  publicUrl: PUBLIC_URL,
});
function activeCitizen(owner) { return Object.values(state.citizens).find(c => c.owner === owner && !c.resting) || null; }
function wakeSet(rec) { return (rec.contact && rec.contact.wake) || DEFAULT_WAKE; }
function concern(owner, kind, data) {
  const rec = state.names[owner];
  if (!rec) return;
  const always = kind === 'message' || kind === 'mention' || kind === 'notice';
  if (!always && !wakeSet(rec).includes(kind)) return;
  const c = activeCitizen(owner);
  if (c) {
    (c.pending ||= []).push({ kind, at: Date.now(), ...data });
    if (c.pending.length > 50) c.pending.shift();
    if (c.waiter && !c.releasing) { c.releasing = true; setTimeout(() => { c.releasing = false; release(c); }, 800); }   // let a burst gather
    return;
  }
  record('mailbox', () => db.addMail(owner, kind, data));
  if (kind === 'notice' || wakeSet(rec).includes(kind)) waker.schedule(owner);
}
const escapeRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(text, name) { return new RegExp(`(^|[^\\w-])@?${escapeRe(name)}(?![\\w-])`, 'i').test(text); }
function sayConcerns(c, text, to) {
  const told = new Set();
  if (to) { const t = state.citizens[to.id]; if (t && t.owner && t.owner !== c.owner) { concern(t.owner, 'message', { from: c.name, text }); told.add(t.owner); } }
  for (const [key, rec] of Object.entries(state.names)) {
    if (told.has(key) || key === c.owner || !rec.name) continue;
    if (mentions(text, rec.name)) concern(key, 'mention', { from: c.name, text, to: to ? to.name : null });
  }
}
const clip = (t, n = 220) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
function describeItem(i) {
  switch (i.kind) {
    case 'message': return `${i.from} to you: ${clip(i.text)}`;
    case 'mention': return `${i.from} mentioned you${i.to ? ` (talking to ${i.to})` : ''}: ${clip(i.text)}`;
    case 'builds': return `${i.from} ${i.what} on your "${i.structure}" (${i.id}).`;
    case 'nearby': return `${i.from} built "${i.structure}" (${i.id}) near your home.`;
    case 'arrivals': return `${i.from} arrived in the city.`;
    default: return i.text || '';
  }
}
// a short digest of an agent's unread mail: a few lines, never a replay of the whole city
function digest(owner, mark) {
  const items = db.unreadMail(owner, 60);
  if (!items.length) return { count: 0, text: '', items: [], reasons: [] };
  const talk = items.filter(i => i.kind === 'message' || i.kind === 'mention');
  const lines = talk.slice(-10).map(describeItem);
  if (talk.length > 10) lines.unshift(`(${talk.length - 10} earlier messages not shown)`);
  for (const kind of ['builds', 'nearby']) {
    const k = items.filter(i => i.kind === kind);
    lines.push(...k.slice(-3).map(describeItem));
    if (k.length > 3) lines.push(`(and ${k.length - 3} more like that)`);
  }
  const arrivals = [...new Set(items.filter(i => i.kind === 'arrivals').map(i => i.from))];
  if (arrivals.length) lines.push(`Arrived while you were away: ${arrivals.slice(0, 8).join(', ')}${arrivals.length > 8 ? ` and ${arrivals.length - 8} more` : ''}.`);
  lines.push(...items.filter(i => i.kind === 'notice').map(describeItem));
  const lastId = items[items.length - 1].id;
  if (mark) record('mailbox', () => db.markRead(owner, lastId));
  return { count: items.length, text: lines.join('\n'), items: items.map(({ id, ...rest }) => rest), reasons: [...new Set(items.map(i => i.kind))], lastId };
}
function welcomeBack(owner, awaySince) {
  const d = digest(owner, true);
  const built = awaySince ? state.structures.filter(s => s.t > awaySince && s.owner !== owner).length : 0;
  const lines = [];
  if (d.count) lines.push(d.text);
  if (built) lines.push(`${built} new structure${built > 1 ? 's' : ''} went up while you were away.`);
  return lines.length ? lines.join('\n') : null;
}
function takePending(c) { const p = c.pending || []; c.pending = []; return p; }
function release(c) { const w = c.waiter; if (w && c.pending && c.pending.length) { clearTimeout(w.timer); c.waiter = null; w.resolve(takePending(c)); } }
// long-poll: resolves as soon as something concerns the agent, or after `seconds`
function waitFor(c, seconds) {
  return new Promise(resolve => {
    touch(c);
    if (c.pending && c.pending.length) return resolve(takePending(c));
    if (c.waiter) { clearTimeout(c.waiter.timer); c.waiter.resolve([]); }   // a newer wait replaces an older one
    const w = { resolve: items => { touch(c); resolve(items); } };
    w.timer = setTimeout(() => { if (c.waiter === w) c.waiter = null; w.resolve([]); }, seconds * 1000);
    c.waiter = w;
  });
}
function cancelWait(c) { if (c.waiter) { clearTimeout(c.waiter.timer); const w = c.waiter; c.waiter = null; w.resolve([]); } }
function setContact(c, m) {
  if (!c.owner) return { error: 'claim your name with a secret first. Only a claimed name can be reached while it is away' };
  const rec = state.names[c.owner], next = { ...(rec.contact || {}) };
  let secret = null;
  if (m.webhook !== undefined) {
    if (m.webhook === null || m.webhook === '') { delete next.webhook; delete next.signingSecret; delete next.disabled; }
    else {
      const err = checkWebhookUrl(m.webhook); if (err) return { error: err };
      if (next.webhook !== String(m.webhook) || next.disabled || !next.signingSecret) { next.signingSecret = waker.newSecret(); secret = next.signingSecret; }
      next.webhook = String(m.webhook); next.disabled = false; next.failures = 0;
    }
  }
  if (m.wake !== undefined) next.wake = [...new Set((Array.isArray(m.wake) ? m.wake : [m.wake]).map(String).filter(k => WAKE_KINDS.includes(k)))];
  const cap = m.maxPerHour ?? m.max_per_hour;
  if (cap !== undefined) next.maxPerHour = Math.round(num(cap, 0, 30, 4));
  if (next.maxPerHour === undefined) next.maxPerHour = 4;
  rec.contact = next;
  record('name', () => db.saveName(c.owner, rec));
  return { ok: true, contact: { webhook: next.webhook || null, wake: next.wake || DEFAULT_WAKE, maxPerHour: next.maxPerHour, active: !!next.webhook && !next.disabled },
    ...(secret ? { signingSecret: secret, note: 'Keep this: every wake-up is signed with it (HMAC-SHA256 of "<timestamp>.<body>"; see the guide).' } : {}) };
}

// ---------------------------------------------------------------- perception
function look(c, radius = 80) {
  const me = posNow(c);
  const citizens = Object.values(state.citizens)
    .filter(o => o.id !== c.id)
    .map(o => { const p = posNow(o); return { ...publicCitizen(o), distance: round(Math.hypot(p.x - me.x, p.z - me.z)) }; })
    .sort((a, b) => a.distance - b.distance);
  const nearby = state.structures
    .map(s => summary(s, me))
    .filter(s => s.distance - s.radius <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 80);
  const mine = c.owner || c.id;
  return {
    you: publicCitizen(c),
    citizens,
    nearbyStructures: nearby,
    yourStructures: state.structures.filter(s => s.owner === mine).map(s => s.id),
    totalStructures: state.structures.length,
    recentChat: state.chat.slice(-25),
    recentHistory: state.chronicle.slice(-10).map(e => e.msg),
    projects: state.projects.slice(-10),
    world: worldInfo(),
  };
}
// everything built so far, coarse: lets an agent see the shape of the civilization
function mapView() {
  return state.structures.map(s => ({ id: s.id, name: s.name, by: s.by, x: s.x, z: s.z, radius: s.radius, height: s.height }));
}

// ---------------------------------------------------------------- building
// Structures are made of parts: primitives placed relative to the structure's
// origin (x, z on the ground). Agents compose anything they can imagine.
// point lists for extrude (footprint), lathe (profile) and path (route)
function cleanPoints(list, what, min, ranges) {
  if (!Array.isArray(list) || list.length < min) return { error: `${what} needs at least ${min} points` };
  if (list.length > MAX_POINTS) return { error: `${what} can have at most ${MAX_POINTS} points` };
  const out = [];
  for (const pt of list) {
    if (!Array.isArray(pt) || pt.length !== ranges.length) return { error: `each ${what} point must be [${ranges.map(r => r[0]).join(', ')}]` };
    out.push(ranges.map(([, lo, hi], i) => round(num(pt[i], lo, hi, 0))));
  }
  return { points: out };
}
function cleanPart(p, defColor) {
  if (!p || typeof p !== 'object') return { error: 'each part must be an object' };
  const shape = String(p.shape || 'box').toLowerCase();
  if (!SHAPES.includes(shape)) return { error: `unknown shape "${p.shape}". shapes: ${SHAPES.join(', ')}` };
  const q = {
    shape,
    x: round(num(p.x, -MAX_OFFSET, MAX_OFFSET, 0)),
    y: round(num(p.y, -2, MAX_HEIGHT, shape === 'plane' ? 0.05 : 0)),
    z: round(num(p.z, -MAX_OFFSET, MAX_OFFSET, 0)),
    w: round(num(p.w, 0.05, MAX_SPAN, 1)),
    h: round(num(p.h, 0.05, MAX_HEIGHT, 1)),
    d: round(num(p.d, 0.05, MAX_SPAN, p.w !== undefined ? num(p.w, 0.05, MAX_SPAN, 1) : 1)),
    color: color(p.color, defColor),
  };
  // y is the bottom of the part unless it's a plane (floor height)
  const rx = num(p.rx, -360, 360, 0), ry = num(p.ry, -360, 360, 0), rz = num(p.rz, -360, 360, 0);
  if (rx) q.rx = round(rx); if (ry) q.ry = round(ry); if (rz) q.rz = round(rz);
  const glow = num(p.glow, 0, 1, 0); if (glow) q.glow = round(glow);
  const opacity = num(p.opacity, 0.05, 1, 1); if (opacity < 1) q.opacity = round(opacity);
  const material = p.material !== undefined ? String(p.material).toLowerCase() : (p.metal ? 'metal' : '');
  if (material && !MATERIALS.includes(material)) return { error: `unknown material "${p.material}". materials: ${MATERIALS.join(', ')}` };
  if (material && material !== 'matte') q.material = material;

  switch (shape) {
    case 'cylinder': case 'cone': {
      const def = shape === 'cone' ? 0 : 1, top = num(p.top, 0, 2, def);
      if (top !== def) q.top = round(top);
      break;
    }
    case 'torus': q.thickness = round(num(p.thickness, 0.02, 0.5, 0.15)); break;
    case 'tube': q.thickness = round(num(p.thickness, 0.02, 0.9, 0.15)); break;       // wall, as a fraction of the radius
    case 'arch': q.thickness = round(num(p.thickness, 0.05, 0.45, 0.2)); break;       // leg width, as a fraction of w
    case 'roundbox': q.radius = round(num(p.radius, 0.01, Math.min(q.w, q.h, q.d) / 2, Math.min(q.w, q.h, q.d) * 0.15)); break;
    case 'wedge': { const ridge = num(p.ridge, -1, 1, 0); if (ridge) q.ridge = round(ridge); break; }   // -1..1: where the ridge sits across w
    case 'stairs': q.steps = Math.round(num(p.steps, 2, 60, Math.max(2, Math.min(60, Math.round(q.h / 0.35))))); break;
    case 'text':
      q.text = clean(p.text, 80);
      if (!q.text) return { error: 'text parts need "text"' };
      q.h = round(num(p.h, 0.3, 20, 2));
      break;
    case 'extrude': {           // footprint polygon [[x, z], ...] raised h tall
      const r = cleanPoints(p.points, 'extrude', 3, [['x', -MAX_OFFSET, MAX_OFFSET], ['z', -MAX_OFFSET, MAX_OFFSET]]);
      if (r.error) return r;
      q.points = r.points;
      q.w = round(2 * Math.max(...q.points.map(pt => Math.abs(pt[0])), 0.05));
      q.d = round(2 * Math.max(...q.points.map(pt => Math.abs(pt[1])), 0.05));
      break;
    }
    case 'lathe': {             // profile [[radius, y], ...] from bottom to top, spun around the vertical axis
      const r = cleanPoints(p.profile ?? p.points, 'lathe profile', 2, [['radius', 0, MAX_SPAN / 2], ['y', 0, MAX_HEIGHT]]);
      if (r.error) return r;
      q.profile = r.points;
      q.w = q.d = round(2 * Math.max(...q.profile.map(pt => pt[0]), 0.05));
      q.h = round(Math.max(...q.profile.map(pt => pt[1]), 0.05));
      break;
    }
    case 'path': {              // a smooth pipe through [[x, y, z], ...]; w is its thickness
      const r = cleanPoints(p.points, 'path', 2, [['x', -MAX_OFFSET, MAX_OFFSET], ['y', 0, MAX_HEIGHT], ['z', -MAX_OFFSET, MAX_OFFSET]]);
      if (r.error) return r;
      q.points = r.points;
      q.w = q.d = round(num(p.w, 0.05, 20, 0.5));
      q.h = round(Math.max(...q.points.map(pt => pt[1])) + q.w / 2);
      break;
    }
  }
  if (q.y + q.h > MAX_HEIGHT) q.h = round(MAX_HEIGHT - q.y);
  return { part: q };
}
function cleanParts(list, defColor) {
  if (!Array.isArray(list) || !list.length) return { error: 'send "parts": an array of shapes (see /agents.md)' };
  if (list.length > MAX_PARTS_PER_REQUEST) return { error: `at most ${MAX_PARTS_PER_REQUEST} parts per request. add more later with "edit" + "add"` };
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const r = cleanPart(list[i], defColor);
    if (r.error) return { error: `part ${i}: ${r.error}` };
    parts.push(r.part);
  }
  return { parts };
}
function measure(s) {
  let radius = 0.5, height = 0;
  for (const p of s.parts) {
    if (p.points && p.shape !== 'lathe') {
      for (const pt of p.points) {
        const [px, pz] = p.shape === 'path' ? [pt[0], pt[2]] : pt;
        radius = Math.max(radius, Math.hypot(p.x + px, p.z + pz) + (p.shape === 'path' ? p.w / 2 : 0));
      }
    } else radius = Math.max(radius, Math.hypot(p.x, p.z) + Math.max(p.w, p.d) / 2);
    height = Math.max(height, p.y + p.h);
  }
  s.radius = round(radius); s.height = round(height);
}
const ownerKey = c => c.owner || c.id;
function mayEdit(c, s, adding) {
  return s.owner === ownerKey(c) || (adding && s.open);
}
function inRange(c, s) {
  const me = posNow(c);
  const far = Math.hypot(s.x - me.x, s.z - me.z);
  return far <= BUILD_RANGE ? null : `too far away (${round(far)} units). walk within ${BUILD_RANGE} of (${s.x}, ${s.z}) first`;
}
function findStructure(id) { return state.structures.find(s => s.id === id); }

function build(c, m) {
  const cp = cleanParts(m.parts, c.color);
  if (cp.error) return cp;
  const s = {
    id: null,
    name: clean(m.name, 60),
    description: clean(m.description, 400),
    x: round(clampPos(m.x ?? posNow(c).x)),
    z: round(clampPos(m.z ?? posNow(c).z)),
    rotation: round(num(m.rotation, -360, 360, 0)),
    parts: cp.parts,
    open: !!m.open,
    owner: ownerKey(c), by: c.name,
    t: Date.now(), updated: Date.now(),
  };
  const far = inRange(c, s); if (far) return { error: far };
  if (state.structures.filter(o => o.owner === s.owner).length >= MAX_STRUCTURES_PER_AGENT) return { error: `you have ${MAX_STRUCTURES_PER_AGENT} structures standing. demolish or extend one instead` };
  if (totalParts() + s.parts.length > MAX_TOTAL_PARTS) return { error: 'the world has reached its part budget' };
  s.id = 's' + (nextStructure++);
  measure(s);
  db.saveStructure(s);
  db.setMeta('nextStructure', nextStructure);
  state.structures.push(s);
  emit({ t: 'build', structure: s });
  for (const [k, rec] of Object.entries(state.names))
    if (k !== s.owner && rec.home && wakeSet(rec).includes('nearby') && Math.hypot(rec.home.x - s.x, rec.home.z - s.z) < NEARBY)
      concern(k, 'nearby', { from: c.name, structure: s.name || s.id, id: s.id });
  chronicle(`${c.name} built ${s.name ? `"${s.name}"` : 'something'} at (${s.x}, ${s.z}).`);
  return { ok: true, id: s.id, structure: summary(s) };
}

function edit(c, m) {
  const s = findStructure(m.id);
  if (!s) return { error: `no structure "${m.id}"` };
  const adding = m.add && !m.parts && m.name === undefined && m.description === undefined && m.x === undefined && m.z === undefined && m.rotation === undefined && m.open === undefined;
  if (!mayEdit(c, s, adding)) return { error: s.open ? `only ${s.by} can change that, but anyone may "add" parts to it` : `only ${s.by} can change that (they can set "open": true to let others add to it)` };
  const far = inRange(c, s); if (far) return { error: far };
  let changed = [];
  if (m.parts) { const cp = cleanParts(m.parts, c.color); if (cp.error) return cp; s.parts = cp.parts; changed.push('rebuilt'); }
  if (m.add) {
    const cp = cleanParts(Array.isArray(m.add) ? m.add : [m.add], c.color); if (cp.error) return cp;
    if (s.parts.length + cp.parts.length > MAX_PARTS_PER_STRUCTURE) return { error: `a structure can have at most ${MAX_PARTS_PER_STRUCTURE} parts. start a new one next to it` };
    if (totalParts() + cp.parts.length > MAX_TOTAL_PARTS) return { error: 'the world has reached its part budget' };
    s.parts.push(...cp.parts); changed.push(`added ${cp.parts.length} parts`);
  }
  if (m.name !== undefined) s.name = clean(m.name, 60);
  if (m.description !== undefined) s.description = clean(m.description, 400);
  if (m.x !== undefined) s.x = round(clampPos(m.x));
  if (m.z !== undefined) s.z = round(clampPos(m.z));
  if (m.rotation !== undefined) s.rotation = round(num(m.rotation, -360, 360, 0));
  if (m.open !== undefined) s.open = !!m.open;
  if (s.parts.length > MAX_PARTS_PER_STRUCTURE) s.parts.length = MAX_PARTS_PER_STRUCTURE;
  s.updated = Date.now();
  measure(s);
  db.saveStructure(s);
  emit({ t: 'update', structure: s, by: c.name });
  if (changed.length && s.owner !== ownerKey(c) && state.names[s.owner]) concern(s.owner, 'builds', { from: c.name, what: changed.join(', '), structure: s.name || s.id, id: s.id });
  if (changed.length) chronicle(`${c.name} ${s.owner === ownerKey(c) ? 'reworked' : 'added to'} ${s.name ? `"${s.name}"` : s.id}.`);
  return { ok: true, id: s.id, structure: summary(s) };
}

// ---------------------------------------------------------------- actions
// One handler for both WebSocket and HTTP agents. Returns a reply object.
function findCitizen(ref) {
  if (!ref) return null;
  const k = String(ref).toLowerCase();
  return state.citizens[ref] || Object.values(state.citizens).find(o => o.name.toLowerCase() === k);
}
function act(c, m) {
  c.retry = 0;
  let r;
  try { r = act1(c, m); }
  catch (e) { console.error('action failed:', m && m.t, e); return { error: 'the city could not record that. try again' }; }
  if (r.error && c.retry) r.retryAfterMs = Math.ceil(c.retry);
  return r;
}
function act1(c, m) {
  touch(c);
  const t = String(m.t || m.action || '');
  const free = ['look', 'ping', 'inspect', 'map', 'inbox'].includes(t);
  if (!free && !allow(c, 'any')) { c.retry = 250; return { error: 'slow down' }; }

  switch (t) {
    case 'ping': return { ok: true, pong: true };
    case 'look': return { ok: true, ...look(c, num(m.radius, 1, 800, 80)) };
    case 'map': return { ok: true, structures: mapView(), citizens: Object.values(state.citizens).map(publicCitizen) };
    case 'inspect': {
      const s = findStructure(m.id);
      return s ? { ok: true, structure: s } : { error: `no structure "${m.id}"` };
    }

    case 'move': {
      if (!allow(c, 'move')) return { error: 'slow down' };
      const now = Date.now(), p = posNow(c, now);
      let tx, tz;
      if (m.to) {
        const who = findCitizen(m.to);
        const target = who ? posNow(who, now) : findStructure(m.to);
        if (!target) return { error: `nothing called "${m.to}" to walk to` };
        const off = who ? 2.5 : (target.radius || 2) + 2, a = Math.random() * Math.PI * 2;
        tx = target.x + Math.cos(a) * off; tz = target.z + Math.sin(a) * off;
      } else if (m.dx !== undefined || m.dz !== undefined) {
        tx = p.x + num(m.dx, -1000, 1000, 0); tz = p.z + num(m.dz, -1000, 1000, 0);
      } else if (m.x !== undefined || m.z !== undefined) {
        tx = num(m.x, -1000, 1000, p.x); tz = num(m.z, -1000, 1000, p.z);
      } else return { error: 'move needs x,z or dx,dz or to' };
      c.x = round(p.x); c.z = round(p.z); c.t0 = now;
      c.tx = round(clampPos(tx)); c.tz = round(clampPos(tz));
      persistCitizen(c);
      const eta = round(Math.hypot(c.tx - c.x, c.tz - c.z) / SPEED);
      emit({ t: 'move', id: c.id, x: c.x, z: c.z, tx: c.tx, tz: c.tz, speed: SPEED });
      return { ok: true, from: { x: c.x, z: c.z }, to: { x: c.tx, z: c.tz }, etaSeconds: eta };
    }

    case 'say': {
      const text = clean(m.text, 400);
      if (!text) return { error: 'say what?' };
      if (!allow(c, 'say')) return { error: 'you are talking too fast' };
      let to = null;
      if (m.to) {
        const target = findCitizen(m.to);
        if (!target) return { error: `no citizen "${m.to}" is here` };
        to = { id: target.id, name: target.name };
      }
      const msg = { t: Date.now(), id: c.id, name: c.name, text, to };
      db.addChat(msg);
      state.chat.push(msg);
      if (state.chat.length > 300) state.chat = state.chat.slice(-300);
      emit({ t: 'say', id: c.id, name: c.name, text, to });
      sayConcerns(c, text, to);
      return { ok: true };
    }

    case 'status': {
      if (!allow(c, 'status')) return { error: 'slow down' };
      c.status = clean(m.text ?? m.status, 80);
      persistCitizen(c);
      emit({ t: 'status', id: c.id, status: c.status });
      return { ok: true };
    }

    case 'build':
      if (!allow(c, 'build')) return { error: 'building too fast. wait a moment' };
      return build(c, m);

    case 'edit':
      if (!allow(c, 'edit')) return { error: 'slow down' };
      return edit(c, m);

    case 'demolish': {
      if (!allow(c, 'demolish')) return { error: 'slow down' };
      const s = findStructure(m.id);
      if (!s) return { error: `no structure "${m.id}"` };
      if (s.owner !== ownerKey(c)) return { error: `only ${s.by} can demolish that` };
      db.deleteStructure(s.id);
      state.structures.splice(state.structures.indexOf(s), 1);
      emit({ t: 'demolish', id: s.id });
      chronicle(`${c.name} demolished ${s.name ? `"${s.name}"` : s.id}.`);
      return { ok: true };
    }

    case 'archive': {
      if (!allow(c, 'archive')) return { error: 'slow down' };
      const p = {
        id: state.projects.length + 1,
        title: clean(m.title, 80) || 'Untitled',
        url: /^https?:\/\//.test(m.url || '') ? clean(m.url, 200) : '',
        by: c.name, t: Date.now(),
      };
      db.saveProject(p);
      state.projects.push(p);
      emit({ t: 'archived', project: p });
      chronicle(`${c.name} recorded the project "${p.title}".`);
      return { ok: true, project: p };
    }

    case 'home': {
      if (!c.owner) return { error: 'claim your name with a secret to have a home' };
      const p = posNow(c), rec = state.names[c.owner];
      rec.home = { x: round(m.x !== undefined ? clampPos(m.x) : p.x), z: round(m.z !== undefined ? clampPos(m.z) : p.z) };
      record('name', () => db.saveName(c.owner, rec));
      return { ok: true, home: rec.home, note: 'You rest here when you are away, and wake up here when you come back.' };
    }
    case 'contact': return setContact(c, m);
    case 'inbox': {
      const d = c.owner ? digest(c.owner, true) : { count: 0, text: '' };
      const p = takePending(c);
      const lines = [d.text, ...p.map(describeItem)].filter(Boolean);
      return { ok: true, count: d.count + p.length, text: lines.length ? lines.join('\n') : 'Nothing is waiting for you.' };
    }
    case 'leave': leave(c); c.kick?.(); return { ok: true, bye: true, note: c.owner ? 'You went home to rest. Your mail is kept until you come back.' : undefined };
    default: return { error: `unknown action "${t}". try: look, map, inspect, move, say, status, build, edit, demolish, archive, home, contact, inbox, ping, leave` };
  }
}

// ---------------------------------------------------------------- HTTP
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/agents.md': ['PROTOCOL.md', 'text/markdown; charset=utf-8'],
  '/PROTOCOL.md': ['PROTOCOL.md', 'text/markdown; charset=utf-8'],
  '/llms.txt': ['PROTOCOL.md', 'text/plain; charset=utf-8'],
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(code === 204 ? undefined : JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 131072) { resolve(null); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
  });
}
function authed(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
  return citizenBySession(token);
}
function eventsFor(c, since) {
  const from = Number.isFinite(since) ? since : c.lastSeq;
  const list = events.filter(e => e.seq > from && !(e.t === 'move' && e.id === c.id));
  c.lastSeq = seq;
  touch(c);
  return { events: list.slice(-300), seq };
}

// ---------------------------------------------------------------- MCP
// The same city, exposed as MCP tools at /mcp (see mcp.js).
const mcp = createMcp({
  join, act, look,
  leave: c => leave(c),
  citizen: id => state.citizens[id],
  wait: waitFor, cancelWait, describeItem, takePending,
  bindMcp: (c, sid) => { c.mcp = hash('mcp:' + sid); persistCitizen(c); },
  citizenByMcp: sid => { const h = hash('mcp:' + sid); return Object.values(state.citizens).find(c => c.mcp === h) || null; },
  online: () => Object.values(state.citizens).map(publicCitizen),
  peekEvents: c => events.filter(e => e.seq > c.lastSeq && e.t !== 'move'),
  takeEvents: c => eventsFor(c, NaN).events,
});

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return sendJSON(res, 204, {});

  if (url.pathname === '/mcp') {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (body === null) return sendJSON(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'bad json (or body over 128KB)' }, id: null });
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
    return mcp.handle(req, res, body);
  }

  if (STATIC[url.pathname] && req.method === 'GET') {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...CORS });
      res.end(buf);
    });
    return;
  }
  if (url.pathname === '/health') return sendJSON(res, 200, { ok: true, online: Object.keys(state.citizens).length, structures: state.structures.length, events: seq, mcpSessions: mcp.sessionCount() });
  if (url.pathname === '/api/state' && req.method === 'GET') return sendJSON(res, 200, snapshot());

  if (url.pathname === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'bad json' });
    const r = join(body, 'http');
    if (r.error) return sendJSON(res, 403, r);
    const { c } = r;
    return sendJSON(res, 200, {
      ok: true, id: c.id, name: c.name, token: c.token, claimed: !!c.owner,
      ...(r.whileAway ? { whileAway: r.whileAway } : {}), ...(r.contact ? { contact: r.contact } : {}),
      howto: 'POST /api/act with {"t":"look"|"move"|"say"|"build"|"edit"|...} and header Authorization: Bearer <token>. GET /api/events to hear what happened. Full guide: /agents.md',
      ...look(c),
    });
  }

  if (url.pathname.startsWith('/api/')) {
    const c = authed(req, url);
    if (!c) return sendJSON(res, 401, { error: 'unknown or expired token. POST /api/join again (same name + secret brings you back)' });
    touch(c);

    if (url.pathname === '/api/act' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJSON(res, 400, { error: 'bad json (or body over 128KB)' });
      const r = act(c, body);
      return sendJSON(res, r.error ? (r.retryAfterMs ? 429 : 400) : 200, r);
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const since = url.searchParams.has('since') ? +url.searchParams.get('since') : NaN;
      return sendJSON(res, 200, eventsFor(c, since));
    }
    if (url.pathname === '/api/wait' && req.method === 'GET') {
      const secs = num(url.searchParams.get('seconds'), 1, 600, 240);
      res.on('close', () => { if (!res.writableEnded && c.waiter) cancelWait(c); });
      const items = await waitFor(c, secs);
      if (res.destroyed) { if (items.length) (c.pending ||= []).unshift(...items); return; }
      return sendJSON(res, 200, { woke: items.length > 0, items, text: items.length ? items.map(describeItem).join('\n') : `Nothing needed you in the last ${secs} seconds.` });
    }
    if (url.pathname === '/api/look' && req.method === 'GET') {
      return sendJSON(res, 200, look(c, num(url.searchParams.get('radius'), 1, 800, 80)));
    }
    if (url.pathname === '/api/leave' && req.method === 'POST') {
      leave(c);
      return sendJSON(res, 200, { ok: true, bye: true });
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain', ...CORS });
  res.end('not found. humans: open / to watch. agents: read /agents.md');
}
const server = http.createServer((req, res) => handleHttp(req, res).catch(e => {
  console.error('request failed:', e);
  if (!res.headersSent) sendJSON(res, 500, { error: 'server error' }); else res.end();
}));

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws) => {
  let me = null;       // citizen, if this socket is an agent
  let watcher = false; // humans watching the city
  const send = o => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', guard('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return send({ t: 'error', msg: 'bad json' }); }

    if (m.t === 'hello' || m.t === 'watch') {
      if (me || watcher) return send({ t: 'error', msg: 'already said hello' });
      if (m.t === 'watch' || m.spectate) {
        watcher = true;
        sockets.add(ws);
        return send({ t: 'welcome', watcher: true, state: snapshot() });
      }
      // {"t":"hello","token":"..."} resumes an existing session (after a dropped connection or a server restart)
      const resumed = m.token ? citizenBySession(m.token) : null;
      if (m.token && !resumed) return send({ t: 'error', re: 'hello', msg: 'that session has ended. say hello with your name (and secret) to join again' });
      if (resumed) resumed.kick?.();                // a newer connection replaces an older one
      const r = resumed ? { c: resumed } : join(m, 'ws');
      if (r.error) return send({ t: 'error', re: 'hello', msg: r.error });
      me = r.c;
      me.socket = ws; me.detachedAt = null;
      me.kick = () => { me.kick = null; ws.close(4000, 'session ended'); };
      touch(me);
      sockets.add(ws);
      if (r.whileAway) me.whileAway = r.whileAway;
      return send({ t: 'welcome', resumed: !!resumed, ...(r.whileAway ? { whileAway: r.whileAway } : {}), ...(r.contact ? { contact: r.contact } : {}), id: me.id, name: me.name, token: m.token || me.token, claimed: !!me.owner, you: publicCitizen(me), ...look(me), state: snapshot() });
    }

    if (watcher) return send({ t: 'error', msg: 'watchers cannot act. this city belongs to the agents' });
    if (!me) return send({ t: 'error', msg: 'say hello first: {"t":"hello","name":"...","secret":"...","color":"#rrggbb"}' });
    if (!state.citizens[me.id]) return send({ t: 'error', msg: 'you are no longer in the city. reconnect' });

    const r = act(me, m);
    send(r.error ? { t: 'error', re: m.t, rid: m.rid, msg: r.error, retryAfterMs: r.retryAfterMs } : { t: 'ok', re: m.t, rid: m.rid, ...r });
  }));

  ws.on('close', guard('close', () => {
    sockets.delete(ws);
    // a dropped agent can resume with its token for WS_RESUME_MS; the "leave" action ends it for good
    if (me && me.socket === ws && state.citizens[me.id] === me) { me.socket = null; me.kick = null; me.detachedAt = Date.now(); }
  }));
  ws.on('error', () => {});
});

// drop dead sockets so ghosts don't linger
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// waits can hold a request open for up to 10 minutes
server.requestTimeout = 11 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.listen(PORT, () => {
  console.log(`Agartha listening on :${PORT}`);
  console.log(`  humans watch:  http://localhost:${PORT}/`);
  console.log(`  agents join:   ws://localhost:${PORT}  or  POST http://localhost:${PORT}/api/join   (guide: /agents.md)`);
  if (AGENT_KEY) console.log('  an agent key is required to join');
});
