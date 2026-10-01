'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../storage');
const { createWorlds } = require('../worlds');
const { validateDefinition } = require('../rules');
const definition = () => ({kind:'escape',title:'The Clockmaker',goal:'Open the observatory',rooms:[
  {id:'foyer',name:'Foyer',description:'A stopped clock.',x:0,z:0,w:20,d:20,exits:[{to:'observatory',label:'Observatory door',when:{flag:'unlocked'}}]},
  {id:'observatory',name:'Observatory',x:30,z:0,w:20,d:20,exits:[{to:'foyer'}]},
],items:[{id:'key',name:'Brass key'}],flags:[{id:'unlocked',initial:false}],counters:[],objects:[
  {id:'cabinet',room:'foyer',name:'Cabinet',actions:[{id:'open',once:true,effects:[{op:'give',item:'key'}]}]},
  {id:'keypad',room:'foyer',name:'Keypad',actions:[{id:'answer',input:'answer',when:{all:[{has:'key'},{answer:'midnight-secret'}]},effects:[{op:'take',item:'key'},{op:'flag',id:'unlocked',value:true}]}]},
],finishWhen:{room:'observatory'}});
function setup(t, file) {
  const dir = file ? null : fs.mkdtempSync(path.join(os.tmpdir(),'agartha-worlds-'));
  const db=open(file||path.join(dir,'test.db'));
  let notifications=[];
  const make=()=>createWorlds({db,names:()=>true,notify:(owner,data)=>notifications.push({owner,...data}),persistCitizen:()=>{},checkPortal:()=>true,
    cleanStructure:s=>({id:s.id,name:s.name||'',description:'',x:s.x,z:s.z,parts:s.parts||[],radius:1,height:1})});
  let worlds=make();
  t.after(()=>{db.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});});
  const a={owner:'alice',name:'Alice'},b={owner:'bob',name:'Bob'},c={owner:'cara',name:'Cara'};
  const act=(agent,m)=>worlds.act(agent,m);
  const ok=(agent,m)=>{const r=act(agent,m);assert.equal(r.error,undefined,JSON.stringify(r));return r;};
  const observe=agent=>ok(agent,{t:'world_observe'}).session;
  let n=0;
  const play=(agent,operation,fields={})=>ok(agent,{t:'world_play',revision:observe(agent).revision,actionId:`action${++n}`,operation,...fields});
  const buildWorld=(d=definition(),settings={})=>{const w=ok(a,{t:'world_create',title:d.title,definition:d,...settings}).world.id;ok(a,{t:'world_publish',world:w});return w;};
  return {a,b,c,db,act,ok,observe,play,buildWorld,get worlds(){return worlds;},reload:()=>{worlds=make();},notifications};
}
test('cooperative escape: locks, shared inventory, hidden answers, room boundaries and completion',t=>{
  const x=setup(t),w=x.buildWorld();
  const s=x.ok(x.a,{t:'world_enter',world:w}).session.id;
  x.ok(x.b,{t:'world_enter',session:s});x.play(x.a,'start');
  assert.match(x.act(x.b,{t:'world_play',operation:'go',room:'observatory',revision:x.observe(x.b).revision,actionId:'locked'}).error,/locked/);
  assert.match(x.act(x.b,{t:'world_play',operation:'move',x:30,z:0,revision:x.observe(x.b).revision,actionId:'bypass'}).error,/inside/);
  x.play(x.a,'interact',{object:'cabinet',action:'open'});
  assert.equal(x.observe(x.b).inventory[0].id,'key');
  assert(x.notifications.some(n=>n.owner==='bob'&&n.text.includes('teammate changed')));
  assert.match(x.act(x.b,{t:'world_play',operation:'interact',object:'keypad',action:'answer',answer:'wrong',revision:x.observe(x.b).revision,actionId:'wrong'}).error,/did not succeed/);
  for(const view of [x.observe(x.b),x.worlds.watch(s,null)]){const json=JSON.stringify(view);assert(!json.includes('midnight-secret'));assert(!json.includes('finishWhen'));assert(!json.includes('unlocked'));assert(!json.includes('when'));}
  x.play(x.b,'interact',{object:'keypad',action:'answer',answer:'midnight-secret'});
  x.play(x.a,'go',{room:'observatory'});assert.equal(x.observe(x.b).status,'finished');
  assert.equal(x.observe(x.b).inventory.length,0);
});
test('password membership, private spectating, invitation, revocation and author-only drafts',t=>{
  const x=setup(t),w=x.buildWorld(definition(),{access:'password',password:'my-password',listed:false,spectating:'members'});
  assert.equal(x.worlds.list(null).length,0);
  assert.match(x.act(x.b,{t:'world_enter',world:w,password:'wrong'}).error,/password/);
  const s=x.ok(x.b,{t:'world_enter',world:w,password:'my-password'}).session.id;
  assert(x.worlds.watch(s,null).error);assert(!x.worlds.watch(s,x.a).error);
  assert(x.act(x.b,{t:'world_draft',world:w}).error);
  const raw=x.db.loadWorlds()[0];assert.notEqual(raw.password.hash,'my-password');assert(!JSON.stringify(raw).includes('my-password'));
  x.ok(x.a,{t:'world_access',world:w,name:'Bob',operation:'revoke'});
  assert(x.act(x.b,{t:'world_observe'}).error);assert(x.worlds.watch(s,x.b).error);
  x.ok(x.a,{t:'world_edit',world:w,access:'invite'});
  assert(x.act(x.c,{t:'world_enter',world:w}).error);
  x.ok(x.a,{t:'world_access',world:w,name:'Cara',operation:'collaborator'});
  assert(x.ok(x.c,{t:'world_draft',world:w}).draft);
  x.ok(x.c,{t:'world_enter',world:w});
});
test('entry brute force has a per-agent/world limit',t=>{
  const x=setup(t),w=x.buildWorld(definition(),{access:'password',password:'secret'});
  for(let i=0;i<5;i++)assert.match(x.act(x.b,{t:'world_enter',world:w,password:'bad'}).error,/password/);
  assert.match(x.act(x.b,{t:'world_enter',world:w,password:'secret'}).error,/too many/);
});
test('sessions are independent, revisions reject races and idempotent retries do not apply twice',t=>{
  const x=setup(t),w=x.buildWorld(),s=x.ok(x.a,{t:'world_enter',world:w}).session.id;
  x.ok(x.b,{t:'world_enter',session:s});x.play(x.a,'start');
  const revision=x.observe(x.a).revision,m={t:'world_play',operation:'interact',object:'cabinet',action:'open',revision,actionId:'same'};
  x.ok(x.a,m);assert.equal(x.ok(x.a,m).duplicate,true);
  assert.match(x.act(x.a,{...m,operation:'go',room:'observatory'}).error,/already used/);
  assert.match(x.act(x.b,{t:'world_play',operation:'move',x:1,z:1,revision,actionId:'stale'}).error,/session changed/);
  x.ok(x.c,{t:'world_enter',world:w});assert.equal(x.observe(x.c).inventory.length,0);
});
test('publish pins versions; draft tests remain private and restart restores progress',t=>{
  const x=setup(t),w=x.buildWorld(),s=x.ok(x.b,{t:'world_enter',world:w}).session.id;
  x.play(x.b,'start');x.play(x.b,'interact',{object:'cabinet',action:'open'});
  const d=definition();d.title='New revision';x.ok(x.a,{t:'world_edit',world:w,definition:d});x.ok(x.a,{t:'world_publish',world:w});
  assert.equal(x.observe(x.b).title,'The Clockmaker');
  const draft=x.ok(x.a,{t:'world_enter',world:w,test:true}).session.id;assert(x.worlds.watch(draft,null).error);
  x.reload();const returning={owner:'bob',name:'Bob'};x.worlds.resume(returning);
  assert.equal(returning.worldSession,s);assert.equal(x.observe(returning).inventory[0].id,'key');
});
test('Connect Four legal turns, victory, immutable finished match and turn notifications',t=>{
  const x=setup(t),w=x.buildWorld({kind:'game',title:'Arena',engine:'connect_four',turnSeconds:60});
  const s=x.ok(x.a,{t:'world_enter',world:w}).session.id;x.ok(x.b,{t:'world_enter',session:s});x.play(x.a,'start');
  assert.match(x.act(x.b,{t:'world_play',operation:'game_move',column:0,revision:x.observe(x.b).revision,actionId:'out-of-turn'}).error,/your turn/);
  for(let i=0;i<3;i++){x.play(x.a,'game_move',{column:0});x.play(x.b,'game_move',{column:1});}x.play(x.a,'game_move',{column:0});
  assert.equal(x.observe(x.a).status,'finished');assert.equal(x.observe(x.a).outcome.winner,'Alice');
  assert(x.act(x.b,{t:'world_play',operation:'game_move',column:1,revision:x.observe(x.b).revision,actionId:'after'}).error);
  assert(x.notifications.some(n=>n.text.includes('your turn')));
});
test('persistent realms share a session and enforce building permissions',t=>{
  const x=setup(t),w=x.buildWorld({kind:'realm',title:'Secret valley',building:'members'});
  const s=x.ok(x.a,{t:'world_enter',world:w}).session.id;x.play(x.a,'start');
  assert.equal(x.ok(x.b,{t:'world_enter',world:w}).session.id,s);
  x.play(x.b,'build',{structure:{name:'Garden',x:0,z:0,parts:[{shape:'box'}]}});
  assert.equal(x.observe(x.a).structures[0].name,'Garden');
  const structureId=x.observe(x.a).structures[0].id;
  x.play(x.b,'edit',{structureId,structure:{name:'Moon garden'}});assert.equal(x.observe(x.a).structures[0].name,'Moon garden');
  x.play(x.a,'demolish',{structureId});assert.equal(x.observe(x.b).structures.length,0);
  x.ok(x.a,{t:'world_leave'});assert.equal(x.ok(x.a,{t:'world_enter',world:w}).session.id,s);
});
test('definition validator rejects executable rules, invalid references and overlapping rooms',()=>{
  const clean=s=>s;
  assert.throws(()=>validateDefinition({...definition(),objects:[{id:'hack',room:'foyer',actions:[{id:'run',effects:[{op:'eval',code:'anything'}]}]}]},clean),/unknown effect/);
  const d=definition();d.rooms[1].x=0;assert.throws(()=>validateDefinition(d,clean),/overlap/);
  const e=definition();e.rooms[0].exits[0].when={flag:'absent'};assert.throws(()=>validateDefinition(e,clean),/unknown flag/);
});

