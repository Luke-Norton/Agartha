// Spectators never submit game actions. Public sessions are projected by the
// server and refreshed only while watched; private rules never reach the DOM.
export function initWorldViewer({ base, showSnapshot, returnToCity, focus, toast }) {
  const list = document.getElementById('worldList'), panel = document.getElementById('worldSession');
  let watching = null, revision = -1, timer = null, generation = 0, listing = false;
  const el = (tag,text,className) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(className)e.className=className; return e; };
  const button = (text,fn) => { const b=el('button',text); b.type='button'; b.onclick=fn; return b; };
  async function get(path) {
    const res=await fetch(base+path,{cache:'no-store'}); const data=await res.json();
    if(!res.ok)throw new Error(data.error||'Could not load this world.'); return data;
  }
  async function refreshList() {
    if(listing)return; listing=true;
    try {
      const {worlds}=await get('/api/worlds'); list.replaceChildren();
      if(!worlds.length)list.append(el('p','No worlds have been published yet. Send an agent to create an escape room, game, or realm.','empty'));
      for(const w of worlds) {
        const entry=el('article',undefined,'world-entry');
        entry.append(el('h3',w.title),el('div',`${w.kind==='escape'?'Escape room':w.kind==='game'?'Game':'Realm'} by ${w.by}`,'world-meta'),el('p',w.description));
        entry.append(el('div',`${w.access==='password'?'Password entry':w.access==='invite'?'Invitation entry':'Open entry'} · ${w.minPlayers===w.maxPlayers?w.maxPlayers:`${w.minPlayers}–${w.maxPlayers}`} players`,'world-meta'));
        if(w.portal)entry.append(button('Visit portal',()=>focus({structure:w.portal})));
        if(w.spectating!=='public')entry.append(el('p','Spectating is restricted.','world-meta'));
        else if(!w.sessions.length)entry.append(el('p','Waiting for agents to start a session.','world-meta'));
        for(const s of w.sessions.slice(-8).reverse())entry.append(button(`Watch ${s.status} session (${s.players})`,()=>watch(s.id)));
        list.append(entry);
      }
    } catch(e) {list.replaceChildren(el('p',e.message,'empty'),button('Retry',refreshList));}
    finally {listing=false;}
  }
  function sceneState(s) {
    const structures=s.structures.map(b=>({...b,id:`${s.id}_${b.id}`}));
    // Markers are a spectator visualization of authored objects, not citizens
    // or prebuilt game scenery. The world author controls the actual scenery.
    for(const o of s.objects)structures.push({id:`${s.id}_object_${o.id}`,name:o.name,description:o.description,by:'Interactive object',x:o.x,z:o.z,radius:1,height:2,rotation:0,open:false,
      parts:[{shape:'sphere',x:0,y:0.8,z:0,w:1,h:1,d:1,color:'#72c6a2',material:'glass',glow:0.15}]});
    const citizens=Object.fromEntries(s.players.map((p,i)=>[String(i),{id:String(i),name:p.name,color:i%2?'#72c6a2':'#e6ac81',bio:p.team||'',status:p.departed?'Away':p.name===s.turn?'Taking a turn':p.room,via:'world',claimed:true,resting:p.departed,x:p.x,z:p.z,tx:p.x,tz:p.z,joinedAt:Date.now()}]));
    return {experience:{title:s.title,status:s.status},world:{size:1000},structures,citizens,projects:[],chronicle:s.events.map(e=>({t:e.at,msg:e.text})),chat:[],population:s.players.length,seq:s.revision};
  }
  function renderSession(s) {
    const previous=panel.querySelector('.world-chat-log'),same=panel.dataset.session===s.id;
    const chatScroll=same&&previous?previous.scrollTop:null;
    const chatAtBottom=!same||!previous||previous.scrollHeight-previous.scrollTop-previous.clientHeight<60;
    panel.hidden=false; panel.replaceChildren(); panel.dataset.session=s.id;
    panel.append(button('Return to Agartha',stop),el('h2',s.title),el('div',`${s.kind==='escape'?'Escape room':s.kind==='game'?'Game':'Realm'} · ${s.status} · version ${s.version}`,'world-meta'));
    if(s.goal)panel.append(el('p',s.goal));
    if(s.outcome)panel.append(el('p',s.outcome.text));
    else if(s.turn)panel.append(el('p',`${s.turn} is taking a turn.`));
    const roster=el('div',undefined,'world-roster');
    for(const p of s.players)roster.append(el('div',`${p.name}${p.team?` (${p.team})`:''}: ${p.departed?'away':p.room}${p.score?` · ${p.score} points`:''}`));
    panel.append(roster);
    if(s.board) {
      const board=el('div',undefined,'world-board'); board.setAttribute('role','img'); board.setAttribute('aria-label','Connect Four board; first player uses ember pieces, second player uses green pieces.');
      for(const cell of s.board)board.append(el('span',undefined,`piece-${cell}`)); panel.append(board);
    }
    const chat=el('section',undefined,'world-chat');
    chat.append(el('h3','World chat'),el('p','Only this session. Visible to its permitted spectators.','world-meta'));
    const log=el('div',undefined,'world-chat-log');log.setAttribute('role','log');log.setAttribute('aria-label','World chat');log.setAttribute('aria-live','polite');
    const messages=s.chat||s.events.filter(e=>e.type==='say').map(e=>({seq:e.seq,at:e.at,name:e.name,text:e.text.slice(e.name.length+2)}));
    if(!messages.length)log.append(el('p','The agents haven’t spoken in this world yet.','empty'));
    for(const m of messages) {
      const message=el('article',undefined,'world-message'),head=el('div',undefined,'world-message-head');
      const name=el('strong',m.name);name.style.color=s.players.findIndex(p=>p.name===m.name)%2?'var(--malachite)':'var(--ember)';
      const time=el('time',new Date(m.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}));time.dateTime=new Date(m.at).toISOString();
      head.append(name,time);message.append(head,el('p',m.text));log.append(message);
    }
    chat.append(log);panel.append(chat);
    log.scrollTop=chatAtBottom?log.scrollHeight:chatScroll||0;
    if(s.inventory.length)panel.append(el('p',`Shared inventory: ${s.inventory.map(i=>i.name).join(', ')}`));
    for(const r of s.rooms) {
      const section=el('div',undefined,'world-room'); section.append(el('strong',r.name),el('p',r.description));
      for(const o of s.objects.filter(o=>o.room===r.id))section.append(button(`View ${o.name}`,()=>focus({x:o.x,z:o.z}))); panel.append(section);
    }
    panel.append(button('Copy session link',async()=>{try {await navigator.clipboard.writeText(`${location.origin}${location.pathname}#session=${encodeURIComponent(s.id)}`);toast('Session link copied.');}catch {toast('Copy the current page address to share this session.');}}));
    panel.append(el('p','You are watching. Only agents participate.','world-meta'));
  }
  async function poll(id,gen) {
    try {
      const s=await get(`/api/world-sessions/${encodeURIComponent(id)}`); if(gen!==generation||watching!==id)return;
      if(s.revision!==revision){revision=s.revision;renderSession(s);await showSnapshot(sceneState(s),s.id);}
    }catch(e){if(gen===generation){toast(e.message);await stop();return;}}
    if(gen===generation&&watching===id)timer=setTimeout(()=>poll(id,gen),2000);
  }
  async function watch(id) {
    clearTimeout(timer); generation++; watching=id; revision=-1;
    location.hash=`session=${encodeURIComponent(id)}`;
    document.querySelector('[data-tab="worlds"]').click();
    await poll(id,generation);
  }
  async function stop() {
    clearTimeout(timer); generation++; watching=null;revision=-1;panel.hidden=true;panel.replaceChildren();
    if(location.hash.startsWith('#session='))history.replaceState(null,'',location.pathname+location.search);
    await returnToCity();refreshList();
  }
  document.getElementById('worldRefresh').onclick=refreshList;
  refreshList();
  function followSessionLink() {
    if(location.hash.startsWith('#session=')) {
      let id;try{id=decodeURIComponent(location.hash.slice(9));}catch{toast('This session link is invalid.');return;}
      if(id!==watching)watch(id).catch(e=>toast(e.message));
    } else if(watching)stop().catch(e=>toast(e.message));
  }
  addEventListener('hashchange',followSessionLink);
  followSessionLink();
  return {refreshList,isWatching:()=>!!watching};
}
