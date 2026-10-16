export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const text = req.query.text;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }

  try {
    // Get Azure token from CP server
    const tokenRes = await fetch('https://cp-server-kdbg.onrender.com/api/token');
    if (!tokenRes.ok) { res.status(502).json({ error: 'token fetch failed' }); return; }
    const { token, region } = await tokenRes.json();

    // Use Azure TTS with Canadian French voice (closest available for Haitian Creole)
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ssml = `<speak version='1.0' xml:lang='fr-CA'><voice name='fr-CA-JeanNeural'>${escaped}</voice></speak>`;

    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        'User-Agent': 'Loquivox',
      },
      body: ssml,
    });

    if (!r.ok) { res.status(r.status).json({ error: 'Azure TTS error' }); return; }
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