test('completion considers any participant, effects roll back on failure and secret scenery stays hidden',t=>{
  const x=setup(t),d=definition();
  d.structures=[{id:'secret',name:'Hidden passage',room:'observatory',x:30,z:0,parts:[{}],visibleWhen:{flag:'unlocked'}}];
  d.objects.push({id:'broken',room:'foyer',actions:[{id:'try',effects:[{op:'flag',id:'unlocked',value:true},{op:'take',item:'key'}]}]});
  const w=x.buildWorld(d),s=x.ok(x.a,{t:'world_enter',world:w}).session.id;x.ok(x.b,{t:'world_enter',session:s});x.play(x.a,'start');
  const before=x.observe(x.a).revision;
  assert.match(x.act(x.a,{t:'world_play',operation:'interact',object:'broken',action:'try',revision:before,actionId:'rollback'}).error,/missing/);
  assert.equal(x.observe(x.a).revision,before);assert.equal(x.worlds.watch(s,null).structures.length,0);
  x.play(x.a,'interact',{object:'cabinet',action:'open'});x.play(x.a,'interact',{object:'keypad',action:'answer',answer:'midnight-secret'});
  x.play(x.b,'go',{room:'observatory'});assert.equal(x.observe(x.a).status,'finished');assert.equal(x.worlds.watch(s,null).structures.length,1);
});
test('realm owner-only building and private tests deny nonmembers',t=>{
  const x=setup(t),w=x.buildWorld({kind:'realm',title:'Owner realm',building:'owner'});
  const s=x.ok(x.a,{t:'world_enter',world:w}).session.id;x.play(x.a,'start');x.ok(x.b,{t:'world_enter',session:s});
  assert.match(x.act(x.b,{t:'world_play',operation:'build',structure:{x:0,z:0,parts:[{}]},actionId:'forbidden',revision:x.observe(x.b).revision}).error,/permission/);
});

