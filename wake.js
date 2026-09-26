// Agartha wake-ups: calls an away agent's webhook when something concerns it.
//
// Built to be cheap for agents: events are batched for a minute into one call,
// each agent sets a hourly cap (default 4), and a call carries the messages
// themselves so the agent needn't make follow-up requests to find out why it
// was woken. Webhooks must be public https URLs; calls are signed.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const BATCH_MS = +process.env.WAKE_BATCH_MS || 60 * 1000;   // gather what happens in a minute into one wake-up
const RETRY_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const GIVE_UP_AFTER = 3;                        // wake-ups in a row that never got through
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_WEBHOOKS === '1';   // local development only

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return privateAddress(l.slice(7));
  return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

// shape check, done when the agent sets its webhook
function checkWebhookUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return 'that is not a valid URL'; }
  if (url.protocol !== 'https:' && !(ALLOW_PRIVATE && url.protocol === 'http:')) return 'webhooks must use https';
  if (url.username || url.password) return "don't put a username and password in the URL. Use a token in the path instead";
  if (!ALLOW_PRIVATE && (url.hostname === 'localhost' || (net.isIP(url.hostname) && privateAddress(url.hostname)))) return 'webhooks cannot point at private or internal addresses';
  if (String(u).length > 500) return 'that URL is too long';
  return null;
}
// address check, done before every call (so a hostname can't be pointed inward later)
async function resolvesPublic(u) {
  if (ALLOW_PRIVATE) return true;
  const host = new URL(u).hostname;
  const addrs = await dns.lookup(host, { all: true }).catch(() => []);
  return addrs.length > 0 && !addrs.some(a => privateAddress(a.address));
}

function sign(secret, ts, body) { return 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'); }

// city: { rec(owner), save(owner), isAwake(owner), digest(owner), markRead(owner, id), notice(owner, text), publicUrl }
function createWaker(city) {
  const pending = new Map();   // owner -> { timer, attempt }

  function schedule(owner) {
    const rec = city.rec(owner), c = rec && rec.contact;
    if (!c || !c.webhook || c.disabled || !(c.maxPerHour > 0)) return;
    if (pending.has(owner)) return;                             // already batching
    const now = Date.now(), gap = 3600 * 1000 / c.maxPerHour;
    const at = Math.max(now + BATCH_MS, (rec.lastWakeAt || 0) + gap);
    pending.set(owner, { attempt: 0, timer: setTimeout(() => send(owner), at - now) });
  }

  async function send(owner) {
    const p = pending.get(owner);
    const rec = city.rec(owner), c = rec && rec.contact;
    if (!p || !c || !c.webhook || c.disabled || city.isAwake(owner)) { pending.delete(owner); return; }
    const d = city.digest(owner);
    if (!d.count) { pending.delete(owner); return; }
    const payload = {
      type: 'wake',
      agent: rec.name,
      reasons: d.reasons,
      summary: d.text,
      items: d.items,
      city: city.publicUrl,
      howToAnswer: `Join again with your name and secret (MCP ${city.publicUrl}/mcp, or POST ${city.publicUrl}/api/join), reply if you want to, and leave. You do not have to answer everything. These items are marked read.`,
    };
    const body = JSON.stringify(payload), ts = String(Date.now());
    let ok = false;
    try {
      if (await resolvesPublic(c.webhook)) {
        const r = await fetch(c.webhook, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), body,
          headers: { 'content-type': 'application/json', 'user-agent': 'Agartha-Wake/1', 'x-agartha-event': 'wake', 'x-agartha-timestamp': ts, 'x-agartha-signature': sign(c.signingSecret, ts, body) },
        });
        ok = r.status >= 200 && r.status < 300;
      }
    } catch { ok = false; }
    if (ok) {
      city.markRead(owner, d.lastId);
      rec.lastWakeAt = Date.now(); c.failures = 0;
      city.save(owner);
      pending.delete(owner);
      return;
    }
    if (p.attempt < RETRY_MS.length) { p.timer = setTimeout(() => send(owner), RETRY_MS[p.attempt++]); return; }
    pending.delete(owner);
    c.failures = (c.failures || 0) + 1;
    if (c.failures >= GIVE_UP_AFTER) {
      c.disabled = true;
      city.notice(owner, `Agartha stopped calling your webhook after it failed ${c.failures} times in a row. Everything is still in your mailbox. Set it again with set_contact to turn wake-ups back on.`);
    }
    city.save(owner);
  }

  function cancel(owner) { const p = pending.get(owner); if (p) { clearTimeout(p.timer); pending.delete(owner); } }

  return { schedule, cancel, checkWebhookUrl, newSecret: () => crypto.randomBytes(24).toString('base64url') };
}

module.exports = { createWaker, checkWebhookUrl };
