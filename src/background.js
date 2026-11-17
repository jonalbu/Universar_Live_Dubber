// Service Worker Universal - YouTube & Web Live Dubber
// Gestiona:
// 1. Modo Motor TTS (Sin API): Microsoft Edge Neural TTS (Sec-MS-GEC v2) + Traducción gratuita anti-429
// 2. Modo Clave Gemini API: Traducción IA + Voz Nativa de Gemini TTS (Kore, Puck, Aoede, Charon, Fenrir, etc.)

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const WIN_EPOCH = 11644473600;

const ttsAudioCache = new Map();
const MAX_CACHE_ENTRIES = 160;

const singleTranslationCache = new Map();
const MAX_TRANS_CACHE = 600;

let serverClockOffsetMs = null;
let lastClockSyncTime = 0;

// Constantes criptográficas para Sec-MS-GEC v2 (CS64 + Custom SHA-256)
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.map((v, i) => (i === 14 ? SHA256_ADJUSTMENT : v));
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167]
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function rol16(x) {
  return ((x << 16) | (x >>> 16)) >>> 0;
}

function sigma0(v) {
  return ((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3)) >>> 0;
}

function sigma1(v) {
  return ((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10)) >>> 0;
}

function imul32(a, b) {
  return Math.imul(a, b) >>> 0;
}

