'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const root=path.resolve(__dirname,'..');
test('HTTP, WebSocket, MCP and spectator views share enforced world rules and survive restart', {timeout:45000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agartha-transport-')),port=18000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
  let child,output='',sockets=[],client;
  async function stop(){if(child&&child.exitCode===null){const p=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await p;}child=null;}
  t.after(async()=>{for(const ws of sockets)ws.close();if(client)await client.close();await stop();fs.rmSync(dir,{recursive:true,force:true});});
  async function boot(){child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'city.db'),AGENT_KEY:'',STATE_FILE:'',PUBLIC_URL:base},stdio:['ignore','pipe','pipe']});output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);for(let n=0;n<100;n++){if(child.exitCode!==null)throw new Error(output);try{const r=await fetch(base+'/health');if(r.ok)return;}catch{}await sleep(50);}throw new Error('Server did not start: '+output);}
  await boot();
  async function request(route,token,body){return fetch(base+route,{method:body?'POST':'GET',headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  async function httpAct(token,m,expectError=false){for(let i=0;i<10;i++){const r=await request('/api/act',token,m),v=await r.json();if(r.status===429){await sleep(Math.max(130,v.retryAfterMs||0));continue;}if(!expectError)assert.equal(v.error,undefined,JSON.stringify(v));return v;}throw new Error('Repeated rate limit');}
  const alice=await (await request('/api/join',null,{name:'Alice',secret:'alice-secret'})).json();assert(alice.token);
  const cityBuilding=await httpAct(alice.token,{t:'build',name:'City portal',x:alice.you.x,z:alice.you.z,parts:[{shape:'box',w:1,h:1,d:1}]});
  const d={kind:'escape',title:'Private Clock House',goal:'Escape',rooms:[{id:'foyer',x:0,z:0,w:20,d:20,exits:[{to:'garden',when:{flag:'unlocked'}}]},{id:'garden',x:30,z:0,w:20,d:20}],flags:[{id:'unlocked',initial:false}],items:[{id:'key',name:'Key'}],objects:[{id:'cabinet',room:'foyer',actions:[{id:'open',once:true,effects:[{op:'give',item:'key'}]}]},{id:'lock',room:'foyer',actions:[{id:'unlock',input:'answer',when:{all:[{has:'key'},{answer:'TRANSPORT_HIDDEN_ANSWER'}]},effects:[{op:'flag',id:'unlocked',value:true}]}]}],structures:[{id:'wall',name:'Private wall',x:0,z:0,parts:[{shape:'box',w:10,h:3,d:1}]}],finishWhen:{room:'garden'}};
  const world=(await httpAct(alice.token,{t:'world_create',title:d.title,definition:d,access:'password',password:'WORLD_PASSWORD_SECRET',listed:false,spectating:'members',portal:cityBuilding.id})).world.id;
  await httpAct(alice.token,{t:'world_publish',world});
  const run=(await httpAct(alice.token,{t:'world_enter',world})).session.id;
  async function socket(){const ws=new WebSocket(base.replace('http','ws'));sockets.push(ws);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});return ws;}
  const watcher=await socket(),watchMessages=[];watcher.on('message',raw=>watchMessages.push(JSON.parse(raw)));watcher.send(JSON.stringify({t:'watch'}));
  async function wsRequest(ws,m){return new Promise((resolve,reject)=>{const rid=Math.random().toString(36);const timer=setTimeout(()=>{ws.off('message',handle);reject(new Error('WS request timed out'));},5000);function handle(raw){const v=JSON.parse(raw);if(v.rid===rid||m.t==='hello'&&v.t==='welcome'){clearTimeout(timer);ws.off('message',handle);resolve(v);}}ws.on('message',handle);ws.send(JSON.stringify({...m,rid}));});}
  const bob=await socket(),hello=await wsRequest(bob,{t:'hello',name:'Bob',secret:'bob-secret'});assert(hello.token);
  let result=await wsRequest(bob,{t:'world_enter',session:run,password:'WORLD_PASSWORD_SECRET'});assert.equal(result.t,'ok');
  result=await wsRequest(bob,{t:'world_play',operation:'start',actionId:'start',revision:result.session.revision});assert.equal(result.t,'ok');
  let state=(await httpAct(alice.token,{t:'world_observe'})).session;
  await httpAct(alice.token,{t:'world_play',operation:'interact',object:'cabinet',action:'open',revision:state.revision,actionId:'cabinet'});
  const bobView=await wsRequest(bob,{t:'world_observe'});assert.equal(bobView.session.inventory[0].id,'key');
  const wrong=await wsRequest(bob,{t:'world_play',operation:'move',x:30,z:0,revision:bobView.session.revision,actionId:'bypass'});assert.equal(wrong.t,'error');
  const solved=await wsRequest(bob,{t:'world_play',operation:'interact',object:'lock',action:'unlock',answer:'TRANSPORT_HIDDEN_ANSWER',revision:bobView.session.revision,actionId:'solve'});assert.equal(solved.t,'ok');
  await wsRequest(bob,{t:'world_play',operation:'go',room:'garden',revision:solved.session.revision,actionId:'escape'});
  const publicCity=JSON.stringify(await (await request('/api/state')).json());
  const cityEvents=JSON.stringify(await (await request('/api/events',alice.token)).json());
  const restricted=await request('/api/world-sessions/'+run);assert.equal(restricted.status,403);
  const member=await (await request('/api/world-sessions/'+run,alice.token)).json();assert.equal(member.status,'finished');
  const worldList=await (await request('/api/worlds')).json();assert.equal(worldList.worlds.length,0);
  for(const source of [publicCity,cityEvents,JSON.stringify(watchMessages),JSON.stringify(member),JSON.stringify(bobView)])for(const secret of ['TRANSPORT_HIDDEN_ANSWER','WORLD_PASSWORD_SECRET'])assert(!source.includes(secret));
  assert(!publicCity.includes('Private wall'));assert(!JSON.stringify(watchMessages).includes('Private wall'));
  assert((await httpAct(alice.token,{t:'inspect',id:cityBuilding.id},true)).error);
  const denied=await wsRequest(bob,{t:'world_draft',world});assert.equal(denied.t,'error');
  await httpAct(alice.token,{t:'world_leave'});assert.equal((await httpAct(alice.token,{t:'inspect',id:cityBuilding.id})).structure.name,'City portal');
  await wsRequest(bob,{t:'world_leave'});
  client=new Client({name:'world-test',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='world_play'));
  async function call(name,args={}){for(let i=0;i<10;i++){const r=await client.callTool({name,arguments:args});const txt=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(r.isError&&txt.includes('slow down')){await sleep(150);continue;}assert(!r.isError,txt);return JSON.parse(txt);}throw new Error('MCP rate limit');}
  const joined=await client.callTool({name:'join',arguments:{name:'Scribe',secret:'scribe-secret'}});assert(!joined.isError);
  const guide=await client.readResource({uri:'agartha://worlds'});assert(guide.contents[0].text.includes('finishWhen'));
  const arena=(await call('world_create',{title:'Agent arena',definition:{kind:'game',title:'Agent arena',engine:'connect_four'}})).world.id;
  await call('world_publish',{world:arena});let match=(await call('world_enter',{world:arena})).session;
  result=await wsRequest(bob,{t:'world_enter',session:match.id});assert.equal(result.t,'ok');
  match=(await call('world_observe')).session;match=(await call('world_play',{operation:'start',actionId:'match-start',revision:match.revision})).session;
  for(let i=0;i<3;i++){
    match=(await call('world_play',{operation:'game_move',column:0,actionId:'red-'+i,revision:match.revision})).session;
    result=await wsRequest(bob,{t:'world_play',operation:'game_move',column:1,actionId:'green-'+i,revision:match.revision});assert.equal(result.t,'ok');match=result.session;
  }
  match=(await call('world_play',{operation:'game_move',column:0,actionId:'red-final',revision:match.revision})).session;assert.equal(match.outcome.winner,'Scribe');
  const spectators=await (await request('/api/world-sessions/'+match.id)).json();assert.equal(spectators.status,'finished');assert.equal(spectators.board.filter(Boolean).length,7);
  for(const ws of sockets)ws.close();sockets=[];await stop();await boot();
  const restored=await call('world_observe');assert.equal(restored.session.id,match.id);assert.equal(restored.session.outcome.winner,'Scribe');
  const bobAgain=await socket(),resumed=await wsRequest(bobAgain,{t:'hello',token:hello.token});assert.equal(resumed.session.id,match.id);assert.equal(resumed.resumed,true);
  const returning=await (await request('/api/join',null,{name:'Alice',secret:'alice-secret'})).json();assert(returning.token);
  assert(!output.includes('action failed'),output);
});
