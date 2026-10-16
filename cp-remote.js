/**
 * cp-remote.js — Appel traduit à distance pour Loquivox
 * À inclure dans index.html : <script src="cp-remote.js"></script>
 *
 * Dépend du SDK Azure Speech déjà chargé par l'app (SpeechSDK).
 *
 * Public API:
 *   CPRemote.create(opts)          — create a room, returns Promise<{room}>
 *   CPRemote.join(code, opts)      — join a room, returns Promise<{room}>
 *   CPRemote.startSpeaking()       — begin STT + translation broadcast
 *   CPRemote.stopSpeaking()        — stop STT
 *   CPRemote.startAudioStream()    — stream raw microphone audio to room (original voice)
 *   CPRemote.stopAudioStream()     — stop audio streaming
 *   CPRemote.setLanguage(code, speechCode)
 *   CPRemote.leave()               — disconnect
 *   CPRemote.on(cb)                — event callback: (type, data) => {}
 *   CPRemote.room                  — current room code
 *   CPRemote.peers                 — current participants array
 *
 * Events emitted via on(cb):
 *   joined          — {room, participants}
 *   roster          — {participants}
 *   partial         — {text}  (your own interim speech, local only)
 *   final           — {original, translations}  (your own final speech, local only)
 *   utterance       — {srcLang, original, translations}  (from server)
 *   partial_utterance — {srcLang, original, translations}  (interim, from server)
 *   audio_chunk     — {data, mimeType, isFirst, seq}  (raw audio from speaker)
 *   audio_started   — {mimeType}
 *   audio_error     — {error}
 *   invite          — {room}  (auto-detected join from URL hash)
 *   closed          — {}
 *   error           — {error}
 */
