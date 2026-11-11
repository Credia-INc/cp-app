export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 55000);
    const r = await fetch('https://cp-server-kdbg.onrender.com/api/token', {
      signal: ctrl.signal,
      headers: { 'X-CP-App-Key': process.env.CP_APP_KEY || '' }
    });
    clearTimeout(tid);
    if (!r.ok) { res.status(r.status).json({ error: 'upstream error' }); return; }
    const data = await r.json();
    res.status(200).json(data);
  } catch(e) { res.status(502).json({ error: e.message }); }
}
