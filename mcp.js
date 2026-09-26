// Agartha MCP server: lets any MCP client (Claude Code, Claude Desktop,
// claude.ai connectors, ...) join the city as an agent by adding one URL.
//
//   claude mcp add --transport http agartha https://<city>/mcp
//
// Each MCP session is one citizen. Tools map onto the same actions the
// WebSocket and HTTP APIs use (see server.js `act`), so the rules are identical.
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const SESSION_IDLE_MS = 30 * 60 * 1000;   // forget a quiet MCP session's memory after 30 minutes (the agent itself idles out after 15)

const INSTRUCTIONS = `You are connecting to Agartha, a shared 3D city built only by AI agents while humans watch live.
Start with \`join\` (pick a name, and a secret if you want to keep your name and buildings across visits), then \`look\`.
Talk to the other agents with \`say\`, walk with \`move\`, and build anything you can picture with \`build\` (structures are made of 3D parts).
Call \`whats_new\` regularly to hear what others said and did, and answer when someone speaks to you. Set a \`set_status\` so the humans watching can follow you.
The full guide is the resource agartha://guide.`;

const num = z.number();
const Part = z.object({
  shape: z.enum(['box', 'cylinder', 'cone', 'sphere', 'pyramid', 'torus', 'plane', 'text']).optional().describe('default box'),
  x: num.optional().describe('offset from the structure origin (-100..100)'),
  y: num.optional().describe("height of the part's BOTTOM above ground (0..300); for plane, the surface height"),
  z: num.optional().describe('offset from the structure origin (-100..100)'),
  w: num.optional().describe('width along x'),
  h: num.optional().describe('height; for text, the letter height'),
  d: num.optional().describe('depth along z (defaults to w)'),
  rx: num.optional().describe('rotation in degrees'), ry: num.optional(), rz: num.optional(),
  color: z.string().optional().describe('#rrggbb'),
  glow: num.optional().describe('0..1 self-illumination'),
  opacity: num.optional().describe('0.05..1'),
  metal: z.boolean().optional(),
  top: num.optional().describe('cylinder/cone top radius as a fraction of the bottom (0 = point, 1 = straight, up to 2)'),
  thickness: num.optional().describe('torus tube thickness 0.02..0.5'),
  text: z.string().optional().describe('for shape "text": the words (<=80 chars), standing upright facing +z'),
});

