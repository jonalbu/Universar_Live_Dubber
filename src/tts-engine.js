// Motor de Síntesis de Voz y Sincronización Continua (YouTube + Web)
// Soporta:
// - Modo 'gemini-api': Voz nativa de IA de Gemini (Kore, Puck, Aoede, Charon, Fenrir, Zephyr, Leda, Orus)
// - Modo 'tts-only': Microsoft Edge Neural TTS (Sec-MS-GEC v2) o Web Speech API Nativa

window.YTDubberTTSEngine = (function () {
  const DEFAULT_SETTINGS = {
    enabled: false,
    workMode: 'tts-only', // 'tts-only' | 'gemini-api'
    targetLang: 'es',
    engine: 'edge-neural',
    edgeVoice: 'es-ES-AlvaroNeural',
    geminiVoice: 'Kore',
    nativeVoiceURI: '',
    duckVolume: 0.15,
    dubVolume: 1.0,
    baseSpeed: 1.0,
    showSubtitlesOverlay: true,
    geminiApiKey: ''
  };

  let settings = { ...DEFAULT_SETTINGS };
  let segments = [];
  let videoEl = null;
  let isActive = false;
  let currentSegmentId = -1;
  let lastSpokenSegmentId = -1;
  let currentAudio = null;
  let isSpeaking = false;
  let isSynthesizing = false;
  let speechWatchdogTimer = null;

  let pendingLiveQueue = [];

  let originalVideoVolume = 1.0;
  let volumeDuckingApplied = false;
  let restoreVolumeTimeout = null;
  let liveSubtitleClearTimeout = null;

  const prefetchPromises = new Map();
  const prefetchedAudio = new Map();

  let onStatusChangeCallback = null;
  let onSubtitleChangeCallback = null;

  function isUsingGeminiVoice() {
    return settings.workMode === 'gemini-api' && Boolean((settings.geminiApiKey || '').trim());
  }

  function updateSettings(newSettings) {
    const voiceOrModeChanged =
      (newSettings.workMode && newSettings.workMode !== settings.workMode) ||
      (newSettings.geminiVoice && newSettings.geminiVoice !== settings.geminiVoice) ||
      (newSettings.edgeVoice && newSettings.edgeVoice !== settings.edgeVoice) ||
      (newSettings.baseSpeed && newSettings.baseSpeed !== settings.baseSpeed);

    settings = { ...settings, ...newSettings };

    if (voiceOrModeChanged) {
      prefetchPromises.clear();
      prefetchedAudio.clear();
    }

    if (currentAudio) {
      currentAudio.volume = Math.max(0, Math.min(1, settings.dubVolume));
    }
  }

  function getSettings() {
    return { ...settings };
  }

  function setCallbacks({ onStatusChange, onSubtitleChange }) {
    onStatusChangeCallback = onStatusChange;
    onSubtitleChangeCallback = onSubtitleChange;
  }

  function emitStatus(statusText, state = 'idle') {
    if (typeof onStatusChangeCallback === 'function') {
      onStatusChangeCallback({ statusText, state });
    }
  }

  function emitSubtitle(text) {
    if (typeof onSubtitleChangeCallback === 'function') {
      onSubtitleChangeCallback(text || '');
    }
  }

  function clearWatchdog() {
    if (speechWatchdogTimer) {
      clearTimeout(speechWatchdogTimer);
      speechWatchdogTimer = null;
    }
  }

  function armWatchdog(maxMs, onExpire) {
    clearWatchdog();
    speechWatchdogTimer = setTimeout(() => {
      isSpeaking = false;
      isSynthesizing = false;
      if (typeof onExpire === 'function') onExpire();
    }, maxMs);
  }

  function computeRequiredRatePct(segment, videoPlaybackRate = 1) {
    const charsPerSecNormal = 16.5;
    const estimatedDuration = (segment.text || '').length / charsPerSecNormal;
    const availableDuration = Math.max(1.4, segment.duration || 3.0);
    const rawRatio = Math.min(1.18, Math.max(1.0, estimatedDuration / availableDuration));
    const userSpeed = Number(settings.baseSpeed) || 1.0;
    const totalMultiplier = Math.min(1.32, rawRatio * userSpeed * videoPlaybackRate);
    return Math.round((totalMultiplier - 1.0) * 100);
  }

  /**
   * Solicita la síntesis de voz según el modo activo:
   * - Si workMode === 'gemini-api': usa SYNTHESIZE_GEMINI_TTS (voces Kore, Puck, Aoede, Charon, Fenrir...)
   * - Si workMode === 'tts-only': usa SYNTHESIZE_EDGE_TTS
   */
  function requestRemoteTTS(text, ratePct = 0) {
    if (isUsingGeminiVoice()) {
      return chrome.runtime.sendMessage({
        type: 'SYNTHESIZE_GEMINI_TTS',
        payload: {
          text,
          geminiVoice: settings.geminiVoice || 'Kore',
          apiKey: settings.geminiApiKey,
          fallbackEdgeVoice: settings.edgeVoice || 'es-ES-AlvaroNeural',
          ratePct
        }
      });
    }

    return chrome.runtime.sendMessage({
      type: 'SYNTHESIZE_EDGE_TTS',
      payload: {
        text,
        voice: settings.edgeVoice || 'es-ES-AlvaroNeural',
        ratePct
      }
    });
  }

  function prefetchSegment(segment) {
    if (!segment || segment.needsTranslation) return null;
    if (!isUsingGeminiVoice() && settings.engine !== 'edge-neural') return null;

    if (prefetchedAudio.has(segment.id)) {
      return Promise.resolve(prefetchedAudio.get(segment.id));
    }
    if (prefetchPromises.has(segment.id)) {
      return prefetchPromises.get(segment.id);
    }

    const playbackRate = videoEl ? videoEl.playbackRate || 1 : 1;
    const ratePct = computeRequiredRatePct(segment, playbackRate);

    const promise = requestRemoteTTS(segment.text, ratePct)
      .then((res) => {
        prefetchPromises.delete(segment.id);
        if (res && res.ok && res.audioDataUrl) {
          prefetchedAudio.set(segment.id, res.audioDataUrl);
          return res.audioDataUrl;
        }
        throw new Error(res?.error || 'Fallo en síntesis de voz');
      })
      .catch((err) => {
        prefetchPromises.delete(segment.id);
        throw err;
      });

    prefetchPromises.set(segment.id, promise);
    return promise;
  }

  async function triggerLookaheadPrefetch(currentTime) {
    if (!isActive || !segments.length) return;

    if (
      window.YTDubberSubtitles &&
      typeof window.YTDubberSubtitles.ensureWindowTranslated === 'function'
    ) {
      await window.YTDubberSubtitles.ensureWindowTranslated(
        segments,
        currentTime,
        settings.targetLang
      );
    }

    const useRemoteAudio = isUsingGeminiVoice() || settings.engine === 'edge-neural';
    if (!useRemoteAudio) return;

    // En modo Gemini API pre-cargamos los próximos 2 segmentos para ahorrar cuota; en Edge Neural los próximos 4
    const maxLookaheadCount = isUsingGeminiVoice() ? 2 : 4;
    let count = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.start + seg.duration < currentTime) continue;
      if (seg.start - currentTime > 20) break;
      if (!seg.needsTranslation) {
        prefetchSegment(seg).catch(() => {});
        count++;
        if (count >= maxLookaheadCount) break;
      }
    }
  }

  function applyAudioDucking() {
    if (!videoEl) return;
    if (restoreVolumeTimeout) {
      clearTimeout(restoreVolumeTimeout);
      restoreVolumeTimeout = null;
    }
    if (!volumeDuckingApplied) {
      if (videoEl.volume > settings.duckVolume + 0.02) {
        originalVideoVolume = videoEl.volume;
      }
      volumeDuckingApplied = true;
    }
    videoEl.volume = Math.min(originalVideoVolume, settings.duckVolume);
  }

  function scheduleRestoreVideoVolume(delayMs = 350) {
    if (restoreVolumeTimeout) {
      clearTimeout(restoreVolumeTimeout);
    }
    restoreVolumeTimeout = setTimeout(() => {
      if (!isSpeaking && videoEl && volumeDuckingApplied) {
        videoEl.volume = originalVideoVolume;
        volumeDuckingApplied = false;
      }
    }, delayMs);
  }

  function stopCurrentSpeech(restoreImmediately = false) {
    clearWatchdog();
    isSpeaking = false;
    isSynthesizing = false;
    pendingLiveQueue = [];

    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.src = '';
      } catch (_) {}
      currentAudio = null;
    }

    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
    }
    window.__ytDubberActiveUtterance = null;

    if (restoreImmediately && videoEl && volumeDuckingApplied) {
      if (restoreVolumeTimeout) clearTimeout(restoreVolumeTimeout);
      videoEl.volume = originalVideoVolume;
      volumeDuckingApplied = false;
    } else {
      scheduleRestoreVideoVolume(450);
    }
  }

  function pickBestNativeVoice(langCode) {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) return null;

    if (settings.nativeVoiceURI) {
      const exact = voices.find(
        (v) => v.voiceURI === settings.nativeVoiceURI || v.name === settings.nativeVoiceURI
      );
      if (exact) return exact;
    }

    const baseLang = (langCode || 'es').split('-')[0].toLowerCase();
    const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(baseLang));
    if (!matching.length) return voices[0];

    const msNatural = matching.find((v) => /natural|online/i.test(v.name));
    if (msNatural) return msNatural;

    const googleOrMs = matching.find((v) => /google|microsoft/i.test(v.name));
    if (googleOrMs) return googleOrMs;

    return matching[0];
  }

  function onFinishSpeakingItem() {
    clearWatchdog();
    isSpeaking = false;
    isSynthesizing = false;
    currentAudio = null;
    window.__ytDubberActiveUtterance = null;

    if (!isActive || (videoEl && videoEl.paused)) {
      scheduleRestoreVideoVolume(400);
      return;
    }

    if (pendingLiveQueue.length > 0) {
      if (pendingLiveQueue.length > 2) {
        const combinedText = pendingLiveQueue.map((item) => item.text).join(' ');
        pendingLiveQueue = [];
        playLiveItem({ text: combinedText, durationHint: 4.5 });
      } else {
        const nextItem = pendingLiveQueue.shift();
        playLiveItem(nextItem);
      }
      return;
    }

    if (segments.length > 0 && videoEl) {
      onVideoTimeUpdate();
    }

    if (!isSpeaking && !isSynthesizing) {
      scheduleRestoreVideoVolume(600);
      emitStatus('Sincronizado', 'ready');
    }
  }

  function speakWithNativeBrowserTTS(segment) {
    if (!window.speechSynthesis) {
      onFinishSpeakingItem();
      return;
    }

    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch (_) {}

    const utterance = new SpeechSynthesisUtterance(segment.text);
    window.__ytDubberActiveUtterance = utterance;

    const voice = pickBestNativeVoice(settings.targetLang);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = settings.targetLang || 'es-ES';
    }

    const playbackRate = videoEl ? videoEl.playbackRate || 1 : 1;
    const ratePct = computeRequiredRatePct(segment, playbackRate);
    utterance.rate = Math.max(0.9, Math.min(1.3, 1 + ratePct / 100));
    utterance.volume = Math.max(0, Math.min(1, settings.dubVolume));

    const estimatedMs = Math.max(4000, segment.text.length * 95);
    armWatchdog(estimatedMs + 2500, () => {
      onFinishSpeakingItem();
    });

    utterance.onstart = () => {
      isSynthesizing = false;
      isSpeaking = true;
      applyAudioDucking();
      emitSubtitle(segment.text);
      emitStatus('Doblaje activo (Voz Nativa)', 'speaking');
    };

    utterance.onend = () => {
      onFinishSpeakingItem();
    };

    utterance.onerror = () => {
      onFinishSpeakingItem();
    };

    isSpeaking = true;
    applyAudioDucking();
    emitSubtitle(segment.text);
    window.speechSynthesis.speak(utterance);
  }

  async function speakSegment(segment) {
    if (isSpeaking || isSynthesizing) return;

    currentSegmentId = segment.id;
    lastSpokenSegmentId = segment.id;
    isSynthesizing = true;
    emitSubtitle(segment.text);

    if (segment.needsTranslation && window.YTDubberSubtitles) {
      await window.YTDubberSubtitles.ensureWindowTranslated(
        segments,
        segment.start,
        settings.targetLang
      );
      emitSubtitle(segment.text);
    }

    if (!isActive || !videoEl || videoEl.paused) {
      isSynthesizing = false;
      return;
    }

    if (!isUsingGeminiVoice() && settings.engine === 'browser-native') {
      speakWithNativeBrowserTTS(segment);
      return;
    }

    try {
      const audioDataUrl = await prefetchSegment(segment);
      if (!isActive || !videoEl || videoEl.paused) {
        isSynthesizing = false;
        return;
      }

      const audio = new Audio(audioDataUrl);
      currentAudio = audio;
      audio.volume = Math.max(0, Math.min(1, settings.dubVolume));

      // En Gemini TTS aplicamos el multiplicador baseSpeed directamente al elemento <audio>
      const baseRate = isUsingGeminiVoice() ? Number(settings.baseSpeed) || 1.0 : 1.0;
      const lag = videoEl.currentTime - segment.start;
      audio.playbackRate = lag > 0.8 ? Math.min(1.25, baseRate * 1.1) : baseRate;

      armWatchdog(15000, () => {
        onFinishSpeakingItem();
      });

      audio.onplay = () => {
        isSynthesizing = false;
        isSpeaking = true;
        applyAudioDucking();
        emitSubtitle(segment.text);
        const label = isUsingGeminiVoice()
          ? `Voz Gemini (${settings.geminiVoice || 'Kore'})`
          : 'Edge Neural';
        emitStatus(`Doblaje activo (${label})`, 'speaking');
      };

      audio.onended = () => {
        onFinishSpeakingItem();
      };

      audio.onerror = () => {
        isSynthesizing = false;
        speakWithNativeBrowserTTS(segment);
      };

      await audio.play();
    } catch (_) {
      isSynthesizing = false;
      if (isActive && videoEl && !videoEl.paused) {
        speakWithNativeBrowserTTS(segment);
      }
    }
  }

  async function playLiveItem({ text, durationHint = 3.2 }) {
    if (!isActive || !text || (videoEl && videoEl.paused)) {
      isSynthesizing = false;
      isSpeaking = false;
      return;
    }

    isSynthesizing = true;
    emitSubtitle(text);

    if (liveSubtitleClearTimeout) clearTimeout(liveSubtitleClearTimeout);
    liveSubtitleClearTimeout = setTimeout(() => {
      if (!isSpeaking && !isSynthesizing) emitSubtitle('');
    }, Math.max(4500, durationHint * 1500));

    const pseudoSegment = {
      id: `live_${Date.now()}`,
      start: videoEl ? videoEl.currentTime : 0,
      duration: durationHint,
      text
    };

    if (!isUsingGeminiVoice() && settings.engine === 'browser-native') {
      speakWithNativeBrowserTTS(pseudoSegment);
      return;
    }

    try {
      const playbackRate = videoEl ? videoEl.playbackRate || 1 : 1;
      const ratePct = computeRequiredRatePct(pseudoSegment, playbackRate);
      const res = await requestRemoteTTS(text, ratePct);

      if (!isActive || (videoEl && videoEl.paused)) {
        isSynthesizing = false;
        return;
      }

      if (!res || !res.ok || !res.audioDataUrl) {
        throw new Error(res?.error || 'Error TTS');
      }

      const audio = new Audio(res.audioDataUrl);
      currentAudio = audio;
      audio.volume = Math.max(0, Math.min(1, settings.dubVolume));

      const baseRate = isUsingGeminiVoice() ? Number(settings.baseSpeed) || 1.0 : 1.0;
      audio.playbackRate = pendingLiveQueue.length > 0 ? Math.min(1.25, baseRate * 1.08) : baseRate;

      armWatchdog(15000, () => {
        onFinishSpeakingItem();
      });

      audio.onplay = () => {
        isSynthesizing = false;
        isSpeaking = true;
        applyAudioDucking();
        emitSubtitle(text);
        const label = isUsingGeminiVoice()
          ? `Voz Gemini (${settings.geminiVoice || 'Kore'})`
          : 'Edge Neural';
        emitStatus(`Doblaje en Vivo (${label})`, 'speaking');
      };

      audio.onended = () => {
        onFinishSpeakingItem();
      };

      audio.onerror = () => {
        isSynthesizing = false;
        speakWithNativeBrowserTTS(pseudoSegment);
      };

      await audio.play();
    } catch (_) {
      isSynthesizing = false;
      if (isActive) {
        speakWithNativeBrowserTTS(pseudoSegment);
      }
    }
  }

  function speakLiveText(text, durationHint = 3.2) {
    if (!isActive || !text || (videoEl && videoEl.paused)) return;

    emitSubtitle(text);

    if (isSpeaking || isSynthesizing) {
      pendingLiveQueue.push({ text, durationHint });
      return;
    }

    playLiveItem({ text, durationHint });
  }

  function onVideoTimeUpdate() {
    if (!isActive || !videoEl || videoEl.paused || !segments.length) return;

    const now = videoEl.currentTime;
    triggerLookaheadPrefetch(now);

    const currentVisualSeg = segments.find(
      (s) => now >= s.start - 0.1 && now <= s.start + s.duration
    );
    if (currentVisualSeg && !currentVisualSeg.needsTranslation) {
      emitSubtitle(currentVisualSeg.text);
    } else if (!isSpeaking && !isSynthesizing) {
      emitSubtitle('');
    }

    if (isSpeaking || isSynthesizing) return;

    if (currentVisualSeg && currentVisualSeg.id !== lastSpokenSegmentId) {
      speakSegment(currentVisualSeg);
    }
  }

  function onVideoPause() {
    stopCurrentSpeech(true);
    if (isActive) {
      emitStatus('En pausa', 'paused');
    }
  }

  function onVideoPlay() {
    if (!isActive || !videoEl) return;
    if (segments.length > 0) {
      triggerLookaheadPrefetch(videoEl.currentTime);
      onVideoTimeUpdate();
    }
  }

  function onVideoSeeking() {
    if (!isActive) return;
    currentSegmentId = -1;
    lastSpokenSegmentId = -1;
    stopCurrentSpeech(false);
    emitSubtitle('');
    if (videoEl && segments.length > 0) {
      triggerLookaheadPrefetch(videoEl.currentTime);
    }
  }

  function attachToVideo(videoElement, loadedSegments) {
    detachFromVideo();
    videoEl = videoElement;
    segments = Array.isArray(loadedSegments) ? loadedSegments : [];
    currentSegmentId = -1;
    lastSpokenSegmentId = -1;
    prefetchPromises.clear();
    prefetchedAudio.clear();

    if (!videoEl) return;
    originalVideoVolume = videoEl.volume || 1.0;

    videoEl.addEventListener('timeupdate', onVideoTimeUpdate);
    videoEl.addEventListener('pause', onVideoPause);
    videoEl.addEventListener('play', onVideoPlay);
    videoEl.addEventListener('seeking', onVideoSeeking);

    if (isActive && !videoEl.paused && segments.length > 0) {
      triggerLookaheadPrefetch(videoEl.currentTime);
      onVideoTimeUpdate();
    }
  }

  function detachFromVideo() {
    stopCurrentSpeech(true);
    if (videoEl) {
      videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
      videoEl.removeEventListener('pause', onVideoPause);
      videoEl.removeEventListener('play', onVideoPlay);
      videoEl.removeEventListener('seeking', onVideoSeeking);
    }
    videoEl = null;
  }

  function setActive(active) {
    isActive = Boolean(active);
    if (!isActive) {
      currentSegmentId = -1;
      lastSpokenSegmentId = -1;
      stopCurrentSpeech(true);
      emitSubtitle('');
      emitStatus('Doblaje desactivado', 'idle');
    } else {
      emitStatus('Preparado', 'ready');
      if (videoEl && segments.length > 0) {
        triggerLookaheadPrefetch(videoEl.currentTime);
        if (!videoEl.paused) {
          onVideoTimeUpdate();
        }
      }
    }
  }

  function getIsActive() {
    return isActive;
  }

  return {
    updateSettings,
    getSettings,
    setCallbacks,
    attachToVideo,
    detachFromVideo,
    setActive,
    getIsActive,
    stopCurrentSpeech,
    speakLiveText
  };
})();