test('custom turn-based games enforce authored team rules, counters, scoring and winners',t=>{
  const x=setup(t),d={kind:'game',title:'Race to three',minPlayers:2,maxPlayers:2,turnBased:true,teams:['red','blue'],counters:[{id:'steps',initial:0,public:true}],objects:[{id:'track',room:'entry',actions:[
    {id:'advance',when:{counter:{id:'steps',op:'lte',value:1}},effects:[{op:'counter',id:'steps',add:1},{op:'score',add:1},{op:'next_turn'}]},
    {id:'win',when:{all:[{counter:{id:'steps',op:'eq',value:2}},{team:'red'}]},effects:[{op:'score',add:1},{op:'finish',text:'Red reached the finish.'}]},
  ]}]};
  const w=x.buildWorld(d),s=x.ok(x.a,{t:'world_enter',world:w,team:'red'}).session.id;x.ok(x.b,{t:'world_enter',session:s,team:'blue'});x.play(x.a,'start');
  x.play(x.a,'interact',{object:'track',action:'advance'});assert.equal(x.observe(x.b).turn,'Bob');
  x.play(x.b,'interact',{object:'track',action:'advance'});x.play(x.a,'interact',{object:'track',action:'win'});
  const result=x.observe(x.b);assert.equal(result.outcome.winner,'Alice');assert.equal(result.players[0].score,2);assert.equal(result.counters.steps,2);
});
test('a failed SQLite event write rolls back both state and event, allowing a safe retry',t=>{
  const x=setup(t),w=x.buildWorld();x.ok(x.a,{t:'world_enter',world:w});const initial=x.observe(x.a),save=x.db.saveWorldSession;
  x.db.saveWorldSession=(s,e)=>save(s,{...e,seq:1});
  const oldLog=console.error;console.error=()=>{};
  try {const r=x.act(x.a,{t:'world_play',operation:'start',revision:initial.revision,actionId:'retry'});assert.match(r.error,/could not record/);}finally{console.error=oldLog;x.db.saveWorldSession=save;}
  assert.equal(x.observe(x.a).revision,initial.revision);assert.equal(x.db.loadWorldSessions()[0].status,'lobby');
  x.play(x.a,'start',{actionId:'retry'});assert.equal(x.observe(x.a).status,'active');
});
test('Connect Four rejects a full column and completes a legal drawn match',()=>{
  const {initialState,playConnectFour}=require('../rules');
  const create=()=>({state:initialState({flags:[],counters:[]}),players:[{owner:'a',name:'A'},{owner:'b',name:'B'}]});
  const full=create();for(let i=0;i<6;i++)playConnectFour(full,full.players[full.state.turn],0);
  assert.throws(()=>playConnectFour(full,full.players[full.state.turn],0),/full/);
  const draw=create();for(const col of [0,6,5,6,5,5,4,2,5,6,6,3,2,0,4,1,1,3,1,4,6,5,2,2,2,6,3,0,2,1,0,0,4,1,5,0,1,3,3,4,4,3]) {
    assert.equal(draw.state.outcome,null);playConnectFour(draw,draw.players[draw.state.turn],col);
  }
  assert.equal(draw.state.outcome.text,'Draw');assert.equal(draw.state.outcome.winner,null);
});
test('expired turns can be claimed by an opponent',t=>{
  const x=setup(t),w=x.buildWorld({kind:'game',title:'Timed arena',engine:'connect_four',turnSeconds:30});
  const s=x.ok(x.a,{t:'world_enter',world:w}).session.id;x.ok(x.b,{t:'world_enter',session:s});x.play(x.a,'start');
  assert.match(x.act(x.b,{t:'world_play',operation:'claim_timeout',revision:x.observe(x.b).revision,actionId:'too-soon'}).error,/expired/);
  const record=x.db.loadWorldSessions().find(s=>s.id===x.a.worldSession);record.turnAt=Date.now()-31000;x.db.saveWorldSession(record);x.reload();
  assert.match(x.act(x.a,{t:'world_play',operation:'game_move',column:0,revision:x.observe(x.a).revision,actionId:'late'}).error,/expired/);
  x.play(x.b,'claim_timeout');assert.equal(x.observe(x.a).outcome.winner,'Bob');
});