(function () {
  const CP_SERVER_URL = 'https://cp-server-kdbg.onrender.com';
  const WS_URL = CP_SERVER_URL.replace(/^http/, 'ws') + '/ws';
  // CORS proxy on Vercel — browser can fetch this without CORS errors
  const CP_TOKEN_URL = 'https://cp-app-rho.vercel.app/api/token';

  const state = {
    ws: null,
    room: null,
    myName: 'Guest',
    myLang: 'en',
    mySpeechLang: 'en-US',
    peers: [],
    recognizer: null,
    ttsQueue: Promise.resolve(),
    ttsEnabled: true,
    onEvent: () => {},
  };

  // ── Azure token ──────────────────────────────────────────────────
  // Returns {token, region, isKey:false} — token is always served by the CP server.
  // Everyone shares the same Azure key via the server; no per-user key required.
  async function getAzureToken() {
    // Fast path — server already awake
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(CP_TOKEN_URL, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) return { ...(await r.json()), isKey: false };
    } catch (_) {}

    // Server may be waking (Render free tier sleeps after 15 min) — retry with 45s window
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 45000);
      const r = await fetch(CP_TOKEN_URL, { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) return { ...(await r.json()), isKey: false };
    } catch (_) {}

    throw new Error('Translation service unavailable. Please try again in a moment.');
  }

  function makeSpeechTranslationConfig({ token, region, isKey }) {
    return isKey
      ? SpeechSDK.SpeechTranslationConfig.fromSubscription(token, region)
      : SpeechSDK.SpeechTranslationConfig.fromAuthorizationToken(token, region);
  }

  function makeSpeechConfig({ token, region, isKey }) {
    return isKey
      ? SpeechSDK.SpeechConfig.fromSubscription(token, region)
      : SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  }

  // ── WebSocket connection ─────────────────────────────────────────
  function connect(action, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      state.ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: action,
          room: opts.room,
          name: state.myName,
          lang: state.myLang,
        }));
      };

      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.type === 'joined') {
          state.room = m.room;
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('joined', m);
          resolve(m);
        } else if (m.type === 'roster') {
          const prevLangs = new Set(state.peers.map(p => p.lang));
          state.peers = m.participants.filter(p => p.name !== state.myName);
          state.onEvent('roster', m);
          // If a peer joined whose language isn't covered by the active recognizer,
          // restart STT so translations include their language (simultaneous for all)
          if (state.recognizer) {
            const hasNewLang = state.peers.some(p => p.lang && !prevLangs.has(p.lang));
            if (hasNewLang) {
              stopSpeaking();
              setTimeout(() => startSpeaking(), 500);
            }
          }
        } else if (m.type === 'utterance') {
          // Final translated utterance from any room participant
          state.onEvent('utterance', m);
          speakTranslation(m);
        } else if (m.type === 'partial_utterance') {
          // Interim/streaming translation for instant preview
          state.onEvent('partial_utterance', m);
        } else if (m.type === 'audio_chunk') {
          // Raw audio from the speaker for original voice playback
          state.onEvent('audio_chunk', m);
        } else if (m.type === 'error') {
          state.onEvent('error', m);
          reject(new Error(m.error));
        }
      };

      ws.onclose = () => state.onEvent('closed', {});
      ws.onerror = () => reject(new Error('Cannot connect to Loquivox conference server'));
    });
  }

  // ── STT + translation → broadcast to room ───────────────────────
  async function startSpeaking() {
    const creds = await getAzureToken();
    const cfg = makeSpeechTranslationConfig(creds);
    cfg.speechRecognitionLanguage = state.mySpeechLang;

    const targets = [...new Set(state.peers.map(p => p.lang))].filter(l => l && l !== state.myLang);
    if (targets.length === 0) {
      // No peers known yet — pre-target common languages so audio works
      // as soon as someone joins (roster restart will refine this)
      ['en', 'fr', 'es', 'pt', 'ht', 'de']
        .filter(l => l !== state.myLang)
        .slice(0, 5)
        .forEach(l => targets.push(l));
    }
    // Azure allows max 6 target languages
    if (targets.length > 6) targets.length = 6;
    targets.forEach(l => cfg.addTargetLanguage(l));

    const audio = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const rec = new SpeechSDK.TranslationRecognizer(cfg, audio);
    state.recognizer = rec;

    // Interim results → instant preview for attendees
    rec.recognizing = (_s, e) => {
      const text = e.result.text;
      state.onEvent('partial', { text });

      // Broadcast partial translation so attendees see text as you speak
      if (state.ws?.readyState === WebSocket.OPEN && text) {
        const pt = {};
        targets.forEach(l => {
          const t = e.result.translations.get(l);
          if (t) pt[l] = t;
        });
        if (Object.keys(pt).length > 0) {
          state.ws.send(JSON.stringify({
            type: 'partial_utterance',
            srcLang: state.myLang,
            original: text,
            translations: pt,
          }));
        }
      }
    };

    // Final recognized sentence → broadcast with full translations
    rec.recognized = (_s, e) => {
      if (e.result.reason !== SpeechSDK.ResultReason.TranslatedSpeech || !e.result.text) return;
      const translations = {};
      targets.forEach(l => { translations[l] = e.result.translations.get(l); });
      state.onEvent('final', { original: e.result.text, translations });
      state.ws?.send(JSON.stringify({
        type: 'utterance',
        srcLang: state.myLang,
        original: e.result.text,
        translations,
      }));
    };

    rec.startContinuousRecognitionAsync();
  }

  function stopSpeaking() {
    state.recognizer?.stopContinuousRecognitionAsync(() => {
      state.recognizer?.close();
      state.recognizer = null;
    });
  }

  // ── Original voice streaming ─────────────────────────────────────
  let mediaRecorder = null;
  let audioStream = null;
  let _rekeyInterval = null;   // periodic MediaRecorder restart for late joiners

  async function startAudioStream() {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000 }
      });

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find(t => MediaRecorder.isTypeSupported(t)) || 'audio/webm';

      // Starts (or restarts) the MediaRecorder — chunkIndex resets to 0 so
      // receivers get a fresh isFirst=true init segment with every re-key.
      function startRecorder() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
        let chunkIndex = 0;
        mediaRecorder = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 24000 });

        mediaRecorder.ondataavailable = async (e) => {
          if (e.data.size === 0 || state.ws?.readyState !== WebSocket.OPEN) return;
          const buf = await e.data.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          bytes.forEach(b => { binary += String.fromCharCode(b); });
          const base64 = btoa(binary);

          state.ws.send(JSON.stringify({
            type: 'audio_chunk',
            from: state.myName,   // sender identity so receivers route per-speaker
            data: base64,
            mimeType,
            isFirst: chunkIndex === 0,
            seq: chunkIndex,
          }));
          chunkIndex++;
        };

        mediaRecorder.start(200); // 200ms chunks → ~4 per second, low latency
      }

      startRecorder();
      state.onEvent('audio_started', { mimeType });

      // Re-key every 10 s: restarts the recorder so a new isFirst=true init
      // segment is broadcast — any device that joined in the last 10 s will
      // receive the codec header and can begin decoding immediately.
      _rekeyInterval = setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN && audioStream?.active) {
          startRecorder();
        }
      }, 10000);

    } catch (err) {
      console.warn('[CPRemote] Audio stream error:', err);
      state.onEvent('audio_error', { error: err.message });
    }
  }

  function stopAudioStream() {
    if (_rekeyInterval) { clearInterval(_rekeyInterval); _rekeyInterval = null; }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder = null;
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
  }

  // ── Shared AudioContext (unlocked on first user interaction) ────
  // iOS/Android block audio until a user gesture — this context is
  // created on first use and exposed so index.html can unlock it too.
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    return _audioCtx;
  }
  // Expose for index.html to pre-unlock on first tap
  window._getRemoteAudioCtx = getAudioCtx;

  // ── TTS: play received translation through speakers ──────────────
  const HT_TTS_URL = 'https://cp-app-rho.vercel.app/api/ht-tts';

  const TTS_VOICES = {
    fr: 'fr-CA-JeanNeural',     en: 'en-US-GuyNeural',
    es: 'es-MX-JorgeNeural',   de: 'de-DE-ConradNeural',
    pt: 'pt-BR-AntonioNeural',  ar: 'ar-SA-HamedNeural',
    zh: 'zh-CN-YunxiNeural',    ja: 'ja-JP-KeitaNeural',
    ko: 'ko-KR-InJoonNeural',   ru: 'ru-RU-DmitryNeural',
    hi: 'hi-IN-MadhurNeural',   it: 'it-IT-DiegoNeural',
    nl: 'nl-NL-MaartenNeural',  pl: 'pl-PL-MarekNeural',
    sv: 'sv-SE-MattiasNeural',  tr: 'tr-TR-AhmetNeural',
    sw: 'sw-KE-RafikiNeural',   el: 'el-GR-NestorasNeural',
    vi: 'vi-VN-NamMinhNeural',  ht: 'fr-CA-JeanNeural',
  };

  function speakTranslation(m) {
    if (!state.ttsEnabled) return;
    const text = m.translations?.[state.myLang];
    if (!text) return;

    // Queue TTS so overlapping utterances play in order
    state.ttsQueue = state.ttsQueue.then(() => new Promise(async (resolve) => {
      try {
        const ctx = getAudioCtx(); // always use pre-unlocked AudioContext
          // Azure TTS REST API — bypass SDK's internal AudioContext (which starts suspended)
          const creds = await getAzureToken();
          const voice = TTS_VOICES[state.myLang] || 'en-US-GuyNeural';
          const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voice}'>${escaped}</voice></speak>`;
          const r = await fetch(`https://${creds.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + creds.token,
              'Content-Type': 'application/ssml+xml',
              'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
              'User-Agent': 'Loquivox',
            },
            body: ssml,
          });
          if (!r.ok) { console.warn('[CPRemote] TTS HTTP', r.status); resolve(); return; }
          const buf = await r.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf.slice(0));
          const src = ctx.createBufferSource();
          src.buffer = decoded;
          src.connect(ctx.destination);
          src.onended = resolve;
          src.start(0);
      } catch (err) {
        console.warn('[CPRemote] TTS error:', err);
        resolve();
      }
    }));
  }

  // ── Change language mid-call ─────────────────────────────────────
  function setLanguage(shortCode, speechCode) {
    state.myLang = shortCode;
    state.mySpeechLang = speechCode;
    state.ws?.send(JSON.stringify({ type: 'lang', lang: shortCode }));
  }

  // ── Public API ───────────────────────────────────────────────────
  window.CPRemote = {
    create:          (o) => { Object.assign(state, mapOpts(o)); return connect('create'); },
    join:            (code, o) => { Object.assign(state, mapOpts(o)); return connect('join', { room: code }); },
    startSpeaking,
    stopSpeaking,
    startAudioStream,
    stopAudioStream,
    setLanguage,
    leave:           () => { stopSpeaking(); stopAudioStream(); state.ws?.close(); },
    on:              (cb) => { state.onEvent = cb; },
    setTTS:          (v) => { state.ttsEnabled = !!v; },
    sendRaw:         (obj) => state.ws?.send(JSON.stringify(obj)),
    get room()       { return state.room; },
    get peers()      { return state.peers; },
  };

  function mapOpts(o = {}) {
    return {
      myName:       o.name       || 'Guest',
      myLang:       o.lang       || 'en',
      mySpeechLang: o.speechLang || 'en-US',
    };
  }

  // Auto-join via shared link …/#join=K7Q2
  window.addEventListener('load', () => {
    // Wake Render server proactively (free tier sleeps after 15 min inactivity)
    fetch(CP_TOKEN_URL, { method: 'HEAD' }).catch(() => {});
    const match = location.hash.match(/join=([A-Za-z0-9]{4})/i);
    if (match) state.onEvent('invite', { room: match[1].toUpperCase() });
  });
})();
