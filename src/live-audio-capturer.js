// Capturador en Tiempo Real Universal con Acumulador Inteligente de Palabras Nuevas
// Evita repeticiones y cortes en subtítulos autogenerados palabra-por-palabra (como YouTube ASR)

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
    '[data-purpose="captions-cue-text"]',
    '[class*="captions-display"]',
    '[class*="subtitle-text"]',
    '[class*="caption-window"]'
  ].join(', ');

  let activeVideo = null;
  let isRunning = false;
  let targetLang = 'es';

  // Historial de palabras ya enviadas a traducir/locutar (evita repetir líneas de subtítulos rodantes)
  let committedWords = [];
  // Buffer de palabras nuevas acumuladas esperando formar una frase completa (7-12 palabras o pausa)
  let pendingNewWords = [];
  let flushPendingTimer = null;

  let domObserver = null;
  let domPollInterval = null;
  let trackListeners = [];

  let mediaRecorder = null;
  let audioStreamLoopTimer = null;
  let receivedAnyCueOrDomText = false;

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

  /**
   * Compara las palabras actuales en pantalla con el historial ya procesado (committed + pending)
   * y devuelve ÚNICAMENTE las palabras nuevas que acaban de aparecer al final.
   */
  function extractTrulyNewWords(currentRawText) {
    const cleaned = cleanText(currentRawText);
    if (!cleaned) return [];
    const incomingWords = cleaned.split(/\s+/).filter(Boolean);
    if (!incomingWords.length) return [];

    const knownWords = [...committedWords, ...pendingNewWords];
    if (!knownWords.length) {
      return incomingWords;
    }

    const normKnown = knownWords.map(normalizeWord);
    const normIncoming = incomingWords.map(normalizeWord);

    // 1. Verificar si todo incomingWords ya está contenido dentro de las últimas palabras conocidas
    const knownJoined = normKnown.slice(-30).join(' ');
    const incomingJoined = normIncoming.join(' ');
    if (knownJoined.includes(incomingJoined)) {
      return [];
    }

    // 2. Buscar el solapamiento más largo entre el final de knownWords y el inicio de incomingWords
    const maxOverlap = Math.min(normKnown.length, normIncoming.length);
    for (let k = maxOverlap; k >= 1; k--) {
      let match = true;
      for (let j = 0; j < k; j++) {
        if (normKnown[normKnown.length - k + j] !== normIncoming[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        return incomingWords.slice(k);
      }
    }

    // 3. Si YouTube mantuvo una línea anterior arriba y añadió palabras abajo, buscar desde dónde empiezan las nuevas
    const lastKnownWord = normKnown[normKnown.length - 1];
    const lastIdx = normIncoming.lastIndexOf(lastKnownWord);
    if (lastIdx !== -1 && lastIdx < incomingWords.length - 1) {
      return incomingWords.slice(lastIdx + 1);
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
    if (committedWords.length > 60) {
      committedWords = committedWords.slice(-60);
    }
    pendingNewWords = [];

    if (phraseToTranslate.length < 2) return;

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SINGLE',
        payload: {
          text: phraseToTranslate,
          targetLang: targetLang.split('-')[0].toLowerCase()
        }
      });

      if (!isRunning) return;
      const translated = (res && res.ok && res.translated ? res.translated : phraseToTranslate).trim();
      if (translated) {
        const wordCount = translated.split(/\s+/).length;
        const durationHint = Math.max(2.2, wordCount * 0.36);
        window.YTDubberTTSEngine.speakLiveText(translated, durationHint);
      }
    } catch (_) {
      if (isRunning) {
        window.YTDubberTTSEngine.speakLiveText(phraseToTranslate, 3.0);
      }
    }
  }

  function ingestLiveCaptionText(rawText) {
    if (!isRunning || !rawText) return;
    const newWords = extractTrulyNewWords(rawText);
    if (!newWords.length) return;

    receivedAnyCueOrDomText = true;
    pendingNewWords.push(...newWords);

    const lastWord = pendingNewWords[pendingNewWords.length - 1] || '';
    const endsWithPunct = /[.!?…:;]$/.test(lastWord);
    const settings = window.YTDubberTTSEngine ? window.YTDubberTTSEngine.getSettings() : {};
    const isGeminiMode = settings.workMode === 'gemini-api' && Boolean(settings.geminiApiKey);
    const targetWordCount = isGeminiMode ? 14 : 9;
    const minPunctWords = isGeminiMode ? 7 : 4;
    const pauseWaitMs = isGeminiMode ? 1050 : 750;

    if (
      pendingNewWords.length >= targetWordCount ||
      (endsWithPunct && pendingNewWords.length >= minPunctWords)
    ) {
      flushPendingWordsToTranslator();
      return;
    }

    if (flushPendingTimer) clearTimeout(flushPendingTimer);
    flushPendingTimer = setTimeout(() => {
      flushPendingWordsToTranslator();
    }, pauseWaitMs);
  }

  function attachTextTrackListeners(videoEl) {
    detachTextTrackListeners();
    if (!videoEl || !videoEl.textTracks) return;

    const bindTrack = (track) => {
      try {
        if (track.mode === 'disabled') {
          track.mode = 'hidden';
        }
        const onCueChange = () => {
          if (!isRunning || !track.activeCues || !track.activeCues.length) return;
          const texts = [];
          for (let i = 0; i < track.activeCues.length; i++) {
            const cue = track.activeCues[i];
            if (cue.text) texts.push(cue.text);
          }
          const combined = texts.join(' ');
          if (combined) {
            ingestLiveCaptionText(combined);
          }
        };
        track.addEventListener('cuechange', onCueChange);
        trackListeners.push({ track, onCueChange });
      } catch (_) {}
    };

    for (let i = 0; i < videoEl.textTracks.length; i++) {
      bindTrack(videoEl.textTracks[i]);
    }

    const onAddTrack = (e) => {
      if (e.track) bindTrack(e.track);
    };
    videoEl.textTracks.addEventListener('addtrack', onAddTrack);
    trackListeners.push({ trackList: videoEl.textTracks, onAddTrack });
  }

  function detachTextTrackListeners() {
    for (const item of trackListeners) {
      if (item.track && item.onCueChange) {
        try {
          item.track.removeEventListener('cuechange', item.onCueChange);
        } catch (_) {}
      }
      if (item.trackList && item.onAddTrack) {
        try {
          item.trackList.removeEventListener('addtrack', item.onAddTrack);
        } catch (_) {}
      }
    }
    trackListeners = [];
  }

  function checkDomCaptionsNow() {
    if (!isRunning || !activeVideo || activeVideo.paused) return;
    const nodes = document.querySelectorAll(DOM_CAPTION_SELECTORS);
    if (!nodes.length) return;
    for (const node of nodes) {
      if (node.id === 'yt-live-dubber-subtitles') continue;
      const txt = (node.innerText || node.textContent || '').trim();
      if (txt && txt.length >= 2) {
        ingestLiveCaptionText(txt);
        break;
      }
    }
  }

  function attachDomCaptionObserver() {
    detachDomCaptionObserver();

    domObserver = new MutationObserver(() => {
      checkDomCaptionsNow();
    });

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

  function startDirectAudioCaptureIfNeeded(videoEl) {
    stopDirectAudioCapture();

    const captureFn = videoEl.captureStream || videoEl.mozCaptureStream;
    if (typeof captureFn !== 'function') return;

    const recordSingleChunk = () => {
      if (!isRunning || !activeVideo || activeVideo.paused || receivedAnyCueOrDomText) {
        return;
      }

      const settings = window.YTDubberTTSEngine.getSettings();
      if (settings.workMode !== 'gemini-api' || !settings.geminiApiKey) {
        return;
      }

      try {
        const stream = captureFn.call(activeVideo);
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) return;

        const audioOnlyStream = new MediaStream(audioTracks);
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';

        const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
        mediaRecorder = recorder;
        const chunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = async () => {
          if (!isRunning || receivedAnyCueOrDomText || !chunks.length) return;
          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size < 1200) return;

          const reader = new FileReader();
          reader.onloadend = async () => {
            const base64DataUrl = reader.result;
            if (typeof base64DataUrl !== 'string') return;
            const base64Audio = base64DataUrl.split(',')[1];
            if (!base64Audio) return;

            try {
              const res = await chrome.runtime.sendMessage({
                type: 'TRANSCRIBE_AND_TRANSLATE_AUDIO',
                payload: {
                  base64Audio,
                  mimeType: 'audio/webm',
                  targetLang: targetLang.split('-')[0].toLowerCase()
                }
              });

              if (isRunning && res && res.ok && res.translatedText) {
                window.YTDubberTTSEngine.speakLiveText(res.translatedText, 3.6);
              }
            } catch (_) {}
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
        setTimeout(() => {
          if (recorder.state === 'recording') {
            try {
              recorder.stop();
            } catch (_) {}
          }
        }, 3800);
      } catch (_) {}
    };

    audioStreamLoopTimer = setInterval(() => {
      if (!isRunning || !activeVideo || activeVideo.paused) return;
      if (!receivedAnyCueOrDomText) {
        recordSingleChunk();
      }
    }, 4000);
  }

  function stopDirectAudioCapture() {
    if (audioStreamLoopTimer) {
      clearInterval(audioStreamLoopTimer);
      audioStreamLoopTimer = null;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try {
        mediaRecorder.stop();
      } catch (_) {}
    }
    mediaRecorder = null;
  }

  function start(videoEl, lang = 'es') {
    stop();
    if (!videoEl) return;
    activeVideo = videoEl;
    targetLang = lang;
    isRunning = true;
    receivedAnyCueOrDomText = false;
    committedWords = [];
    pendingNewWords = [];

    attachTextTrackListeners(videoEl);
    attachDomCaptionObserver();
    startDirectAudioCaptureIfNeeded(videoEl);
  }

  function stop() {
    isRunning = false;
    if (flushPendingTimer) {
      clearTimeout(flushPendingTimer);
      flushPendingTimer = null;
    }
    committedWords = [];
    pendingNewWords = [];
    detachTextTrackListeners();
    detachDomCaptionObserver();
    stopDirectAudioCapture();
    activeVideo = null;
  }

  function setTargetLang(lang) {
    targetLang = lang || 'es';
    committedWords = [];
    pendingNewWords = [];
  }

  return {
    start,
    stop,
    setTargetLang
  };
})();