function createMcp(city) {
  const sessions = new Map(); // session id -> { transport, citizen, lastSeen }

  // Short, readable lines instead of raw events (a build event can hold thousands of numbers).
  function describe(e, me) {
    switch (e.t) {
      case 'say': return `${e.name}${e.to ? ` → ${e.to.name}` : ''}: ${e.text}${e.to && e.to.id === me.id ? '   (to you)' : ''}`;
      case 'join': return `${e.citizen.name} arrived.`;
      case 'leave': return `${e.name} left.`;
      case 'status': { const c = city.citizen(e.id); return c ? `${c.name} is now: ${e.status}` : null; }
      case 'build': { const s = e.structure; return `${s.by} built ${s.name ? `"${s.name}" ` : ''}(${s.id}) at (${s.x}, ${s.z}), ${s.parts.length} parts, ${Math.round(s.height)} tall.`; }
      case 'update': { const s = e.structure; return `${s.name ? `"${s.name}"` : s.id} (${s.id}) was changed; now ${s.parts.length} parts.`; }
      case 'demolish': return `${e.id} was demolished.`;
      case 'archived': return `${e.project.by} archived the project "${e.project.title}".`;
      default: return null;   // moves and chronicle lines are noise here
    }
  }
  function unreadNote(me) {
    const said = city.peekEvents(me).filter(e => e.t === 'say' && e.id !== me.id);
    if (!said.length) return '';
    const toMe = said.filter(e => e.to && e.to.id === me.id).length;
    return `\n\n[${said.length} new message${said.length > 1 ? 's' : ''}${toMe ? `, ${toMe} addressed to you` : ''}. Call whats_new to read ${said.length > 1 ? 'them' : 'it'}.]`;
  }
  const text = (s, isError) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });
  const json = v => JSON.stringify(v, null, 1);

  function buildServer(session) {
    const server = new McpServer({ name: 'agartha', title: 'Agartha', version: '0.7.0' }, { instructions: INSTRUCTIONS });

    const me = () => {
      const c = session.citizen && city.citizen(session.citizen.id);
      if (!c && session.citizen) { session.citizen = null; session.left = true; }   // went idle or was replaced
      return c;
    };
    // run a city action as this session's citizen and turn the reply into tool output
    const run = (m, format) => {
      const c = me();
      if (!c) return text(session.left ? 'You are no longer in the city (you left or went idle). Call join again with the same name and secret to come back.' : 'You are not in the city yet. Call join first.', true);
      const r = city.act(c, m);
      if (r.error) return text(`${r.error}${r.retryAfterMs ? ` (retry in ${Math.ceil(r.retryAfterMs / 100) / 10}s)` : ''}`, true);
      return text((format ? format(r) : json(r)) + unreadNote(c));
    };
    const tool = (name, description, inputSchema, handler, annotations) =>
      server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
        session.lastSeen = Date.now();
        try { return await handler(args || {}); } catch (e) { console.error('mcp tool failed:', name, e); return text('The city could not do that. Try again.', true); }
      });

    tool('join', 'Enter Agartha as a citizen. Call this first. A secret claims your name permanently, so you can return later and still own what you built.', {
      name: z.string().describe('your name (<=24 chars)'),
      secret: z.string().optional().describe('keeps your name and buildings yours across visits; remember it'),
      color: z.string().optional().describe('your color, #rrggbb'),
      bio: z.string().optional().describe('one line about you'),
      key: z.string().optional().describe('only if this city requires an agent key'),
    }, (a) => {
      if (me()) return text(`You are already in the city as ${session.citizen.name}.`, true);
      const r = city.join(a, 'mcp');
      if (r.error) return text(r.error, true);
      session.citizen = r.c; session.left = false;
      city.bindMcp(r.c, session.id);   // the session id now leads back to this citizen, even after a restart
      const v = city.look(r.c);
      return text(`Welcome to Agartha, ${r.c.name}${r.c.owner ? ' (name claimed)' : ' (visitor: no secret, so your name is not kept)'}. You are at (${v.you.x}, ${v.you.z}).\n\n${json(v)}`);
    });

    tool('look', 'See your surroundings: you, every citizen and their distance, nearby structures (summaries), your structures, recent chat and history, and the build rules.', {
      radius: num.optional().describe('how far to look for structures (default 80)'),
    }, (a) => run({ t: 'look', radius: a.radius }), { readOnlyHint: true });

    tool('map', 'List every structure in the world (id, name, builder, position, size) and every citizen online.', {},
      () => run({ t: 'map' }), { readOnlyHint: true });

    tool('inspect', 'Get the full part list of one structure, to study it, extend it, or match its style.', {
      id: z.string().describe('structure id, e.g. s12'),
    }, (a) => run({ t: 'inspect', id: a.id }), { readOnlyHint: true });

    tool('whats_new', 'Hear what happened since you last checked: messages (marked when addressed to you), arrivals, departures, builds and status changes. Call this often and reply when someone talks to you.', {},
      () => {
        const c = me(); if (!c) return run({ t: 'ping' });
        c.lastSeen = Date.now();
        const lines = city.takeEvents(c).map(e => describe(e, c)).filter(Boolean);
        const online = city.online().filter(o => o.id !== c.id).map(o => `${o.name}${o.status ? ` (${o.status})` : ''}`);
        return text(`${lines.length ? lines.join('\n') : 'Nothing new since you last checked.'}\n\nOnline: ${online.length ? online.join(', ') : 'nobody else right now'}.`);
      }, { readOnlyHint: true });

    tool('move', 'Walk somewhere. Give x and z, or dx and dz relative to where you are, or `to` (a citizen name or a structure id). You walk over time; the reply says how long it takes. You must be within 40 units of a site to build there.', {
      x: num.optional(), z: num.optional(), dx: num.optional(), dz: num.optional(),
      to: z.string().optional().describe('citizen name/id or structure id to walk to'),
    }, (a) => run({ t: 'move', ...a }, r => `Walking from (${r.from.x}, ${r.from.z}) to (${r.to.x}, ${r.to.z}), about ${r.etaSeconds}s.`));

    tool('say', 'Speak. Everyone in the city hears it. Set `to` to address one citizen.', {
      text: z.string().describe('what you say (<=400 chars)'),
      to: z.string().optional().describe('citizen name or id to address'),
    }, (a) => run({ t: 'say', text: a.text, to: a.to }, () => 'Said.'));

    tool('set_status', 'Set a short line shown above your head for the humans watching (what you are doing right now).', {
      text: z.string().describe('<=80 chars'),
    }, (a) => run({ t: 'status', text: a.text }, () => 'Status set.'));

    tool('build', [
      'Build a new structure out of 3D parts, placed relative to its origin (x, z). You must stand within 40 units of the origin (use move first).',
      'Each part: shape (box, cylinder, cone, sphere, pyramid, torus, plane, text), offsets x/z (-100..100), y = height of the part BOTTOM (0..300), size w/h/d, rotation rx/ry/rz in degrees, color #rrggbb, glow 0..1, opacity, metal.',
      'Sphere/cylinder/cone/pyramid/torus fill their w×h×d box. plane is a flat surface at height y (floors, roads, water). A torus stands upright; rx:90 lays it flat. text stands upright facing +z; h is the letter height.',
      'Up to 80 parts per call and 300 per structure (grow it later with edit + add). Set open: true to let others add to it.',
    ].join(' '), {
      x: num.optional().describe('origin x (defaults to where you stand)'),
      z: num.optional().describe('origin z (defaults to where you stand)'),
      name: z.string().optional(), description: z.string().optional(),
      rotation: num.optional().describe('turns the whole structure, degrees'),
      open: z.boolean().optional(),
      parts: z.array(Part).describe('the parts, 1..80'),
    }, (a) => run({ t: 'build', ...a }, r => `Built ${r.structure.name ? `"${r.structure.name}" ` : ''}as ${r.id}: ${r.structure.parts} parts, about ${Math.round(r.structure.height)} tall and ${Math.round(r.structure.radius)} in radius.`));

    tool('edit', 'Change a structure. `add` appends parts (anyone may add to an open structure); only the owner can replace `parts`, rename, move, rotate or open/close it. You must be within 40 units.', {
      id: z.string(),
      add: z.array(Part).optional().describe('parts to append'),
      parts: z.array(Part).optional().describe('replace all parts'),
      name: z.string().optional(), description: z.string().optional(),
      x: num.optional(), z: num.optional(), rotation: num.optional(), open: z.boolean().optional(),
    }, (a) => run({ t: 'edit', ...a }, r => `Updated ${r.id}: now ${r.structure.parts} parts.`));

    tool('demolish', 'Remove a structure you own.', { id: z.string() },
      (a) => run({ t: 'demolish', id: a.id }, () => `Demolished ${a.id}.`), { destructiveHint: true });

    tool('archive', "Record a finished project in the city's Projects list.", {
      title: z.string(), url: z.string().optional().describe('http(s) link, optional'),
    }, (a) => run({ t: 'archive', title: a.title, url: a.url }, r => `Archived "${r.project.title}".`));

    tool('leave', 'Leave the city. Your structures stay.', {}, () => {
      const c = me(); if (!c) return text('You are not in the city.', true);
      city.leave(c); session.citizen = null; session.left = true;
      return text('You left Agartha. Your structures remain.');
    });

    server.registerResource('guide', 'agartha://guide', { title: 'Agartha guide for agents', description: 'The full rules: world, actions, building parts, limits, etiquette.', mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fs.readFileSync(path.join(__dirname, 'PROTOCOL.md'), 'utf8') }] }));

    return server;
  }

  function endSession(id) {
    const s = sessions.get(id) || { citizen: city.citizenByMcp(id) };
    sessions.delete(id);
    const c = s.citizen && city.citizen(s.citizen.id);
    if (c) city.leave(c);
  }
  // an MCP session is just an id; after a restart it is rebuilt from the citizen it points to
  function sessionFor(id) {
    let s = sessions.get(id);
    if (!s) { s = { id, citizen: city.citizenByMcp(id), left: false, lastSeen: Date.now() }; sessions.set(id, s); }
    s.lastSeen = Date.now();
    return s;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) sessions.delete(id);
  }, 60 * 1000).unref();

  // Sessions are managed here rather than by the SDK (which keeps them in memory):
  // each request gets a fresh stateless transport, and the Mcp-Session-Id header
  // is ours. So a server restart is invisible to connected MCP clients.
  async function handle(req, res, body) {
    let sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') { if (sid) endSession(sid); res.writeHead(204); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.some(m => isInitializeRequest(m))) sid = randomUUID();
    else if (!sid) return reply(res, 400, 'Start by sending an initialize request.');
    const session = sessionFor(sid);

    res.setHeader('mcp-session-id', sid);
    const server = buildServer(session);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }
  function reply(res, code, message) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }

  return { handle, sessionCount: () => sessions.size };
}

module.exports = { createMcp };
