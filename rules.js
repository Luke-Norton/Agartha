'use strict';
// A bounded, declarative rules engine. Definitions are author-only; players
// receive descriptions and action names, never conditions or answer checks.
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;
const TYPES = ['escape', 'game', 'realm'];
const clone = v => structuredClone(v);
const fail = message => { throw new Error(message); };
const id = (v, label) => { if (typeof v !== 'string' || !ID.test(v)) fail(`${label}: use a letter followed by up to 47 letters, numbers, _ or -`); return v; };
const text = (v, max = 800) => { if (typeof v !== 'string' || v.length > max) fail(`text must be a string of at most ${max} characters`); return v; };
const scalar = v => typeof v === 'boolean' || typeof v === 'string' && v.length <= 200 || typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
function unique(list, label) {
  if (!Array.isArray(list)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const o of list) { id(o.id, label); if (seen.has(o.id)) fail(`duplicate ${label} id ${o.id}`); seen.add(o.id); }
  return seen;
}
function validateCondition(c, refs, depth = 0) {
  if (c === undefined || typeof c === 'boolean') return;
  if (!c || typeof c !== 'object' || Array.isArray(c) || depth > 6) fail('invalid or overly nested condition');
  const keys = Object.keys(c);
  if (keys.length !== 1) fail('a condition must contain exactly one operator');
  const op = keys[0], v = c[op];
  if (op === 'all' || op === 'any') {
    if (!Array.isArray(v) || !v.length || v.length > 16) fail('all/any require 1..16 conditions');
    v.forEach(x => validateCondition(x, refs, depth + 1));
  } else if (op === 'not') validateCondition(v, refs, depth + 1);
  else if (op === 'flag') { if (!refs.flags.has(v)) fail(`unknown flag ${v}`); }
  else if (op === 'has') { if (!refs.items.has(v)) fail(`unknown item ${v}`); }
  else if (op === 'room') { if (!refs.rooms.has(v)) fail(`unknown room ${v}`); }
  else if (op === 'answer') text(v, 200);
  else if (op === 'counter') {
    if (!v || !refs.counters.has(v.id) || !['eq', 'gte', 'lte'].includes(v.op) || !scalar(v.value) || typeof v.value !== 'number') fail('invalid counter condition');
  } else if (op === 'team') { if (!refs.teams.has(v)) fail(`unknown team ${v}`); }
  else if (op === 'turn') { if (v !== true) fail('turn condition must be true'); }
  else fail(`unknown condition ${op}`);
}
function validateEffects(effects, refs) {
  if (!Array.isArray(effects) || !effects.length || effects.length > 16) fail('effects must contain 1..16 operations');
  for (const e of effects) {
    if (!e || typeof e !== 'object') fail('invalid effect');
    switch (e.op) {
      case 'flag': if (!refs.flags.has(e.id) || typeof e.value !== 'boolean') fail('invalid flag effect'); break;
      case 'counter': if (!refs.counters.has(e.id) || !Number.isInteger(e.add) || Math.abs(e.add) > 1000) fail('invalid counter effect'); break;
      case 'give': case 'take': if (!refs.items.has(e.item)) fail('invalid inventory effect'); break;
      case 'teleport': if (!refs.rooms.has(e.room)) fail('invalid teleport effect'); break;
      case 'message': text(e.text, 400); break;
      case 'score': if (!Number.isInteger(e.add) || Math.abs(e.add) > 1000) fail('invalid score effect'); break;
      case 'finish': if (e.text !== undefined) text(e.text, 400); break;
      case 'next_turn': break;
      default: fail(`unknown effect ${e.op}`);
    }
  }
}
function validateDefinition(input, cleanStructure) {
  if (!input || typeof input !== 'object' || JSON.stringify(input).length > 110000) fail('definition must be an object under 110KB');
  const d = clone(input);
  if (!TYPES.includes(d.kind)) fail('kind must be escape, game or realm');
  d.title = text(d.title, 80); if (!d.title.trim()) fail('title is required');
  d.description = text(d.description || '', 800);
  d.goal = text(d.goal || '', 400);
  d.engine = d.engine || 'rules';
  if (!['rules', 'connect_four'].includes(d.engine) || d.engine === 'connect_four' && d.kind !== 'game') fail('unsupported engine');
  d.persistent = d.kind === 'realm';
  d.minPlayers = d.engine === 'connect_four' ? 2 : d.minPlayers ?? 1;
  d.maxPlayers = d.engine === 'connect_four' ? 2 : d.maxPlayers ?? 4;
  if (!Number.isInteger(d.minPlayers) || !Number.isInteger(d.maxPlayers) || d.minPlayers < 1 || d.maxPlayers < d.minPlayers || d.maxPlayers > 16) fail('player limits must be integers from 1..16');
  d.turnBased = d.engine === 'connect_four' || !!d.turnBased;
  d.turnSeconds = d.turnSeconds ?? 0;
  if (!Number.isInteger(d.turnSeconds) || d.turnSeconds < 0 || d.turnSeconds > 86400 || d.turnSeconds > 0 && d.turnSeconds < 30) fail('turnSeconds is 0 (no deadline), or 30..86400');
  d.building = d.building || 'owner';
  if (!['owner', 'members', 'collaborators'].includes(d.building)) fail('building must be owner, members or collaborators');
  d.rooms = d.rooms || [{ id: 'entry', name: 'Entry', x: 0, z: 0, w: 100, d: 100, description: '', exits: [] }];
  if (!d.rooms.length || d.rooms.length > 64) fail('a world needs 1..64 rooms');
  const refs = { rooms: unique(d.rooms, 'room'), items: new Set(), flags: new Set(), counters: new Set(), teams: new Set() };
  d.entry = d.entry || d.rooms[0].id;
  if (!refs.rooms.has(d.entry)) fail('entry must name a room');
  d.items = d.items || []; if (d.items.length > 128) fail('at most 128 items'); refs.items = unique(d.items, 'item');
  for (const i of d.items) { i.name = text(i.name || i.id, 80); i.description = text(i.description || '', 400); }
  d.flags = d.flags || []; if (d.flags.length > 128) fail('at most 128 flags'); refs.flags = unique(d.flags, 'flag');
  for (const f of d.flags) { if (typeof f.initial !== 'boolean') fail('flags need a boolean initial value'); f.public = !!f.public; }
  d.counters = d.counters || []; if (d.counters.length > 128) fail('at most 128 counters'); refs.counters = unique(d.counters, 'counter');
  for (const c of d.counters) { if (!Number.isInteger(c.initial) || Math.abs(c.initial) > 1e6) fail('invalid counter initial value'); c.public = !!c.public; }
  d.teams = d.teams || []; if (d.teams.length > 8) fail('at most 8 teams');
  refs.teams = new Set(d.teams.map(t => id(t, 'team'))); if (refs.teams.size !== d.teams.length) fail('duplicate team');
  for (let i = 0; i < d.rooms.length; i++) {
    const r = d.rooms[i]; r.name = text(r.name || r.id, 80); r.description = text(r.description || '', 800);
    for (const k of ['x', 'z', 'w', 'd']) if (!Number.isFinite(r[k]) || Math.abs(r[k]) > 1000 || ['w', 'd'].includes(k) && r[k] < 2) fail('rooms need x,z,w,d; coordinates within ±1000, dimensions 2..1000');
    if (Math.abs(r.x) + r.w / 2 > 1000 || Math.abs(r.z) + r.d / 2 > 1000) fail('room extends past world boundary');
    for (const other of d.rooms.slice(0, i)) if (Math.abs(r.x - other.x) < (r.w + other.w) / 2 && Math.abs(r.z - other.z) < (r.d + other.d) / 2) fail('rooms must not overlap');
    r.exits = r.exits || []; if (!Array.isArray(r.exits) || r.exits.length > 32) fail('at most 32 exits per room');
    for (const e of r.exits) { if (!refs.rooms.has(e.to)) fail('exit points to an unknown room'); e.label = text(e.label || e.to, 80); validateCondition(e.when, refs); }
  }
  d.objects = d.objects || []; if (d.objects.length > 256) fail('at most 256 objects'); unique(d.objects, 'object');
  for (const o of d.objects) {
    if (!refs.rooms.has(o.room)) fail('object needs a room');
    o.name = text(o.name || o.id, 80); o.description = text(o.description || '', 800);
    const r = d.rooms.find(r => r.id === o.room); o.x = o.x ?? r.x; o.z = o.z ?? r.z;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.z) || Math.abs(o.x - r.x) > r.w / 2 || Math.abs(o.z - r.z) > r.d / 2) fail('object must be inside its room');
    validateCondition(o.visibleWhen, refs);
    o.actions = o.actions || []; if (o.actions.length > 16) fail('at most 16 actions per object'); unique(o.actions, 'action');
    for (const a of o.actions) {
      a.label = text(a.label || a.id, 80); a.input = a.input || 'none';
      if (!['none', 'answer'].includes(a.input)) fail('action input must be none or answer');
      if (a.once !== undefined && typeof a.once !== 'boolean') fail('once must be boolean');
      validateCondition(a.when, refs); validateEffects(a.effects, refs);
    }
  }
  d.structures = d.structures || []; if (d.structures.length > 80) fail('at most 80 scenery structures'); unique(d.structures, 'scenery');
  let parts = 0;
  d.structures = d.structures.map(s => {
    validateCondition(s.visibleWhen, refs);
    if (s.room && !refs.rooms.has(s.room)) fail('scenery names unknown room');
    const result = cleanStructure(s); parts += result.parts.length;
    return { ...result, id: s.id, room: s.room || null, visibleWhen: s.visibleWhen };
  });
  if (parts > 6000) fail('scenery exceeds 6000 parts');
  d.finishWhen = d.finishWhen ?? false; validateCondition(d.finishWhen, refs);
  // Rebuild from allowlisted keys so author data cannot become an accidental
  // spectator field through future spreading of the definition.
  return Object.fromEntries(['kind','title','description','goal','engine','persistent','minPlayers','maxPlayers','turnBased','turnSeconds','building','entry','rooms','items','flags','counters','teams','objects','structures','finishWhen'].map(k => [k, d[k]]));
}
function initialState(d) {
  return { flags: Object.fromEntries(d.flags.map(f => [f.id, f.initial])), counters: Object.fromEntries(d.counters.map(c => [c.id, c.initial])), inventory: [], used: [], board: Array(42).fill(0), turn: 0, outcome: null };
}
function condition(c, context) {
  if (c === undefined) return true;
  if (typeof c === 'boolean') return c;
  const [op, v] = Object.entries(c)[0], { state, player, players, answer } = context;
  switch (op) {
    case 'all': return v.every(x => condition(x, context));
    case 'any': return v.some(x => condition(x, context));
    case 'not': return !condition(v, context);
    case 'flag': return !!state.flags[v];
    case 'has': return state.inventory.includes(v);
    case 'room': return player?.room === v;
    case 'answer': return typeof answer === 'string' && answer.trim().toLocaleLowerCase('en-US') === v.trim().toLocaleLowerCase('en-US');
    case 'counter': return v.op === 'eq' ? state.counters[v.id] === v.value : v.op === 'gte' ? state.counters[v.id] >= v.value : state.counters[v.id] <= v.value;
    case 'team': return player?.team === v;
    case 'turn': return players[state.turn % Math.max(1, players.length)]?.owner === player?.owner;
    default: return false;
  }
}
function applyEffects(effects, ctx) {
  const { state, player, players, definition } = ctx, messages = [];
  for (const e of effects) {
    switch (e.op) {
      case 'flag': state.flags[e.id] = e.value; break;
      case 'counter': { const n = state.counters[e.id] + e.add; if (Math.abs(n) > 1e6) fail('counter limit exceeded'); state.counters[e.id] = n; break; }
      case 'give': if (!state.inventory.includes(e.item)) state.inventory.push(e.item); break;
      case 'take': { const at = state.inventory.indexOf(e.item); if (at < 0) fail('required item is missing'); state.inventory.splice(at, 1); break; }
      case 'teleport': { const r = definition.rooms.find(r => r.id === e.room); Object.assign(player, { room: r.id, x: r.x, z: r.z }); break; }
      case 'message': messages.push(e.text); break;
      case 'score': { const score = (player.score || 0) + e.add; if (Math.abs(score) > 1e6) fail('score limit exceeded'); player.score = score; break; }
      case 'next_turn': state.turn = (state.turn + 1) % Math.max(1, players.length); break;
      case 'finish': state.outcome = { text: e.text || 'Completed', winner: player.owner }; break;
    }
  }
  return messages;
}
function playConnectFour(session, player, column) {
  const { state, players } = session;
  if (!Number.isInteger(column) || column < 0 || column > 6) fail('column must be 0..6');
  if (players[state.turn]?.owner !== player.owner) fail('it is not your turn');
  let row = 5;
  while (row >= 0 && state.board[row * 7 + column]) row--;
  if (row < 0) fail('that column is full');
  const piece = state.turn + 1; state.board[row * 7 + column] = piece;
  for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = column + dc * sign;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && state.board[r * 7 + c] === piece) { count++; r += dr * sign; c += dc * sign; }
    }
    if (count >= 4) state.outcome = { text: `${player.name} won`, winner: player.owner };
  }
  if (!state.outcome && state.board.every(Boolean)) state.outcome = { text: 'Draw', winner: null };
  state.turn = 1 - state.turn;
}
module.exports = { validateDefinition, validateCondition, initialState, condition, applyEffects, playConnectFour, clone };
