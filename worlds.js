'use strict';
const crypto = require('crypto');
const rules = require('./rules');
const clone = rules.clone;
const fail = message => { throw new Error(message); };
const newId = prefix => prefix + crypto.randomBytes(10).toString('hex');
const str = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const ownerOf = c => { if (!c?.owner) fail('claim your name with a secret first'); return c.owner; };
const passwordHash = password => {
  if (typeof password !== 'string' || password.length < 4 || password.length > 200) fail('password must contain 4..200 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
};
const matchesPassword = (password, saved) => {
  if (!saved || typeof password !== 'string' || password.length > 200) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(password, saved.salt, 32), Buffer.from(saved.hash, 'hex'));
};
function createWorlds({ db, cleanStructure, checkPortal, notify, persistCitizen, names }) {
  const worlds = new Map(db.loadWorlds().map(w => [w.id, w]));
  const sessions = new Map(db.loadWorldSessions().map(s => [s.id, s]));
  const attempts = new Map();
  const interactions = new Map();
  const readWorld = id => { const w = worlds.get(id); if (!w) fail('world not found'); return w; };
  const editor = (w, c) => { const o = ownerOf(c); if (o !== w.owner && !w.collaborators.includes(o)) fail('only the owner or a collaborator can edit this world'); return o; };
  const isMember = (w, c) => !!c?.owner && (c.owner === w.owner || w.members.includes(c.owner) || w.collaborators.includes(c.owner));
  const readSession = (id, c, playerRequired = false) => {
    const s = sessions.get(id); if (!s) fail('session not found');
    const w = readWorld(s.world);
    if (s.test && c?.owner !== w.owner && !w.collaborators.includes(c?.owner)) fail('test sessions are private');
    if (!s.test && !isMember(w, c) && w.access !== 'open') fail('world membership required');
    const p = s.players.find(p => p.owner === c?.owner);
    if (playerRequired && (!p || p.departed || c.worldSession !== id)) fail('enter this session first');
    return { s, w, p };
  };
  const definition = s => readWorld(s.world).versions.find(v => v.number === s.version)?.definition || s.testDefinition;
  const commitWorld = w => { db.saveWorld(w); worlds.set(w.id, w); };
  function commitSession(s, event) {
    s.updated = Date.now(); s.revision++;
    if (event) {
      const e = { seq: s.revision, at: s.updated, ...event };
      s.events.push(e); if (s.events.length > 200) s.events.shift();
      db.saveWorldSession(s, e);
    } else db.saveWorldSession(s);
    sessions.set(s.id, s);
  }
  function publicWorld(w, c) {
    const d = w.versions.at(-1)?.definition;
    return { id: w.id, title: d?.title || w.draft?.title || w.title, description: d?.description || '', kind: d?.kind || w.kind,
      by: w.by, access: w.access, listed: w.listed, spectating: w.spectating, published: !!d,
      version: w.versions.at(-1)?.number || 0, portal: w.portal || null,
      member: isMember(w, c), editable: !!c?.owner && (c.owner === w.owner || w.collaborators.includes(c.owner)),
      minPlayers: d?.minPlayers, maxPlayers: d?.maxPlayers,
      sessions: [...sessions.values()].filter(s => s.world === w.id && !s.test && canWatch(s, c)).map(s => ({ id: s.id, status: s.status, players: s.players.length, version: s.version, updated: s.updated })) };
  }
  function canWatch(s, c) {
    const w = worlds.get(s.world); if (!w) return false;
    if (s.test) return !!c?.owner && (c.owner === w.owner || w.collaborators.includes(c.owner));
    if (w.spectating === 'public') return true;
    if (s.players.some(p => p.owner === c?.owner) && isMember(w, c)) return true;
    return w.spectating === 'members' && isMember(w, c);
  }
  function list(c) {
    return [...worlds.values()].filter(w => (w.listed && w.versions.length) || isMember(w, c)).map(w => publicWorld(w, c));
  }
  function context(s, p, answer) { return { definition: definition(s), state: s.state, player: p, players: s.players, answer }; }
  function publicView(s, c, spectator = false) {
    const d = definition(s), w = readWorld(s.world);
    const p = !spectator && s.players.find(p => p.owner === c?.owner);
    const contexts = p ? [context(s, p)] : s.players.map(p => context(s, p));
    if (!contexts.length) contexts.push(context(s, { room: d.entry }));
    const visible = condition => contexts.some(ctx => rules.condition(condition, ctx));
    const roomIds = p ? [p.room] : s.discovered;
    const objects = d.objects.filter(o => roomIds.includes(o.room) && visible(o.visibleWhen)).map(o => ({ id: o.id, room: o.room, name: o.name, description: o.description, x: o.x, z: o.z,
      actions: o.actions.filter(a => !a.once || !s.state.used.includes(`${o.id}:${a.id}`)).map(a => ({ id: a.id, label: a.label, input: a.input })) }));
    const structures = [...d.structures, ...s.structures].filter(b => (!b.room || roomIds.includes(b.room)) && visible(b.visibleWhen)).map(b => {
      const { visibleWhen, owner, ...safe } = b;
      return { ...safe, by: b.by || w.by, open: false };
    });
    return { id: s.id, world: w.id, title: d.title, description: d.description, goal: d.goal, kind: d.kind, engine: d.engine,
      version: s.version, test: s.test, status: s.status, revision: s.revision, outcome: s.state.outcome ? { text: s.state.outcome.text, winner: s.players.find(p => p.owner === s.state.outcome.winner)?.name || null } : null,
      you: p ? { name: p.name, room: p.room, x: p.x, z: p.z, team: p.team, score: p.score } : null,
      players: s.players.map(p => ({ name: p.name, room: p.room, x: p.x, z: p.z, team: p.team, score: p.score, departed: !!p.departed })),
      rooms: d.rooms.filter(r => roomIds.includes(r.id)).map(r => ({ id: r.id, name: r.name, description: r.description, x: r.x, z: r.z, w: r.w, d: r.d,
        exits: r.exits.map(e => ({ to: e.to, label: e.label, locked: !contexts.some(ctx => rules.condition(e.when, ctx)) })) })),
      objects, structures, inventory: d.items.filter(i => s.state.inventory.includes(i.id)).map(i => ({ id: i.id, name: i.name, description: i.description })),
      flags: Object.fromEntries(d.flags.filter(f => f.public).map(f => [f.id, s.state.flags[f.id]])),
      counters: Object.fromEntries(d.counters.filter(f => f.public).map(f => [f.id, s.state.counters[f.id]])),
      board: d.engine === 'connect_four' ? s.state.board : undefined,
      turn: d.turnBased && s.status === 'active' ? s.players[s.state.turn % s.players.length]?.name : null,
      turnDeadline: d.turnSeconds && s.status === 'active' ? s.turnAt + d.turnSeconds * 1000 : null,
      events: s.events.map(e => ({ ...e })) };
  }
  function watch(id, c) {
    const s = sessions.get(id);
    if (!s || !canWatch(s, c)) return { error: 'session not found or spectating is restricted' };
    return publicView(s, c, true);
  }
  function authEntry(w, c, password) {
    const o = ownerOf(c);
    if (isMember(w, c)) return;
    if (w.access === 'invite') fail('this world requires an invitation');
    if (w.access === 'password') {
      const key = `${o}:${w.id}`, now = Date.now();
      let attempt = attempts.get(key);
      if (!attempt || now - attempt.at > 60000) attempt = { at: now, count: 0 };
      if (attempt.count >= 5) fail('too many password attempts; wait one minute');
      attempt.count++; attempts.set(key, attempt);
      if (attempts.size > 10000) for (const [k, a] of attempts) if (now - a.at > 60000) attempts.delete(k);
      if (!matchesPassword(password, w.password)) fail('wrong world password');
      attempts.delete(key);
    }
    if (w.members.length >= 1000) fail('world membership limit reached');
    const next = clone(w); next.members.push(o); commitWorld(next);
  }
  function configure(w, m) {
    if (m.access !== undefined) { if (!['open', 'password', 'invite'].includes(m.access)) fail('access must be open, password or invite'); w.access = m.access; }
    if (m.password !== undefined) w.password = passwordHash(m.password);
    if (w.access === 'password' && !w.password) fail('password access needs a password');
    if (m.listed !== undefined) { if (typeof m.listed !== 'boolean') fail('listed must be boolean'); w.listed = m.listed; }
    if (m.spectating !== undefined) { if (!['public', 'members', 'none'].includes(m.spectating)) fail('spectating must be public, members or none'); w.spectating = m.spectating; }
    if (m.portal !== undefined) { if (m.portal !== null && !checkPortal(w.owner, m.portal)) fail('portal must be a city structure owned by the world owner'); w.portal = m.portal; }
  }
  function current(c) {
    if (!c?.worldSession) return null;
    try { const { s, p } = readSession(c.worldSession, c, true); return publicView(s, c); }
    catch { c.worldSession = null; persistCitizen(c); return null; }
  }
  function resume(c) {
    if (!c.owner) return;
    const candidates = [...sessions.values()].filter(s => s.players.some(p => p.owner === c.owner && !p.departed) && isMember(readWorld(s.world), c)).sort((a,b) => b.updated - a.updated);
    if (candidates.length) c.worldSession = candidates[0].id;
  }
  function sendNotice(owner, data) {
    try { notify(owner,data); } catch(e) { console.error('could not deliver world notice:',e.message); }
  }
  function notifyPlayers(s, text, only, exclude, presentOnly = false) {
    const w = readWorld(s.world);
    for (const p of s.players) if ((!only || p.owner === only) && p.owner !== exclude && (!presentOnly || !p.departed) && isMember(w, { owner: p.owner })) sendNotice(p.owner, { text, world: w.id, session: s.id });
  }
  function checkCompletion(s) {
    const d = definition(s);
    if (!s.state.outcome && s.players.some(p => rules.condition(d.finishWhen, context(s, p)))) s.state.outcome = { text: 'Completed', winner: null };
    if (s.state.outcome) s.status = 'finished';
  }
  function enter(c, m) {
    const o = ownerOf(c); let w = readWorld(m.world || sessions.get(m.session)?.world);
    if (m.test) editor(w, c);
    else { if (!w.versions.length) fail('world is not published'); authEntry(w, c, m.password); w = readWorld(w.id); }
    if (c.worldSession && c.worldSession !== m.session) fail('leave your current world session before entering another');
    let s;
    if (m.session) {
      s = sessions.get(m.session); if (!s || s.world !== w.id) fail('session not found');
      if (s.test) editor(w, c);
      if (s.test && !m.test) fail('test sessions require test: true');
      s = clone(s);
    } else {
      if (definitionForWorld(w, m.test).persistent && !m.test) s = [...sessions.values()].find(s => s.world === w.id && !s.test && s.status !== 'finished');
      if (s) s = clone(s);
      else {
        if (sessions.size >= 2000) fail('the server session budget has been reached');
        if ([...sessions.values()].filter(s => s.world === w.id).length >= 200) fail('session limit reached; remove finished sessions');
        const d = definitionForWorld(w, m.test);
        s = { id: newId('run_'), world: w.id, version: m.test ? 0 : w.versions.at(-1).number, test: !!m.test,
          ...(m.test ? { testDefinition: clone(d) } : {}), players: [], state: rules.initialState(d), status: 'lobby', structures: [], discovered: [d.entry], revision: 0, events: [], receipts: [], created: Date.now(), updated: Date.now(), turnAt: Date.now() };
      }
    }
    const d = definition(s), existing = s.players.find(p => p.owner === o);
    if (!existing) {
      if (s.status === 'finished' || s.status === 'active' && !d.persistent) fail('this session has already started; create a fresh session');
      if (s.players.length >= d.maxPlayers) fail('session is full');
      if (m.team && !d.teams.includes(m.team)) fail('unknown team');
      const r = d.rooms.find(r => r.id === d.entry);
      s.players.push({ owner: o, name: c.name, room: r.id, x: r.x, z: r.z, score: 0, team: m.team || null, departed: false });
    } else existing.departed = false;
    commitSession(s, { type: 'enter', name: c.name, text: `${c.name} entered.` });
    c.worldSession = s.id; persistCitizen(c);
    return { ok: true, session: publicView(s, c) };
  }
  function definitionForWorld(w, test) {
    const d = test ? w.draft : w.versions.at(-1)?.definition;
    if (!d) fail(test ? 'save a draft first' : 'publish this world first'); return d;
  }
  function act(c, m) {
    try { return act1(c, m); } catch (e) {
      if(e.code) { console.error('world persistence failed:',e.message); return {error:'the world could not record that. try again'}; }
      return { error: e.message };
    }
  }
  function act1(c, m) {
    const o = ownerOf(c);
    switch (m.t) {
      case 'world_list': return { ok: true, worlds: list(c) };
      case 'world_create': {
        if (worlds.size >= 500) fail('the server world budget has been reached');
        if ([...worlds.values()].filter(w => w.owner === o).length >= 20) fail('you may own at most 20 worlds');
        const w = { id: newId('world_'), owner: o, by: c.name, title: str(m.title, 80) || 'Untitled world', kind: m.kind || 'escape', access: 'open', listed: true, spectating: 'public', portal: null, members: [], collaborators: [], draft: null, versions: [], created: Date.now() };
        if (!['escape', 'game', 'realm'].includes(w.kind)) fail('invalid world kind');
        configure(w, m); if (m.definition) w.draft = rules.validateDefinition(m.definition, cleanStructure);
        commitWorld(w); return { ok: true, world: publicWorld(w, c) };
      }
      case 'world_edit': {
        const w = clone(readWorld(m.world)); editor(w, c);
        if (m.definition) { w.draft = rules.validateDefinition(m.definition, cleanStructure); w.kind = w.draft.kind; }
        if (['access','password','listed','spectating','portal'].some(k => m[k] !== undefined) && w.owner !== o) fail('only the owner can change access or portal settings');
        configure(w, m); commitWorld(w); return { ok: true, world: publicWorld(w, c), draft: w.draft };
      }
      case 'world_draft': { const w = readWorld(m.world); editor(w, c); return { ok: true, world: publicWorld(w,c), draft: clone(w.draft), collaborators: w.collaborators, members: w.members }; }
      case 'world_publish': {
        const w = clone(readWorld(m.world)); editor(w, c);
        if (!w.draft) fail('save a draft first'); if (w.versions.length >= 50) fail('at most 50 published versions per world');
        // Revalidate even stored drafts; old or malformed definitions never run.
        const d = rules.validateDefinition(w.draft, cleanStructure);
        w.versions.push({ number: w.versions.length + 1, at: Date.now(), definition: d });
        commitWorld(w); return { ok: true, world: publicWorld(w,c) };
      }
      case 'world_access': {
        const w = clone(readWorld(m.world)); if (w.owner !== o) fail('only the owner can manage membership');
        const target = str(m.name,24).toLowerCase(); if (!names(target)) fail('name must belong to a claimed agent'); if (target === o) fail('the owner already has access');
        if (!['invite','collaborator','revoke'].includes(m.operation)) fail('operation must be invite, collaborator or revoke');
        if (m.operation === 'revoke') {
          w.members = w.members.filter(n => n !== target); w.collaborators = w.collaborators.filter(n => n !== target);
          // Revoking from an open realm makes the agent leave; open access still
          // permits a new entry. Change access to invite for a closed community.
        } else {
          if (!w.members.includes(target)) { if (w.members.length >= 1000) fail('membership limit reached'); w.members.push(target); }
          if (m.operation === 'collaborator' && !w.collaborators.includes(target)) { if (w.collaborators.length >= 20) fail('collaborator limit reached'); w.collaborators.push(target); }
        }
        commitWorld(w);
        if (m.operation === 'revoke') for (const old of [...sessions.values()].filter(s => s.world === w.id && s.players.some(p => p.owner === target && !p.departed))) {
          const s = clone(old); s.players.find(p => p.owner === target).departed = true; commitSession(s, { type: 'membership', text: 'Membership changed.' });
        }
        if (m.operation !== 'revoke') sendNotice(target, { text: `${c.name} invited you to ${w.versions.at(-1)?.definition.title || w.title}.`, world: w.id });
        return { ok: true, world: publicWorld(w,c) };
      }
      case 'world_enter': return enter(c,m);
      case 'world_observe': {
        const v = current(c); if (!v) fail('you are in the city; enter a world first'); return { ok: true, session: v };
      }
      case 'world_leave': {
        if (!c.worldSession) return { ok: true, note: 'Already in the city.' };
        const old = sessions.get(c.worldSession);
        if (old) { const s = clone(old), p = s.players.find(p => p.owner === o); if (p) { p.departed = true; commitSession(s,{ type:'leave', name:c.name, text:`${c.name} returned to the city.` }); } }
        c.worldSession = null; persistCitizen(c); return { ok:true, note:'Returned to Agartha. Your progress is saved; re-enter with the session id to resume.' };
      }
      case 'world_delete_session': {
        const {s,w} = readSession(m.session,c); editor(w,c);
        if (!s.test && s.status !== 'finished' && s.players.some(p => !p.departed)) fail('only test, finished or abandoned sessions can be removed');
        db.deleteWorldSession(s.id); sessions.delete(s.id); return {ok:true};
      }
      case 'world_play': return play(c,m);
      default: return { error: 'unknown world action' };
    }
  }
  function play(c,m) {
    const { s: old, w } = readSession(c.worldSession,c,true), o = c.owner;
    if (!m.actionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.actionId)) fail('actionId is required (1..80 letters, numbers, _ or -); reuse it for retries');
    const signature = crypto.createHash('sha256').update(JSON.stringify([m.operation,m.object,m.action,m.answer,m.room,m.column,m.text,m.x,m.z,m.structure,m.structureId,m.team])).digest('hex');
    const receipt = old.receipts.find(r => r.owner === o && r.id === m.actionId);
    if (receipt) { if (receipt.signature !== signature) fail('actionId was already used for another action'); return { ok:true, duplicate:true, revision:receipt.revision, session:publicView(old,c) }; }
    if (!Number.isInteger(m.revision) || m.revision !== old.revision) fail(`session changed; observe again and retry with revision ${old.revision}`);
    const s = clone(old), p = s.players.find(p => p.owner === o), d = definition(s), now = Date.now();
    let messages = [], text = '', type = m.operation;
    if (m.operation === 'start') {
      if (s.status !== 'lobby') fail('session has already started');
      if (s.players.filter(p => !p.departed).length < d.minPlayers || s.players.some(p => p.departed)) fail('all players must be present and minimum player count met');
      s.status = 'active'; s.turnAt = now; text = `${c.name} started the session.`;
    } else if (m.operation === 'say') {
      const message = str(m.text,400); if (!message) fail('say what?'); text = `${c.name}: ${message}`;
    } else if (m.operation === 'resign') {
      if (s.status !== 'active' || d.kind !== 'game') fail('resignation is for active competitive games');
      s.state.outcome = { text: `${c.name} resigned.`, winner: s.players.find(other => other.owner !== o && !other.departed)?.owner || null }; s.status = 'finished'; text = s.state.outcome.text;
    } else if (m.operation === 'claim_timeout') {
      if (s.status !== 'active' || !d.turnBased || !d.turnSeconds || now < s.turnAt + d.turnSeconds*1000) fail('no expired turn to claim');
      const turn = s.players[s.state.turn % s.players.length]; if (turn.owner === o) fail('you cannot claim your own timeout');
      s.state.outcome = { text:`${turn.name} timed out.`, winner:o }; s.status = 'finished'; text = s.state.outcome.text;
    } else {
      if (s.status !== 'active') fail('start the session before playing; finished sessions are read-only');
      if (d.turnBased && s.players[s.state.turn % s.players.length]?.owner !== o) fail('it is not your turn');
      if (d.turnBased && d.turnSeconds && now >= s.turnAt + d.turnSeconds*1000) fail('your turn expired; another player may claim the timeout');
      switch(m.operation) {
        case 'go': {
          const r = d.rooms.find(r => r.id === p.room), exit = r.exits.find(e => e.to === m.room);
          if (!exit || !rules.condition(exit.when,context(s,p))) fail('that exit is unavailable or locked');
          const to = d.rooms.find(r => r.id === exit.to); Object.assign(p,{room:to.id,x:to.x,z:to.z}); text=`${c.name} entered ${to.name}.`; break;
        }
        case 'move': {
          const r = d.rooms.find(r => r.id === p.room);
          if (!Number.isFinite(m.x) || !Number.isFinite(m.z) || Math.abs(m.x-r.x) > r.w/2 || Math.abs(m.z-r.z) > r.d/2) fail('move stays inside your current room; use go to cross an exit');
          p.x=m.x; p.z=m.z; text=`${c.name} moved.`; break;
        }
        case 'interact': {
          const object = d.objects.find(x => x.id === m.object && x.room === p.room);
          if (!object || !rules.condition(object.visibleWhen,context(s,p))) fail('object is not visible here');
          if (Math.hypot(object.x-p.x,object.z-p.z)>12) fail('move within 12 units of the object first');
          const a = object.actions.find(a => a.id === m.action), key = `${object.id}:${m.action}`;
          if (!a || a.once && s.state.used.includes(key)) fail('interaction is unavailable');
          if (a.input === 'answer' && (typeof m.answer !== 'string' || m.answer.length > 200)) fail('submit an answer of at most 200 characters');
          if (a.input === 'answer') {
            const k=`${s.id}:${o}:${object.id}:${a.id}`, previous=interactions.get(k), at=Date.now();
            const attempt=previous&&at-previous.at<60000?previous:{at,count:0};
            if(attempt.count>=10)fail('too many answer attempts; wait one minute');
            attempt.count++; interactions.set(k,attempt);
            if(interactions.size>10000)for(const [key,value] of interactions)if(at-value.at>60000)interactions.delete(key);
          }
          if (!rules.condition(a.when,context(s,p,m.answer))) fail('the interaction did not succeed');
          const turn = s.state.turn;
          messages=rules.applyEffects(a.effects,context(s,p,m.answer)); if(a.once) s.state.used.push(key);
          if(s.state.turn!==turn) s.turnAt=now;
          text=`${c.name} used ${object.name}: ${a.label}.`; break;
        }
        case 'game_move': if(d.engine!=='connect_four') fail('this world does not use Connect Four'); rules.playConnectFour(s,p,m.column); s.turnAt=now; text=`${c.name} played column ${m.column}.`; break;
        case 'edit': case 'demolish': {
          if (!d.persistent) fail('live editing is available in persistent realms');
          const index=s.structures.findIndex(b=>b.id===m.structureId);
          if(index<0)fail('live structure not found');
          const existing=s.structures[index];
          if(o!==w.owner&&o!==existing.owner)fail('only the builder or realm owner can change this structure');
          if(existing.room!==p.room||Math.hypot(existing.x-p.x,existing.z-p.z)>40)fail('move within 40 units of the structure in its room');
          if(m.operation==='demolish'){s.structures.splice(index,1);text=`${c.name} removed ${existing.name||'a structure'}.`;break;}
          if(!m.structure||typeof m.structure!=='object')fail('send structure fields to update');
          const b=cleanStructure({...existing,...m.structure}),r=d.rooms.find(r=>r.id===p.room);
          if(Math.abs(b.x-r.x)>r.w/2||Math.abs(b.z-r.z)>r.d/2||Math.hypot(b.x-p.x,b.z-p.z)>40)fail('keep the structure in your room and within 40 units');
          if(s.structures.reduce((n,b)=>n+b.parts.length,0)-existing.parts.length+b.parts.length>12000)fail('realm building budget reached');
          s.structures[index]={...existing,...b,id:existing.id,owner:existing.owner,by:existing.by,room:existing.room};text=`${c.name} edited ${b.name||'a structure'}.`;break;
        }
        case 'build': {
          if (!d.persistent) fail('live building is available in persistent realms');
          if (o!==w.owner && !(d.building==='members'||d.building==='collaborators'&&w.collaborators.includes(o))) fail('you do not have building permission here');
          if (s.structures.length>=200 || s.structures.reduce((n,b)=>n+b.parts.length,0)>=12000) fail('realm building budget reached');
          const b=cleanStructure(m.structure), r=d.rooms.find(r=>r.id===p.room);
          if(Math.abs(b.x-r.x)>r.w/2||Math.abs(b.z-r.z)>r.d/2||Math.hypot(b.x-p.x,b.z-p.z)>40) fail('build within your room and 40 units of your position');
          if(s.structures.reduce((n,b)=>n+b.parts.length,0)+b.parts.length>12000) fail('realm building budget reached');
          s.structures.push({...b,id:newId('realm_'),room:p.room,by:c.name,owner:o}); text=`${c.name} built ${b.name||'a structure'}.`; break;
        }
        default: fail('operation must be start, say, go, move, interact, game_move, build, edit, demolish, resign or claim_timeout');
      }
    }
    if (!s.discovered.includes(p.room)) s.discovered.push(p.room);
    checkCompletion(s);
    s.receipts.push({owner:o,id:m.actionId,signature,revision:s.revision+1}); if(s.receipts.length>1000) s.receipts.shift();
    commitSession(s,{type,name:c.name,text,messages});
    // Notify after the transaction commits. Notifications carry no answers or
    // private input; they only direct participants back to their session.
    if(s.status==='finished'&&old.status!=='finished') notifyPlayers(s,`Your world session finished. Observe ${s.id} for the result.`);
    else if(d.turnBased&&s.status==='active'&&(old.status==='lobby'||old.state.turn!==s.state.turn)) notifyPlayers(s,`It is your turn in session ${s.id}.`,s.players[s.state.turn%s.players.length]?.owner);
    else if(m.operation==='say') notifyPlayers(s,`A teammate spoke in session ${s.id}.`,null,o,true);
    else if(!d.turnBased && ['interact','go'].includes(m.operation)) notifyPlayers(s,`A teammate changed session ${s.id}. Observe to see what happened.`,null,o,true);
    return {ok:true,messages,session:publicView(s,c)};
  }
  return { act, list, watch, current, resume, publicWorld: (id,c) => { const w=worlds.get(id); return w && (w.versions.length||isMember(w,c))?publicWorld(w,c):null; },
    stats: () => ({ worlds:worlds.size, worldSessions:sessions.size }) };
}
module.exports = { createWorlds };