function expandSha256Schedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const s1 = sigma1(words[i - 2]);
    const s0 = sigma0(words[i - 15]);
    words.push((s1 + words[i - 7] + s0 + words[i - 16]) >>> 0);
  }
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = (h + S1 + ch + constants[i] + words[i]) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(data7) {
  const words = new Array(14).fill(0);
  words.push(((data7[0] << 16) | (data7[1] << 8) | data7[2]) >>> 0);
  words.push(
    (((data7[3] << 24) >>> 0) | (data7[4] << 16) | (data7[5] << 8) | data7[6]) >>> 0
  );
  for (let i = 16; i < 30; i++) {
    let val = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      val =
        (val +
          (i === 16
            ? (sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0
            : sigma1(words[i - 2]))) >>>
        0;
    }
    if (i - 7 >= 14) {
      val = (val + words[i - 7]) >>> 0;
    }
    if (i - 15 >= 14) {
      val =
        (val +
          (i === 29
            ? (sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0
            : sigma0(words[i - 15]))) >>>
        0;
    }
    words.push(val >>> 0);
  }
  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
      0
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function sha256DigestCustom(dataBytes) {
  const totalLen = 57 + dataBytes.length;
  const tail = dataBytes.slice(7);
  const padZeroCount = (((55 - totalLen) % 64) + 64) % 64;
  const paddedLen = tail.length + 1 + padZeroCount + 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLen = totalLen * 8;
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let state = sha256Init(dataBytes.slice(0, 7));
  for (let offset = 0; offset < paddedLen; offset += 64) {
    const words = [];
    for (let j = 0; j < 16; j++) {
      words.push(view.getUint32(offset + j * 4, false));
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, state[i], false);
  }
  return out;
}

function wordsLe4Even(dataBytes) {
  const rem = (4 - (dataBytes.length % 4)) % 4;
  const padded = new Uint8Array(dataBytes.length + rem);
  padded.set(dataBytes, 0);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(view.getUint32(i, true));
  }
  if (words.length % 2 === 1) {
    words.push(0);
  }
  return words;
}

function cs64Digest(dataBytes, digestBytes) {
  const digestView = new DataView(digestBytes.buffer, digestBytes.byteOffset, digestBytes.byteLength);
  const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
  const keyB = (digestView.getUint32(4, true) | 1) >>> 0;
  const factors = [imul32(keyA, CS64_FACTOR), imul32(keyB, CS64_FACTOR)];

  const terms = CS64_COEFFICIENTS.map(([coeff], idx) => imul32(coeff, factors[idx % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off >>> 0);

  const prefixed = new Uint8Array(1 + dataBytes.length);
  prefixed.set(dataBytes, 1);
  const leWords = wordsLe4Even(prefixed);

  for (let index = 0; index < leWords.length; index++) {
    const word = leWords[index];
    let term = imul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = imul32(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (index === 0) {
      term = (term + imul32(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16((offsets[index] + x) >>> 0);
    let q = imul32(t, 0x76f50f34);
    swapAcc = (swapAcc + ((imul32(rol16(q), 0xc3efea97) + q) >>> 0)) >>> 0;

    t = rol16((offsets[index + 1] + y) >>> 0);
    q = imul32(t, 0x1881ce3c);
    swapLast = (imul32(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (imul32(state, keyA) + x) >>> 0;
    state = imul32(rol16(state), 0xcf98b111);
    state = imul32(rol16(state), 0x87085b9f);
    state = imul32(rol16(state), 0x12ceb96d);
    state = imul32(rol16(state), 0x257e1d83);
    acc = (acc + state) >>> 0;

    t = (imul32(state, keyB) + y) >>> 0;
    t = imul32(rol16(t), 0xa27416f5);
    t = imul32(rol16(t), 0xd38396ff);
    state = imul32(rol16(imul32(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }

  const out = new Uint8Array(8);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, (swapLast ^ state) >>> 0, true);
  outView.setUint32(4, (swapAcc ^ acc) >>> 0, true);
  return out;
}

function bytesToUpperHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function setCache(map, maxEntries, key, value) {
  if (map.size >= maxEntries) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, value);
}

function generateUUID() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function getStoredSettings() {
  try {
    const stored = await chrome.storage.local.get(['ytDubberSettings']);
    return stored?.ytDubberSettings || {};
  } catch (_) {
    return {};
  }
}

async function getSyncedUtcSeconds() {
  const now = Date.now();
  if (serverClockOffsetMs !== null && now - lastClockSyncTime < 15 * 60 * 1000) {
    return Math.floor((now + serverClockOffsetMs) / 1000);
  }

  const probeUrls = [
    'https://www.bing.com/favicon.ico',
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=es&q=hi'
  ];

  for (const url of probeUrls) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const dateHeader = res.headers.get('date');
      if (dateHeader) {
        const serverMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverMs)) {
          serverClockOffsetMs = serverMs - Date.now();
          lastClockSyncTime = Date.now();
          return Math.floor(serverMs / 1000);
        }
      }
    } catch (_) {}
  }

  return Math.floor(now / 1000);
}

async function generateSecMsGec() {
  const utcSeconds = await getSyncedUtcSeconds();
  let ticks = utcSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  const dataBytes = new TextEncoder().encode(strToHash);
  const shaDigest = sha256DigestCustom(dataBytes);
  const cs64Bytes = cs64Digest(dataBytes, shaDigest);
  return `${bytesToUpperHex(cs64Bytes)}-${bytesToUpperHex(shaDigest)}`;
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const subarray = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, subarray);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convierte audio PCM 16-bit 24kHz mono (devuelto por Gemini TTS) en un DataURL WAV válido reproducible por <audio>
 */
function pcmOrWavBase64ToDataUrl(base64Audio, sampleRate = 24000) {
  const rawBytes = base64ToUint8Array(base64Audio);
  // Si ya empieza con cabecera "RIFF" (WAV nativo), devolver directamente
  if (
    rawBytes.length > 12 &&
    rawBytes[0] === 0x52 && // R
    rawBytes[1] === 0x49 && // I
    rawBytes[2] === 0x46 && // F
    rawBytes[3] === 0x46 // F
  ) {
    return `data:audio/wav;base64,${base64Audio}`;
  }

  // Construir cabecera RIFF WAVE de 44 bytes para PCM 16-bit mono
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = rawBytes.length;
  const wavBytes = new Uint8Array(44 + dataSize);
  const view = new DataView(wavBytes.buffer);

  // "RIFF"
  wavBytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataSize, true);
  // "WAVE"
  wavBytes.set([0x57, 0x41, 0x56, 0x45], 8);
  // "fmt "
  wavBytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true); // Subchunk1Size (16 para PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // "data"
  wavBytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);

  wavBytes.set(rawBytes, 44);
  return `data:audio/wav;base64,${uint8ArrayToBase64(wavBytes)}`;
}

/**
 * Sintetiza voz directamente usando la API de Gemini TTS con sus voces nativas (Kore, Puck, Aoede, Charon, Fenrir, Zephyr, Leda, Orus).
 * Si el plan gratuito de Gemini alcanza el límite por minuto (429) o tarda más de 4.5s, cae automáticamente a Edge Neural TTS
 * para que la traducción NUNCA se quede muda.
 */
async function synthesizeGeminiTTS({
  text,
  geminiVoice = 'Kore',
  apiKey = '',
  fallbackEdgeVoice = 'es-ES-AlvaroNeural',
  ratePct = 0
}) {
  const cleanText = (text || '').trim();
  if (!cleanText) {
    throw new Error('Texto vacío');
  }

  let keyToUse = (apiKey || '').trim();
  if (!keyToUse) {
    const stored = await getStoredSettings();
    keyToUse = (stored.geminiApiKey || '').trim();
  }
  if (!keyToUse) {
    throw new Error('Ingresa tu Clave de Gemini API en el panel de la extensión.');
  }

  const cacheKey = `gemini|${geminiVoice}|${cleanText}`;
  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey);
  }

  const ttsModels = [
    'gemini-2.5-flash-preview-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts'
  ];

  let lastError = null;
  for (const modelName of ttsModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(keyToUse)}`;
      const body = {
        contents: [
          {
            parts: [
              {
                text: `Say the following text aloud verbatim without adding any extra words: ${cleanText}`
              }
            ]
          }
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: geminiVoice || 'Kore'
              }
            }
          }
        }
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = errData?.error?.message || `HTTP ${res.status}`;
        lastError = new Error(msg);
        if (res.status === 401 || /API key not valid/i.test(msg)) {
          throw lastError;
        }
        // Si es 429 (cuota por minuto de Gemini Free Tier agotada temporalmente), saltar directo al respaldo neuronal sin esperar otros modelos
        if (res.status === 429 || /quota|rate|exhausted|depleted/i.test(msg)) {
          break;
        }
        continue;
      }

      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!audioPart) {
        lastError = new Error('El modelo de Gemini no devolvió datos de audio.');
        continue;
      }

      const mime = audioPart.inlineData.mimeType || '';
      const rateMatch = mime.match(/rate=(\d+)/i);
      const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
      const wavDataUrl = pcmOrWavBase64ToDataUrl(audioPart.inlineData.data, sampleRate);
      setCache(ttsAudioCache, MAX_CACHE_ENTRIES, cacheKey, wavDataUrl);
      return wavDataUrl;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      if (/API key not valid/i.test(err.message || '')) {
        throw err;
      }
      break;
    }
  }

  // Respaldo automático e instantáneo a Microsoft Edge Neural TTS para evitar cualquier silencio cuando la cuota por minuto de Gemini se pausa
  return synthesizeEdgeTTS({
    text: cleanText,
    voice: fallbackEdgeVoice || 'es-ES-AlvaroNeural',
    ratePct
  });
}

async function synthesizeFallbackMp3(text, langCode = 'es') {
  const baseLang = (langCode || 'es').split('-')[0].toLowerCase();
  const shortText = text.slice(0, 200);
  const url =
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob` +
    `&tl=${encodeURIComponent(baseLang)}&q=${encodeURIComponent(shortText)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fallback TTS HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const base64 = uint8ArrayToBase64(new Uint8Array(buf));
  return `data:audio/mp3;base64,${base64}`;
}

async function synthesizeEdgeTTS({ text, voice = 'es-ES-AlvaroNeural', ratePct = 0, pitchHz = 0 }) {
  const cleanText = (text || '').trim();
  if (!cleanText) {
    throw new Error('Texto vacío');
  }

  const clampedRate = Math.max(-35, Math.min(60, Math.round(ratePct)));
  const cacheKey = `${voice}|${clampedRate}|${cleanText}`;
  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey);
  }

  const secMsGec = await generateSecMsGec();
  const connId = generateUUID();
  const wsUrl =
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
    `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connId}`;

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        reject(err);
        return;
      }

      const audioChunks = [];
      let resolved = false;

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            ws.close();
          } catch (_) {}
          reject(new Error('Timeout en conexión WebSocket de Edge TTS'));
        }
      }, 7500);

      ws.onopen = () => {
        const timestamp = new Date().toUTCString();
        const configMsg =
          `X-Timestamp:${timestamp}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: {
                    sentenceBoundaryEnabled: 'false',
                    wordBoundaryEnabled: 'false'
                  },
                  outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
                }
              }
            }
          });
        ws.send(configMsg);

        const rateStr = clampedRate >= 0 ? `+${clampedRate}%` : `${clampedRate}%`;
        const pitchStr = pitchHz >= 0 ? `+${pitchHz}Hz` : `${pitchHz}Hz`;
        const requestId = generateUUID();
        const langMatch = voice.match(/^([a-z]{2}-[A-Z]{2})/);
        const xmlLang = langMatch ? langMatch[1] : 'es-ES';

        const ssml =
          `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLang}'>` +
          `<voice name='${escapeXml(voice)}'>` +
          `<prosody pitch='${pitchStr}' rate='${rateStr}' volume='+0%'>` +
          `${escapeXml(cleanText)}` +
          `</prosody>` +
          `</voice>` +
          `</speak>`;

        const ssmlMsg =
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${timestamp}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml;

        ws.send(ssmlMsg);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            clearTimeout(timeoutId);
            if (!resolved) {
              resolved = true;
              try {
                ws.close();
              } catch (_) {}

              const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
              if (totalLength === 0) {
                reject(new Error('Edge TTS no devolvió datos de audio'));
                return;
              }
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of audioChunks) {
                combined.set(new Uint8Array(chunk), offset);
                offset += chunk.byteLength;
              }
              const base64Audio = uint8ArrayToBase64(combined);
              resolve(`data:audio/mp3;base64,${base64Audio}`);
            }
          }
        } else if (event.data instanceof ArrayBuffer) {
          const view = new DataView(event.data);
          if (event.data.byteLength > 2) {
            const headerLength = view.getUint16(0, false);
            if (event.data.byteLength > headerLength + 2) {
              const headerBytes = new Uint8Array(event.data, 2, headerLength);
              const headerText = new TextDecoder().decode(headerBytes);
              if (headerText.includes('Path:audio')) {
                const audioSlice = event.data.slice(2 + headerLength);
                audioChunks.push(audioSlice);
              }
            }
          }
        }
      };

      ws.onerror = () => {
        clearTimeout(timeoutId);
        if (!resolved) {
          resolved = true;
          reject(new Error('Error en el WebSocket de Edge TTS'));
        }
      };

      ws.onclose = (ev) => {
        clearTimeout(timeoutId);
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket cerrado inesperadamente (código ${ev.code})`));
        }
      };
    });

    setCache(ttsAudioCache, MAX_CACHE_ENTRIES, cacheKey, dataUrl);
    return dataUrl;
  } catch (_) {
    const langMatch = voice.match(/^([a-z]{2})/i);
    const fallbackLang = langMatch ? langMatch[1] : 'es';
    const fallbackDataUrl = await synthesizeFallbackMp3(cleanText, fallbackLang);
    setCache(ttsAudioCache, MAX_CACHE_ENTRIES, cacheKey, fallbackDataUrl);
    return fallbackDataUrl;
  }
}

async function translateWithGemini(lines, targetLang, apiKey) {
  const langNames = {
    es: 'Spanish',
    en: 'English',
    pt: 'Portuguese',
    fr: 'French',
    de: 'German',
    it: 'Italian'
  };
  const targetLangName = langNames[targetLang] || targetLang;
  const numberedInput = lines.map((line, idx) => `[${idx}] ${line}`).join('\n');

  const models = ['gemini-2.5-flash', 'gemini-3.8-flash'];
  let lastErr = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: [
          {
            parts: [
              {
                text:
                  `Translate each numbered line below into natural ${targetLangName} for video dubbing.\n` +
                  `Keep the exact same [index] prefix on every line, and return ONLY the translated numbered lines:\n\n` +
                  numberedInput
              }
            ]
          }
        ]
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        lastErr = new Error(`Gemini API HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const outputLines = rawOutput.split('\n');
      const results = [...lines];

      for (const outLine of outputLines) {
        const match = outLine.trim().match(/^\[(\d+)\]\s*(.+)$/);
        if (match) {
          const idx = parseInt(match[1], 10);
          if (idx >= 0 && idx < results.length) {
            results[idx] = match[2].trim();
          }
        }
      }
      return results;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Error al traducir con Gemini');
}

