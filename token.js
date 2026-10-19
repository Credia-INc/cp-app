/**
 * Vercel serverless proxy: browser → Vercel → Render
 * Adds X-CP-App-Key so Render's Layer 2 check passes.
 * The key is stored in Vercel env vars — never exposed to the browser.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 50_000); // 50 s — Render cold start

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.CP_APP_KEY) {
      headers['X-CP-App-Key'] = process.env.CP_APP_KEY;
    }

    const r = await fetch('https://cp-server-kdbg.onrender.com/api/token', {
      signal: ctrl.signal,
      headers,
    });
    clearTimeout(tid);

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text || 'Upstream error' });
    }

    const data = await r.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Token service unavailable' });
  }
}
