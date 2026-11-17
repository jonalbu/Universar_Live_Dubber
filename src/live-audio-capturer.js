// Capturador en Tiempo Real Universal:
// 1. Acumulador de palabras nuevas desde subtítulos (TextTrack / DOM, incluido Vimeo)
// 2. Captura de audio del <video> con normalizador Web Audio (solo si el AudioContext está "running")
// 3. Detección de actividad de voz (VAD) para no gastar cuota en silencios
// 4. Gemini Live WebSocket con watchdog, keepalive y reconexión + respaldo REST por fragmentos
// 5. Avisos visibles cuando no se puede capturar el audio (DRM/CORS) o se agota la cuota (429)

window.YTDubberLiveCapturer = (function () {
  const DOM_CAPTION_SELECTORS = [
    '.ytp-caption-window-container',
    '.vjs-text-track-display',
    '.plyr__captions',
    '.jw-text-track-container',
    '.jw-text-track-cue',
    '.shaka-text-container',
    '.mejs__captions-text',
    '.fp-captions',
    '.vp-captions',
    '[class*="CaptionsRenderer"]',
    '[class*="captions-renderer"]',
    '[data-purpose="captions-cue-text"]',
    '[class*="captions-display"]',
    '[class*="subtitle-text"]',
    '[class*="caption-window"]'
  ].join(', ');

  const REST_CHUNK_MS = 5600;
  const REST_LOOP_MS = 5800;
  const LIVE_WS_NO_OUTPUT_MS = 10000;
  const LIVE_WS_MIN_SENT_MS = 3500;
  const KEEPALIVE_MS = 20000;
  const QUOTA_BACKOFF_MS = 30000;
  const VAD_RMS_THRESHOLD = 0.011;

  let activeVideo = null;
  let isRunning = false;
  let targetLang = 'es';

  let committedWords = [];
  let pendingNewWords = [];
  let flushPendingTimer = null;

  let domObserver = null;
  let domPollInterval = null;
  let trackListeners = [];

  let lastCaptionEventTime = 0;
  let lastDomCaptionText = '';

  function hasRecentCaptions() {
    return lastCaptionEventTime > 0 && Date.now() - lastCaptionEventTime < 7500;
  }

  function warn(text) {
    if (window.YTDubberTTSEngine && window.YTDubberTTSEngine.notifyRuntimeWarning) {
      window.YTDubberTTSEngine.notifyRuntimeWarning(text);
    }
  }

  function sendBg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  }

  function cleanText(str) {
    if (!str) return '';
    return str
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[.*?\]/g, '')
      .replace(/♪+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeWord(w) {
    return (w || '')
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  function extractTrulyNewWords(currentRawText) {
    const cleaned = cleanText(currentRawText);
    if (!cleaned) return [];
    const incomingWords = cleaned.split(/\s+/).filter(Boolean);
    if (!incomingWords.length) return [];

    const knownWords = [...committedWords, ...pendingNewWords];
    if (!knownWords.length) return incomingWords;

    const normKnown = knownWords.map(normalizeWord);
    const normIncoming = incomingWords.map(normalizeWord);

    const recentKnownJoined = normKnown.slice(-20).join(' ');
    const incomingJoined = normIncoming.join(' ');
    if (normIncoming.length >= 2 && recentKnownJoined.includes(incomingJoined)) return [];

    const maxOverlap = Math.min(normKnown.length, normIncoming.length);
    for (let k = maxOverlap; k >= 1; k--) {
      if (k === 1 && normIncoming.length >= 5 && normKnown[normKnown.length - 1].length <= 2) {
        continue;
      }
      let match = true;
      for (let j = 0; j < k; j++) {
        if (normKnown[normKnown.length - k + j] !== normIncoming[j]) {
          match = false;
          break;
        }
      }
      if (match) return incomingWords.slice(k);
    }

    if (normKnown.length >= 3 && normIncoming.length >= 4) {
      const a0 = normKnown[normKnown.length - 3];
      const a1 = normKnown[normKnown.length - 2];
      const a2 = normKnown[normKnown.length - 1];
      for (let idx = normIncoming.length - 4; idx >= 0; idx--) {
        if (
          normIncoming[idx] === a0 &&
          normIncoming[idx + 1] === a1 &&
          normIncoming[idx + 2] === a2
        ) {
          return incomingWords.slice(idx + 3);
        }
      }
    }
    return incomingWords;
  }

  async function flushPendingWordsToTranslator() {
    if (flushPendingTimer) {
      clearTimeout(flushPendingTimer);
      flushPendingTimer = null;
    }
    if (!isRunning || pendingNewWords.length === 0) return;

    const phraseToTranslate = pendingNewWords.join(' ').trim();
    committedWords.push(...pendingNewWords);
    if (committedWords.length > 60) committedWords = committedWords.slice(-60);
    pendingNewWords = [];

    if (phraseToTranslate.length < 2) return;

    const res = await sendBg({
      type: 'TRANSLATE_SINGLE',
      payload: { text: phraseToTranslate, targetLang: targetLang.split('-')[0].toLowerCase() }
    });
    if (!isRunning) return;
    if (res && res.warning) warn(`⚠️ ${res.warning}`);

    const translated = (res && res.ok && res.translated ? res.translated : phraseToTranslate).trim();
    if (translated) {
      const wordCount = translated.split(/\s+/).length;
      window.YTDubberTTSEngine.speakLiveText(translated, Math.max(2.2, wordCount * 0.36));
    }
  }

  function ingestLiveCaptionText(rawText) {
    if (!isRunning || !rawText) return;
    const newWords = extractTrulyNewWords(rawText);
    if (!newWords.length) return;

    lastCaptionEventTime = Date.now();
    pendingNewWords.push(...newWords);

    const lastWord = pendingNewWords[pendingNewWords.length - 1] || '';
    const endsWithPunct = /[.!?…:;]$/.test(lastWord);
    const settings = window.YTDubberTTSEngine ? window.YTDubberTTSEngine.getSettings() : {};
    const isGeminiMode = settings.workMode === 'gemini-api' && Boolean(settings.geminiApiKey);
    const targetWordCount = isGeminiMode ? 10 : 7;
    const minPunctWords = isGeminiMode ? 5 : 3;
    const pauseWaitMs = isGeminiMode ? 680 : 450;

    if (
      pendingNewWords.length >= targetWordCount ||
      (endsWithPunct && pendingNewWords.length >= minPunctWords)
    ) {
      flushPendingWordsToTranslator();
      return;
    }

    if (flushPendingTimer) clearTimeout(flushPendingTimer);
    flushPendingTimer = setTimeout(flushPendingWordsToTranslator, pauseWaitMs);
  }

  function attachTextTrackListeners(videoEl) {
    detachTextTrackListeners();
    if (!videoEl || !videoEl.textTracks) return;

    const bindTrack = (track) => {
      try {
        if (track.mode === 'disabled') track.mode = 'hidden';
        const onCueChange = () => {
          if (!isRunning || !track.activeCues || !track.activeCues.length) return;
          const texts = [];
          for (let i = 0; i < track.activeCues.length; i++) {
            const cue = track.activeCues[i];
            if (cue.text) texts.push(cue.text);
          }
          const combined = texts.join(' ');
          if (combined) ingestLiveCaptionText(combined);
        };
        track.addEventListener('cuechange', onCueChange);
        trackListeners.push({ track, onCueChange });
      } catch (_) {}
    };

    for (let i = 0; i < videoEl.textTracks.length; i++) bindTrack(videoEl.textTracks[i]);

    const onAddTrack = (e) => {
      if (e.track) bindTrack(e.track);
    };
    videoEl.textTracks.addEventListener('addtrack', onAddTrack);
    trackListeners.push({ trackList: videoEl.textTracks, onAddTrack });
  }

  function detachTextTrackListeners() {
    for (const item of trackListeners) {
      try {
        if (item.track && item.onCueChange) item.track.removeEventListener('cuechange', item.onCueChange);
        if (item.trackList && item.onAddTrack) item.trackList.removeEventListener('addtrack', item.onAddTrack);
      } catch (_) {}
    }
    trackListeners = [];
  }

  function checkDomCaptionsNow() {
    if (!isRunning || !activeVideo || activeVideo.paused) return;
    const nodes = Array.from(document.querySelectorAll(DOM_CAPTION_SELECTORS));
    if (!nodes.length) return;

    const pieces = [];
    for (const node of nodes) {
      if (node.id === 'yt-live-dubber-subtitles') continue;
      if (node.offsetParent === null) continue;
      // Evitar duplicar texto si un nodo contenedor y su hijo coinciden con el selector
      if (nodes.some((other) => other !== node && node.contains(other))) continue;
      const txt = (node.innerText || node.textContent || '').trim();
      if (txt && txt.length >= 2) {
        pieces.push(txt);
      }
    }

    const combined = pieces.join(' ').replace(/\s+/g, ' ').trim();
    if (combined && combined !== lastDomCaptionText) {
      lastDomCaptionText = combined;
      ingestLiveCaptionText(combined);
    }
  }

  function attachDomCaptionObserver() {
    detachDomCaptionObserver();
    domObserver = new MutationObserver(checkDomCaptionsNow);
    domObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    domPollInterval = setInterval(checkDomCaptionsNow, 350);
  }

  function detachDomCaptionObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (domPollInterval) {
      clearInterval(domPollInterval);
      domPollInterval = null;
    }
  }

  // ===================== CAPTURA DE AUDIO =====================
  let capturedRawStream = null;
  let noAudioTrackAttempts = 0;
  let captureWarningShown = false;
  let mediaRecorder = null;
  let audioStreamLoopTimer = null;
  let restRequestInFlight = false;
  let quotaBackoffUntil = 0;
  let lastTranslatedContext = '';

  let audioCtx = null;
  let gainNode = null;
  let analyserNode = null;
  let pcmProcessorNode = null;
  let normalizedDest = null;
  let gainSyncTimer = null;
  let resumeListenersAttached = false;

  function isAudioGraphRunning() {
    return Boolean(audioCtx && audioCtx.state === 'running' && normalizedDest);
  }

  function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  }

  // Chrome solo permite arrancar el audio tras un gesto del usuario: reintentar en cada clic/tecla/play
  function attachResumeListeners() {
    if (resumeListenersAttached) return;
    resumeListenersAttached = true;
    document.addEventListener('pointerdown', resumeAudioContext, true);
    document.addEventListener('keydown', resumeAudioContext, true);
  }

  function detachResumeListeners() {
    if (!resumeListenersAttached) return;
    resumeListenersAttached = false;
    document.removeEventListener('pointerdown', resumeAudioContext, true);
    document.removeEventListener('keydown', resumeAudioContext, true);
  }

  function showCaptureWarningOnce(text) {
    if (captureWarningShown) return;
    captureWarningShown = true;
    warn(text);
  }

  /**
   * Obtiene (y reutiliza) el stream de audio del <video>.
   * Lanza el error real si el navegador bloquea la captura (DRM o CORS).
   */
  function getRawAudioStream() {
    if (!activeVideo) return null;
    const captureFn = activeVideo.captureStream || activeVideo.mozCaptureStream;
    if (typeof captureFn !== 'function') {
      throw new Error('CAPTURE_UNSUPPORTED');
    }

    if (capturedRawStream) {
      const liveTracks = capturedRawStream.getAudioTracks().filter((t) => t.readyState === 'live');
      if (liveTracks.length) return capturedRawStream;
      teardownAudioGraph();
      capturedRawStream = null;
    }

    const stream = captureFn.call(activeVideo);
    if (!stream.getAudioTracks().length) {
      noAudioTrackAttempts++;
      return null;
    }
    noAudioTrackAttempts = 0;
    capturedRawStream = stream;
    return stream;
  }

  function teardownAudioGraph() {
    if (gainSyncTimer) {
      clearInterval(gainSyncTimer);
      gainSyncTimer = null;
    }
    if (pcmProcessorNode) {
      try {
        pcmProcessorNode.onaudioprocess = null;
        pcmProcessorNode.disconnect();
      } catch (_) {}
      pcmProcessorNode = null;
    }
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (_) {}
      audioCtx = null;
    }
    gainNode = null;
    analyserNode = null;
    normalizedDest = null;
  }

  function computeCurrentRms() {
    if (!analyserNode || !isAudioGraphRunning()) return 0;
    const buf = new Float32Array(analyserNode.fftSize);
    analyserNode.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function float32ToPcm16Base64(float32Samples, inputSampleRate) {
    const ratio = inputSampleRate / 16000;
    const outLength = Math.max(1, Math.floor(float32Samples.length / ratio));
    const pcm16 = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      // Promedio simple de las muestras del intervalo (filtro paso bajo básico antes de diezmar)
      const start = Math.floor(i * ratio);
      const end = Math.min(float32Samples.length, Math.floor((i + 1) * ratio));
      let acc = 0;
      let n = 0;
      for (let j = start; j < end; j++) {
        acc += float32Samples[j];
        n++;
      }
      const s = Math.max(-1, Math.min(1, n ? acc / n : 0));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(pcm16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /**
   * Construye el grafo Web Audio (compensación de ducking + VAD + salida PCM para Gemini Live).
   * Si el navegador mantiene el AudioContext suspendido, el resto del código usa el stream crudo.
   */
  function ensureAudioGraph(rawStream) {
    if (audioCtx) {
      resumeAudioContext();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      audioCtx = new AudioContextClass();
      const source = audioCtx.createMediaStreamSource(new MediaStream(rawStream.getAudioTracks()));
      gainNode = audioCtx.createGain();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 1024;
      normalizedDest = audioCtx.createMediaStreamDestination();

      const updateCompensationGain = () => {
        if (!gainNode || !activeVideo || !audioCtx) return;
        const vidVol = Math.max(0.12, activeVideo.volume || 1.0);
        gainNode.gain.setTargetAtTime(Math.min(8.5, 1.0 / vidVol), audioCtx.currentTime, 0.05);
      };
      updateCompensationGain();
      gainSyncTimer = setInterval(updateCompensationGain, 200);

      source.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(normalizedDest);

      pcmProcessorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      gainNode.connect(pcmProcessorNode);
      pcmProcessorNode.connect(audioCtx.destination);
      pcmProcessorNode.onaudioprocess = handlePcmFrame;

      resumeAudioContext();
      attachResumeListeners();
    } catch (_) {
      teardownAudioGraph();
    }
  }

  // ===================== GEMINI LIVE WEBSOCKET =====================
  let liveWsConnected = false;
  let liveWsConnecting = false;
  let liveWsDisabled = false;
  let liveWsFailures = 0;
  let liveWsSpeaking = false;
  let liveWsSilenceFrames = 0;
  let liveWsPendingSince = 0;
  let liveWsSentMsSinceOutput = 0;
  let liveWsWatchdogTimer = null;
  let keepAliveTimer = null;
  let reconnectTimer = null;

  function canUseLiveWs() {
    return liveWsConnected && isAudioGraphRunning();
  }

  function sendPcmChunk(inData) {
    const base64Pcm = float32ToPcm16Base64(inData, audioCtx.sampleRate);
    if (!liveWsPendingSince) liveWsPendingSince = Date.now();
    liveWsSentMsSinceOutput += (inData.length / audioCtx.sampleRate) * 1000;
    sendBg({ type: 'GEMINI_LIVE_WS_AUDIO_PCM', payload: { base64Pcm } }).then((res) => {
      // El service worker pudo reiniciarse y perder la sesión: pasar a REST y reconectar
      if (liveWsConnected && res && res.ok === false) {
        handleLiveWsLost('La sesión Gemini Live se perdió');
      }
    });
  }

  function handlePcmFrame(audioEvent) {
    audioEvent.outputBuffer.getChannelData(0).fill(0);
    if (!isRunning || !canUseLiveWs() || !activeVideo || activeVideo.paused || hasRecentCaptions()) {
      return;
    }

    const inData = audioEvent.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < inData.length; i++) sum += inData[i] * inData[i];
    const rms = Math.sqrt(sum / inData.length);

    if (rms > VAD_RMS_THRESHOLD) {
      liveWsSpeaking = true;
      liveWsSilenceFrames = 0;
      sendPcmChunk(inData);
    } else if (liveWsSpeaking) {
      liveWsSilenceFrames++;
      if (liveWsSilenceFrames <= 3) {
        sendPcmChunk(inData);
      } else {
        liveWsSpeaking = false;
        liveWsSilenceFrames = 0;
        sendBg({ type: 'GEMINI_LIVE_WS_AUDIO_END' });
      }
    }
  }

  async function connectLiveWs() {
    if (!isRunning || liveWsDisabled || liveWsConnected || liveWsConnecting) return;
    const settings = window.YTDubberTTSEngine.getSettings();
    if (settings.workMode !== 'gemini-api' || !(settings.geminiApiKey || '').trim()) return;

    liveWsConnecting = true;
    const res = await sendBg({
      type: 'GEMINI_LIVE_WS_START',
      payload: {
        targetLang: targetLang.split('-')[0].toLowerCase(),
        geminiVoice: settings.geminiVoice || 'Kore'
      }
    });
    liveWsConnecting = false;
    if (!isRunning) {
      sendBg({ type: 'GEMINI_LIVE_WS_STOP' });
      return;
    }

    if (res && res.ok) {
      liveWsConnected = true;
      liveWsPendingSince = 0;
      liveWsSentMsSinceOutput = 0;
    } else {
      registerLiveWsFailure(res && res.error ? res.error : 'No se pudo conectar');
    }
  }

  function registerLiveWsFailure(reason) {
    liveWsFailures++;
    if (liveWsFailures >= 3) {
      liveWsDisabled = true;
      warn(`⚠️ Gemini Live no disponible (${reason}). Usando traducción por fragmentos.`);
    }
  }

  function handleLiveWsLost(reason) {
    if (!liveWsConnected) return;
    liveWsConnected = false;
    liveWsSpeaking = false;
    liveWsSilenceFrames = 0;
    liveWsPendingSince = 0;
    liveWsSentMsSinceOutput = 0;
    sendBg({ type: 'GEMINI_LIVE_WS_STOP' });
    registerLiveWsFailure(reason);
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer || liveWsDisabled || !isRunning) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectLiveWs();
    }, 2000);
  }

  // Si se envió voz suficiente y Gemini Live no devuelve nada, descartar la conexión y usar REST
  function checkLiveWsHealth() {
    if (!isRunning || !liveWsConnected || !liveWsPendingSince) return;
    const waited = Date.now() - liveWsPendingSince;
    if (waited > LIVE_WS_NO_OUTPUT_MS && liveWsSentMsSinceOutput > LIVE_WS_MIN_SENT_MS) {
      handleLiveWsLost('sin respuesta de audio');
    }
  }

  // Mantiene vivo el service worker y detecta si perdió la sesión
  async function keepAliveTick() {
    if (!isRunning) return;
    const res = await sendBg({ type: 'GEMINI_LIVE_WS_PING' });
    if (liveWsConnected && (!res || !res.connected)) {
      handleLiveWsLost('conexión cerrada');
    }
  }

  function onLiveWsMessage(msg) {
    if (!isRunning || !msg || !msg.type) return;

    if (msg.type === 'GEMINI_LIVE_WS_OUTPUT') {
      const { audioDataUrl, transcript } = msg.payload || {};
      liveWsPendingSince = 0;
      liveWsSentMsSinceOutput = 0;
      liveWsFailures = 0;
      if (transcript) lastTranslatedContext = transcript;
      if (audioDataUrl) {
        window.YTDubberTTSEngine.playPreSynthesizedLiveAudio(audioDataUrl, transcript || '');
      } else if (transcript) {
        window.YTDubberTTSEngine.speakLiveText(transcript, 3.2);
      }
    }

    if (msg.type === 'GEMINI_LIVE_WS_CLOSED') {
      const reason = (msg.payload && msg.payload.reason) || 'conexión cerrada por el servidor';
      if (liveWsConnected) {
        // Cierre normal (límite de ~10 min / goAway): reconectar sin contar como fallo grave
        liveWsConnected = false;
        liveWsPendingSince = 0;
        liveWsSentMsSinceOutput = 0;
        if (msg.payload && msg.payload.expected) {
          scheduleReconnect();
        } else {
          registerLiveWsFailure(reason);
          scheduleReconnect();
        }
      }
    }
  }

  chrome.runtime.onMessage.addListener(onLiveWsMessage);

  // ===================== RESPALDO REST POR FRAGMENTOS =====================
  let silentChunkStreak = 0;

  function describeCaptureError(err) {
    const name = (err && err.name) || '';
    const msg = (err && err.message) || String(err || '');
    if (msg === 'CAPTURE_UNSUPPORTED') {
      return '⚠️ Este navegador no permite capturar el audio del video.';
    }
    if (name === 'NotSupportedError' || /encrypted|EME|DRM/i.test(msg)) {
      return '⚠️ Este video está protegido (DRM) y no deja capturar su audio. Activa los subtítulos CC del reproductor para doblarlo.';
    }
    if (name === 'SecurityError' || /cross-origin|CORS/i.test(msg)) {
      return '⚠️ El reproductor bloquea la captura de audio (CORS). Activa los subtítulos CC del reproductor para doblarlo.';
    }
    return `⚠️ No se pudo capturar el audio del video: ${msg}`;
  }

  function recordSingleChunk() {
    if (!isRunning || !activeVideo || activeVideo.paused) return;
    if (hasRecentCaptions() || canUseLiveWs() || restRequestInFlight) return;
    if (mediaRecorder && mediaRecorder.state === 'recording') return;
    if (Date.now() < quotaBackoffUntil) return;

    const settings = window.YTDubberTTSEngine.getSettings();
    if (settings.workMode !== 'gemini-api' || !(settings.geminiApiKey || '').trim()) return;

    let rawStream = null;
    try {
      rawStream = getRawAudioStream();
    } catch (err) {
      showCaptureWarningOnce(describeCaptureError(err));
      return;
    }
    if (!rawStream) {
      if (noAudioTrackAttempts >= 3) {
        showCaptureWarningOnce(
          '⚠️ El video no entrega pista de audio capturable (posible DRM). Activa los subtítulos CC del reproductor.'
        );
      }
      return;
    }

    ensureAudioGraph(rawStream);
    const graphRunning = isAudioGraphRunning();
    // Si el AudioContext sigue suspendido, grabar el audio crudo (sin compensación) en lugar de silencio
    const recStream = graphRunning ? normalizedDest.stream : new MediaStream(rawStream.getAudioTracks());

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    let recorder;
    try {
      recorder = new MediaRecorder(recStream, { mimeType });
    } catch (err) {
      showCaptureWarningOnce(describeCaptureError(err));
      return;
    }
    mediaRecorder = recorder;
    const chunks = [];
    let speechFrames = 0;
    let maxRms = 0;

    const vadPoll = setInterval(() => {
      const rms = computeCurrentRms();
      if (rms > maxRms) maxRms = rms;
      if (rms > VAD_RMS_THRESHOLD) speechFrames++;
    }, 120);

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      clearInterval(vadPoll);
      if (mediaRecorder === recorder) mediaRecorder = null;
      if (!isRunning || hasRecentCaptions() || !chunks.length) return;

      if (graphRunning) {
        // Audio exactamente en cero varias veces seguidas con el video sonando = audio protegido
        if (maxRms === 0 && activeVideo && !activeVideo.muted && activeVideo.volume > 0) {
          silentChunkStreak++;
          if (silentChunkStreak >= 3) {
            showCaptureWarningOnce(
              '⚠️ El audio capturado llega en silencio (posible DRM). Activa los subtítulos CC del reproductor.'
            );
          }
          return;
        }
        silentChunkStreak = 0;
        // VAD: sin voz en el fragmento, no gastar cuota
        if (speechFrames < 2) return;
      }

      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size < 1200) return;
      sendChunkToGemini(blob);
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch (_) {}
      }
    }, REST_CHUNK_MS);
  }

  function sendChunkToGemini(blob) {
    const reader = new FileReader();
    reader.onloadend = async () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      const base64Audio = dataUrl.split(',')[1];
      if (!base64Audio) return;

      restRequestInFlight = true;
      const res = await sendBg({
        type: 'TRANSCRIBE_AND_TRANSLATE_AUDIO',
        payload: {
          base64Audio,
          mimeType: 'audio/webm',
          targetLang: targetLang.split('-')[0].toLowerCase(),
          previousContext: lastTranslatedContext
        }
      });
      restRequestInFlight = false;
      if (!isRunning) return;

      if (!res || !res.ok) {
        const errText = (res && res.error) || 'Error desconocido';
        if (/429|cuota|quota|exhausted/i.test(errText)) {
          quotaBackoffUntil = Date.now() + QUOTA_BACKOFF_MS;
          warn('⚠️ Cuota por minuto de Gemini agotada (429). Reintentando en 30 s...');
        } else {
          warn(`⚠️ Gemini API: ${errText}`);
        }
        return;
      }

      if (res.translatedText) {
        lastTranslatedContext = res.translatedText;
        window.YTDubberTTSEngine.speakLiveText(res.translatedText, 3.5);
      }
    };
    reader.readAsDataURL(blob);
  }

  function onVideoPlayForAudio() {
    resumeAudioContext();
  }

  async function startDirectAudioCapture(videoEl) {
    stopDirectAudioCapture();
    const settings = window.YTDubberTTSEngine.getSettings();
    if (settings.workMode !== 'gemini-api') return;

    if (!(settings.geminiApiKey || '').trim()) {
      warn('⚠️ Ingresa tu Clave de Gemini API en el popup para usar el Traductor Live.');
      return;
    }

    videoEl.addEventListener('play', onVideoPlayForAudio);

    // Preparar el grafo de audio lo antes posible (más cerca del clic del usuario)
    try {
      const raw = getRawAudioStream();
      if (raw) ensureAudioGraph(raw);
    } catch (err) {
      showCaptureWarningOnce(describeCaptureError(err));
      return;
    }

    liveWsWatchdogTimer = setInterval(checkLiveWsHealth, 2000);
    keepAliveTimer = setInterval(keepAliveTick, KEEPALIVE_MS);

    // El REST arranca de inmediato; si Gemini Live conecta, toma el relevo
    recordSingleChunk();
    audioStreamLoopTimer = setInterval(recordSingleChunk, REST_LOOP_MS);
    connectLiveWs();
  }

  function stopDirectAudioCapture() {
    if (liveWsConnected || liveWsConnecting) {
      sendBg({ type: 'GEMINI_LIVE_WS_STOP' });
    }
    liveWsConnected = false;
    liveWsConnecting = false;
    liveWsSpeaking = false;
    liveWsSilenceFrames = 0;
    liveWsPendingSince = 0;
    liveWsSentMsSinceOutput = 0;

    [audioStreamLoopTimer, liveWsWatchdogTimer, keepAliveTimer].forEach((t) => t && clearInterval(t));
    audioStreamLoopTimer = null;
    liveWsWatchdogTimer = null;
    keepAliveTimer = null;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try {
        mediaRecorder.stop();
      } catch (_) {}
    }
    mediaRecorder = null;
    restRequestInFlight = false;

    if (activeVideo) activeVideo.removeEventListener('play', onVideoPlayForAudio);
    detachResumeListeners();
    teardownAudioGraph();
    capturedRawStream = null;
  }

  function resetSessionState() {
    committedWords = [];
    pendingNewWords = [];
    lastCaptionEventTime = 0;
    lastDomCaptionText = '';
    lastTranslatedContext = '';
    noAudioTrackAttempts = 0;
    captureWarningShown = false;
    silentChunkStreak = 0;
    quotaBackoffUntil = 0;
    liveWsDisabled = false;
    liveWsFailures = 0;
  }

  function start(videoEl, lang = 'es') {
    stop();
    if (!videoEl) return;
    activeVideo = videoEl;
    targetLang = lang;
    isRunning = true;
    resetSessionState();

    attachTextTrackListeners(videoEl);
    attachDomCaptionObserver();
    startDirectAudioCapture(videoEl);
  }

  function stop() {
    isRunning = false;
    if (flushPendingTimer) {
      clearTimeout(flushPendingTimer);
      flushPendingTimer = null;
    }
    detachTextTrackListeners();
    detachDomCaptionObserver();
    stopDirectAudioCapture();
    resetSessionState();
    activeVideo = null;
  }

  function setTargetLang(lang) {
    targetLang = lang || 'es';
    committedWords = [];
    pendingNewWords = [];
    lastTranslatedContext = '';
  }

  return {
    start,
    stop,
    setTargetLang
  };
})();