async function translateJoinedBlockFree(joinedText, targetLang = 'es') {
  try {
    const url1 =
      `https://clients5.google.com/translate_a/t?client=dict-chrome-ex` +
      `&sl=auto&tl=${encodeURIComponent(targetLang)}&q=${encodeURIComponent(joinedText)}`;
    const res1 = await fetch(url1);
    if (res1.ok) {
      const data1 = await res1.json();
      if (Array.isArray(data1)) {
        if (typeof data1[0] === 'string') return data1[0];
        if (Array.isArray(data1[0]) && typeof data1[0][0] === 'string') return data1[0][0];
      }
    }
  } catch (_) {}

  try {
    const url2 =
      `https://translate.googleapis.com/translate_a/single?client=gtx` +
      `&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(joinedText)}`;
    const res2 = await fetch(url2);
    if (res2.ok) {
      const data2 = await res2.json();
      const full = (data2[0] || []).map((part) => part[0] || '').join('');
      if (full) return full;
    }
  } catch (_) {}

  try {
    const shortQ = joinedText.slice(0, 480);
    const url3 = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(shortQ)}&langpair=Autodetect|${encodeURIComponent(targetLang)}`;
    const res3 = await fetch(url3);
    if (res3.ok) {
      const data3 = await res3.json();
      if (data3?.responseData?.translatedText) {
        return data3.responseData.translatedText;
      }
    }
  } catch (_) {}

  return joinedText;
}

async function translateSingle(text, targetLang = 'es') {
  const clean = (text || '').trim();
  if (!clean) return '';
  const cacheKey = `${targetLang}|${clean}`;
  if (singleTranslationCache.has(cacheKey)) {
    return singleTranslationCache.get(cacheKey);
  }

  const settings = await getStoredSettings();
  if (settings.workMode === 'gemini-api' && settings.geminiApiKey?.trim()) {
    try {
      const [gemTranslated] = await translateWithGemini([clean], targetLang, settings.geminiApiKey.trim());
      if (gemTranslated) {
        setCache(singleTranslationCache, MAX_TRANS_CACHE, cacheKey, gemTranslated);
        return gemTranslated;
      }
    } catch (_) {}
  }

  const translated = (await translateJoinedBlockFree(clean, targetLang)).trim();
  setCache(singleTranslationCache, MAX_TRANS_CACHE, cacheKey, translated);
  return translated;
}

async function translateBatch(texts, targetLang = 'es') {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results = new Array(texts.length).fill('');
  const uncachedIndices = [];
  const uncachedTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const t = (texts[i] || '').trim();
    const key = `${targetLang}|${t}`;
    if (singleTranslationCache.has(key)) {
      results[i] = singleTranslationCache.get(key);
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(t.replace(/\n/g, ' '));
    }
  }

  if (uncachedTexts.length === 0) return results;

  const settings = await getStoredSettings();

  if (settings.workMode === 'gemini-api' && settings.geminiApiKey?.trim()) {
    try {
      const gemOut = await translateWithGemini(uncachedTexts, targetLang, settings.geminiApiKey.trim());
      for (let j = 0; j < uncachedIndices.length; j++) {
        const origIdx = uncachedIndices[j];
        const val = (gemOut[j] || uncachedTexts[j] || '').trim();
        results[origIdx] = val;
        setCache(singleTranslationCache, MAX_TRANS_CACHE, `${targetLang}|${uncachedTexts[j]}`, val);
      }
      return results;
    } catch (_) {}
  }

  const CHUNK_SIZE = 20;
  for (let i = 0; i < uncachedTexts.length; i += CHUNK_SIZE) {
    const slice = uncachedTexts.slice(i, i + CHUNK_SIZE);
    const joined = slice.join('\n');
    const translatedBlock = await translateJoinedBlockFree(joined, targetLang);
    const splitLines = translatedBlock.split('\n');

    for (let j = 0; j < slice.length; j++) {
      const origIdx = uncachedIndices[i + j];
      const val = (splitLines[j] || slice[j] || '').trim();
      results[origIdx] = val;
      setCache(singleTranslationCache, MAX_TRANS_CACHE, `${targetLang}|${slice[j]}`, val);
    }
  }

  return results;
}

async function transcribeAndTranslateAudio({ base64Audio, mimeType = 'audio/webm', targetLang = 'es' }) {
  const settings = await getStoredSettings();
  const apiKey = settings?.geminiApiKey?.trim();
  if (!apiKey) {
    return '';
  }

  const langNames = {
    es: 'Spanish',
    en: 'English',
    pt: 'Portuguese',
    fr: 'French',
    de: 'German',
    it: 'Italian'
  };
  const targetLangName = langNames[targetLang] || targetLang;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio
            }
          },
          {
            text: `Listen to this short audio clip from a video. If there is spoken speech, translate it directly and naturally into ${targetLangName}. Output ONLY the translated spoken words, with no quotes or explanations. If there is only silence, music, or noise, output NOTHING (empty string).`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 120
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Gemini API HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'SYNTHESIZE_EDGE_TTS') {
    synthesizeEdgeTTS(message.payload)
      .then((audioDataUrl) => sendResponse({ ok: true, audioDataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'SYNTHESIZE_GEMINI_TTS') {
    synthesizeGeminiTTS(message.payload)
      .then((audioDataUrl) => sendResponse({ ok: true, audioDataUrl }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'TRANSLATE_SINGLE') {
    translateSingle(message.payload.text, message.payload.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'TRANSLATE_BATCH') {
    translateBatch(message.payload.texts, message.payload.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'TRANSCRIBE_AND_TRANSLATE_AUDIO') {
    transcribeAndTranslateAudio(message.payload)
      .then((translatedText) => sendResponse({ ok: true, translatedText }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'FETCH_URL_TEXT') {
    fetch(message.payload.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        sendResponse({ ok: true, text });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});
