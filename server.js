/**
 * cp-server — Communication Properly WebSocket + token server
 * Secure version: Origin check + X-CP-App-Key + rate limiting
 *
 * Env vars required on Render:
 *   AZURE_KEY     — Azure Speech subscription key
 *   AZURE_REGION  — e.g. westus2
 *   CP_APP_KEY    — secret shared with Vercel (Layer 2)
 *   PORT          — set automatically by Render
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http    = require('http');
const https   = require('https');

const app    = express();
const server = http.createServer(app);

// ── Config ──────────────────────────────────────────────────────────
const AZURE_KEY    = process.env.AZURE_KEY;
const AZURE_REGION = process.env.AZURE_REGION || 'westus2';
const CP_APP_KEY   = process.env.CP_APP_KEY;          // Layer 2 secret
const PORT         = process.env.PORT || 3000;

// Vercel proxy + loquivox.app are the only allowed callers
const ALLOWED_ORIGINS = [
  'https://loquivox.app',
  'https://cp-app-rho.vercel.app',
];

// ── Layer 3: in-memory rate limiter ─────────────────────────────────
// Max 20 token requests per IP per 60 seconds
const rateLimits = new Map(); // ip → { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}

// Prune stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) {
    if (now > e.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60_000);

// ── CORS ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CP-App-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Security guard for /api/token ────────────────────────────────────
// Layer 1: Origin/Referer must be from an allowed caller
// Layer 2: X-CP-App-Key must match env var
// Layer 3: Rate limit per IP
function guardToken(req, res, next) {
  // Layer 1 — Origin or Referer check
  // Note: server-to-server calls (Vercel → Render) may not send Origin,
  // so we also accept requests that have the correct app key (Layer 2).
  const origin  = req.headers.origin  || '';
  const referer = req.headers.referer || '';
  const originOk = ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));

  // Layer 2 — secret app key
  const keyOk = !CP_APP_KEY || req.headers['x-cp-app-key'] === CP_APP_KEY;

  // Require at least one of: known origin OR correct key
  // (In production both should be true for browser→Vercel→Render path)
  if (!originOk && !keyOk) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Layer 3 — rate limit
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket.remoteAddress
           || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a moment.' });
  }

  next();
}

// ── Azure JWT issuer ─────────────────────────────────────────────────
function fetchAzureToken() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method:   'POST',
      hostname: `${AZURE_REGION}.api.cognitive.microsoft.com`,
      path:     '/sts/v1.0/issueToken',
      headers:  {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': '0',
      },
    }, (r) => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => {
        if (r.statusCode === 200) resolve(data);
        else reject(new Error(`Azure STS HTTP ${r.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── HTTP routes ──────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/token', guardToken, async (_req, res) => {
  if (!AZURE_KEY) {
    return res.status(503).json({ error: 'AZURE_KEY not configured' });
  }
  try {
    const token = await fetchAzureToken();
    res.json({ token, region: AZURE_REGION });
  } catch (err) {
    console.error('[token]', err.message);
    res.status(502).json({ error: 'Token service temporarily unavailable' });
  }
});

// ── WebSocket room engine ────────────────────────────────────────────
// rooms: Map<code, Set<ws>>  — each ws carries .name .lang .currentRoom
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return rooms.has(code) ? makeRoomCode() : code;
}

function broadcast(room, msg, exclude) {
  const data = JSON.stringify(msg);
  for (const ws of room) {
    if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function rosterPayload(room) {
  return {
    type:         'roster',
    participants: [...room].map(ws => ({ name: ws.name, lang: ws.lang })),
  };
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.name        = 'Guest';
  ws.lang        = 'en';
  ws.currentRoom = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    switch (m.type) {
      case 'create': {
        const code = makeRoomCode();
        ws.name        = m.name || 'Guest';
        ws.lang        = m.lang || 'en';
        ws.currentRoom = code;
        const room = new Set([ws]);
        rooms.set(code, room);
        ws.send(JSON.stringify({
          type:         'joined',
          room:         code,
          participants: [{ name: ws.name, lang: ws.lang }],
        }));
        break;
      }

      case 'join': {
        const code = (m.room || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', error: 'Room not found' }));
          return;
        }
        ws.name        = m.name || 'Guest';
        ws.lang        = m.lang || 'en';
        ws.currentRoom = code;
        room.add(ws);
        const participants = [...room].map(w => ({ name: w.name, lang: w.lang }));
        ws.send(JSON.stringify({ type: 'joined', room: code, participants }));
        broadcast(room, rosterPayload(room), ws);   // tell existing members
        break;
      }

      case 'lang': {
        ws.lang = m.lang || ws.lang;
        const room = ws.currentRoom ? rooms.get(ws.currentRoom) : null;
        if (room) broadcast(room, rosterPayload(room), null);
        break;
      }

      case 'utterance':
      case 'partial_utterance':
      case 'audio_chunk': {
        const room = ws.currentRoom ? rooms.get(ws.currentRoom) : null;
        if (room) broadcast(room, m, ws);   // relay to everyone else in the room
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.currentRoom) return;
    const room = rooms.get(ws.currentRoom);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.currentRoom);
    } else {
      broadcast(room, rosterPayload(room), null);
    }
  });

  ws.on('error', (err) => console.warn('[ws error]', err.message));
});

// ── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`cp-server listening on port ${PORT}`);
  console.log(`Security layers: Origin=${ALLOWED_ORIGINS.join(',')} | AppKey=${CP_APP_KEY ? 'SET' : 'NOT SET'} | RateLimit=20/min`);
});
