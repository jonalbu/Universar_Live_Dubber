// Content Script Universal - YouTube & Cualquier Video de la Web
// Detecta reproductores en YouTube, Vimeo, Udemy, Coursera, Twitch, X/Twitter, Reddit y cualquier <video> HTML5

(function () {
  if (window.__ytLiveDubberContentLoaded) return;
  window.__ytLiveDubberContentLoaded = true;

  const isYouTube = /(^|\.)youtube\.com$/i.test(window.location.hostname);

  let currentVideoId = null;
  let activeVideoEl = null;
  let latestTracksInfo = null;
  let latestInterceptedTimedText = null;
  let loadedSegments = [];
  let loadedForLang = null;
  let loadedForVideoSrc = null;
  let isLoadingSubtitles = false;

  let playerBtn = null;
  let statusBadge = null;
  let subtitleOverlay = null;
  let universalHudContainer = null;

  chrome.storage.local.get(['ytDubberSettings'], (res) => {
    if (res && res.ytDubberSettings) {
      window.YTDubberTTSEngine.updateSettings(res.ytDubberSettings);
    }
    initUI();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ytDubberSettings) {
      const newSettings = changes.ytDubberSettings.newValue || {};
      const prevSettings = window.YTDubberTTSEngine.getSettings();
      window.YTDubberTTSEngine.updateSettings(newSettings);

      if (subtitleOverlay && !newSettings.showSubtitlesOverlay) {
        subtitleOverlay.style.display = 'none';
      }

      if (newSettings.targetLang && newSettings.targetLang !== prevSettings.targetLang) {
        loadedSegments = [];
        window.YTDubberLiveCapturer.setTargetLang(newSettings.targetLang);
        if (window.YTDubberTTSEngine.getIsActive()) {
          startDubbingForCurrentVideo();
        }
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'GET_TAB_DUBBER_STATE') {
      const video = findBestVideoElement();
      sendResponse({
        ok: true,
        isActive: window.YTDubberTTSEngine.getIsActive(),
        hasVideo: Boolean(video),
        videoId: currentVideoId || (video ? video.currentSrc || 'html5-video' : null),
        segmentsCount: loadedSegments.length,
        hasTracks: Boolean(
          latestTracksInfo?.captionTracks?.length ||
            latestInterceptedTimedText ||
            video?.textTracks?.length
        )
      });
      return false;
    }

    if (msg.type === 'TOGGLE_DUBBING_FROM_POPUP') {
      toggleDubbing(msg.payload?.forceState);
      sendResponse({
        ok: true,
        isActive: window.YTDubberTTSEngine.getIsActive()
      });
      return false;
    }

    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'YT_LIVE_DUBBER_MAIN') {
      return;
    }

    if (event.data.type === 'CAPTION_TRACKS_INFO') {
      const info = event.data.payload;
      if (!info || !info.videoId) return;

      if (info.videoId !== currentVideoId) {
        currentVideoId = info.videoId;
        loadedSegments = [];
        loadedForLang = null;
        latestInterceptedTimedText = null;
        window.YTDubberLiveCapturer.stop();
        window.YTDubberTTSEngine.stopCurrentSpeech(true);

        if (window.YTDubberTTSEngine.getIsActive()) {
          setTimeout(() => startDubbingForCurrentVideo(), 400);
        }
      }

      latestTracksInfo = info;
    }

    if (event.data.type === 'TIMEDTEXT_INTERCEPTED') {
      latestInterceptedTimedText = event.data.payload;
      if (
        window.YTDubberTTSEngine.getIsActive() &&
        loadedSegments.length === 0 &&
        !isLoadingSubtitles
      ) {
        startDubbingForCurrentVideo();
      }
    }
  });

  window.YTDubberTTSEngine.setCallbacks({
    onStatusChange: ({ statusText, state }) => {
      updateButtonVisualState(state, statusText);
    },
    onSubtitleChange: (text) => {
      updateSubtitleOverlay(text);
    }
  });

  function findBestVideoElement() {
    if (isYouTube) {
      const ytMain = document.querySelector('video.html5-main-video');
      if (ytMain) return ytMain;
    }

    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;

    let bestVideo = null;
    let bestScore = -1;

    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 90) continue;
      let score = rect.width * rect.height;
      if (!v.paused) score *= 3;
      if (v.readyState >= 2) score *= 1.3;
      if (score > bestScore) {
        bestScore = score;
        bestVideo = v;
      }
    }

    return bestVideo || videos[0];
  }

  function updateButtonVisualState(state, tooltipText) {
    if (!playerBtn) return;
    const isActive = window.YTDubberTTSEngine.getIsActive();
    playerBtn.classList.toggle('yt-dubber-active', isActive);
    playerBtn.classList.toggle('yt-dubber-speaking', state === 'speaking');
    playerBtn.classList.toggle('yt-dubber-loading', state === 'loading');

    const moviePlayer = document.getElementById('movie_player');
    if (moviePlayer) {
      moviePlayer.classList.toggle('yt-dubber-hide-native-cc', isActive);
    }

    const title = isActive
      ? `Doblaje IA Activo (${tooltipText || 'Sincronizado'}) - Clic para desactivar`
      : 'Activar Doblaje IA en Tiempo Real';
    playerBtn.setAttribute('title', title);
    playerBtn.setAttribute('aria-label', title);

    if (statusBadge) {
      if (!isActive) {
        statusBadge.textContent = 'DUB';
      } else if (state === 'loading') {
        statusBadge.textContent = '...';
      } else {
        const lang = (window.YTDubberTTSEngine.getSettings().targetLang || 'es')
          .split('-')[0]
          .toUpperCase();
        statusBadge.textContent = lang;
      }
    }
  }

  function updateSubtitleOverlay(text) {
    ensurePlayerElements();
    if (!subtitleOverlay) return;
    const settings = window.YTDubberTTSEngine.getSettings();
    if (!text || !settings.showSubtitlesOverlay || !window.YTDubberTTSEngine.getIsActive()) {
      subtitleOverlay.style.display = 'none';
      subtitleOverlay.textContent = '';
      return;
    }
    subtitleOverlay.textContent = text;
    subtitleOverlay.style.display = 'block';
    positionUniversalHud();
  }

  function positionUniversalHud() {
    if (!universalHudContainer || !activeVideoEl) return;
    const rect = activeVideoEl.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      universalHudContainer.style.display = 'none';
      return;
    }
    universalHudContainer.style.display = 'block';
    universalHudContainer.style.top = `${window.scrollY + rect.top}px`;
    universalHudContainer.style.left = `${window.scrollX + rect.left}px`;
    universalHudContainer.style.width = `${rect.width}px`;
    universalHudContainer.style.height = `${rect.height}px`;
  }

  function ensurePlayerElements() {
    const rightControls = isYouTube ? document.querySelector('.ytp-right-controls') : null;
    const moviePlayer = isYouTube ? document.getElementById('movie_player') : null;

    if (rightControls && moviePlayer) {
      if (!document.getElementById('yt-live-dubber-btn')) {
        playerBtn = document.createElement('button');
        playerBtn.id = 'yt-live-dubber-btn';
        playerBtn.className = 'ytp-button yt-dubber-btn';
        playerBtn.type = 'button';
        playerBtn.setAttribute('title', 'Activar Doblaje IA en Tiempo Real');
        playerBtn.innerHTML = `
          <div class="yt-dubber-btn-inner">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
            </svg>
            <span class="yt-dubber-badge" id="yt-dubber-badge">DUB</span>
          </div>
        `;

        playerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleDubbing();
        });

        rightControls.prepend(playerBtn);
        statusBadge = playerBtn.querySelector('#yt-dubber-badge');
        updateButtonVisualState('idle', '');
      }

      if (!document.getElementById('yt-live-dubber-subtitles')) {
        subtitleOverlay = document.createElement('div');
        subtitleOverlay.id = 'yt-live-dubber-subtitles';
        subtitleOverlay.className = 'yt-dubber-subtitle-overlay';
        subtitleOverlay.style.display = 'none';
        moviePlayer.appendChild(subtitleOverlay);
      }
      return;
    }

    const video = findBestVideoElement();
    if (!video) return;
    activeVideoEl = video;

    if (!document.getElementById('yt-dubber-universal-hud')) {
      universalHudContainer = document.createElement('div');
      universalHudContainer.id = 'yt-dubber-universal-hud';
      universalHudContainer.className = 'yt-dubber-universal-hud';

      playerBtn = document.createElement('button');
      playerBtn.id = 'yt-live-dubber-btn';
      playerBtn.className = 'yt-dubber-floating-btn yt-dubber-btn';
      playerBtn.type = 'button';
      playerBtn.setAttribute('title', 'Activar Doblaje IA en Tiempo Real');
      playerBtn.innerHTML = `
        <div class="yt-dubber-btn-inner">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
          </svg>
          <span class="yt-dubber-badge" id="yt-dubber-badge">DUB</span>
        </div>
      `;

      playerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDubbing();
      });

      subtitleOverlay = document.createElement('div');
      subtitleOverlay.id = 'yt-live-dubber-subtitles';
      subtitleOverlay.className = 'yt-dubber-subtitle-overlay';
      subtitleOverlay.style.display = 'none';

      universalHudContainer.appendChild(playerBtn);
      universalHudContainer.appendChild(subtitleOverlay);
      document.body.appendChild(universalHudContainer);

      statusBadge = playerBtn.querySelector('#yt-dubber-badge');
      updateButtonVisualState('idle', '');
    }

    positionUniversalHud();
  }

  function requestTracksWithWait(timeoutMs = 1100) {
    return new Promise((resolve) => {
      window.postMessage(
        { source: 'YT_LIVE_DUBBER_CONTENT', type: 'REQUEST_CAPTION_TRACKS' },
        '*'
      );
      const start = Date.now();
      const timer = setInterval(() => {
        if (
          (latestTracksInfo && latestTracksInfo.captionTracks?.length > 0) ||
          latestInterceptedTimedText ||
          Date.now() - start >= timeoutMs
        ) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  }

  async function startDubbingForCurrentVideo() {
    if (isLoadingSubtitles) return;
    const videoEl = findBestVideoElement();
    if (!videoEl) return;
    activeVideoEl = videoEl;

    const settings = window.YTDubberTTSEngine.getSettings();
    const targetLang = settings.targetLang || 'es';
    const currentSrcKey = currentVideoId || videoEl.currentSrc || window.location.href;

    if (
      loadedSegments.length > 0 &&
      loadedForLang === targetLang &&
      loadedForVideoSrc === currentSrcKey
    ) {
      window.YTDubberLiveCapturer.stop();
      window.YTDubberTTSEngine.attachToVideo(videoEl, loadedSegments);
      window.YTDubberTTSEngine.setActive(true);
      updateButtonVisualState('ready', 'Sincronizado');
      return;
    }

    isLoadingSubtitles = true;
    window.YTDubberTTSEngine.setActive(true);
    updateButtonVisualState('loading', 'Preparando doblaje...');
    updateSubtitleOverlay('⏳ Preparando traducción y voz neuronal...');

    try {
      if (isYouTube && (!latestTracksInfo || !latestTracksInfo.captionTracks?.length)) {
        await requestTracksWithWait(1100);
      }

      let result = null;
      try {
        result = await window.YTDubberSubtitles.loadTranslatedSubtitles(
          latestTracksInfo,
          targetLang,
          latestInterceptedTimedText,
          videoEl
        );
      } catch (firstErr) {
        if (isYouTube) {
          window.postMessage(
            { source: 'YT_LIVE_DUBBER_CONTENT', type: 'TRIGGER_NATIVE_SUBTITLE_LOAD' },
            '*'
          );
          await new Promise((r) => setTimeout(r, 1100));
          result = await window.YTDubberSubtitles.loadTranslatedSubtitles(
            latestTracksInfo,
            targetLang,
            latestInterceptedTimedText,
            videoEl
          );
        } else {
          throw firstErr;
        }
      }

      loadedSegments = result.segments || [];
      loadedForLang = targetLang;
      loadedForVideoSrc = currentSrcKey;
      isLoadingSubtitles = false;

      if (loadedSegments.length > 0) {
        window.YTDubberLiveCapturer.stop();
        window.YTDubberTTSEngine.attachToVideo(videoEl, loadedSegments);
        window.YTDubberTTSEngine.setActive(true);
        updateSubtitleOverlay('');
        updateButtonVisualState('ready', `Listo (${loadedSegments.length} frases)`);
        return;
      }
    } catch (_) {
      // Si el video requiere lectura dinámica en tiempo real, activamos el Capturador En Vivo Universal
    }

    isLoadingSubtitles = false;
    loadedSegments = [];
    if (isYouTube) {
      window.postMessage(
        { source: 'YT_LIVE_DUBBER_CONTENT', type: 'TRIGGER_NATIVE_SUBTITLE_LOAD' },
        '*'
      );
    }
    window.YTDubberTTSEngine.attachToVideo(videoEl, []);
    window.YTDubberTTSEngine.setActive(true);
    window.YTDubberLiveCapturer.start(videoEl, targetLang);
    updateButtonVisualState('ready', 'Modo En Vivo Activo');
    updateSubtitleOverlay('🎙️ Doblaje en vivo activado');
    setTimeout(() => {
      if (subtitleOverlay && subtitleOverlay.textContent.includes('Doblaje en vivo activado')) {
        updateSubtitleOverlay('');
      }
    }, 2400);
  }

  function toggleDubbing(forceState) {
    const nextState =
      typeof forceState === 'boolean'
        ? forceState
        : !window.YTDubberTTSEngine.getIsActive();

    if (nextState) {
      startDubbingForCurrentVideo();
    } else {
      window.YTDubberLiveCapturer.stop();
      window.YTDubberTTSEngine.setActive(false);
      updateButtonVisualState('idle', '');
    }
  }

  function initUI() {
    ensurePlayerElements();
    const observer = new MutationObserver(() => {
      ensurePlayerElements();
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('resize', positionUniversalHud, { passive: true });
    window.addEventListener('scroll', positionUniversalHud, { passive: true });
    setInterval(positionUniversalHud, 1200);

    if (isYouTube) {
      window.postMessage(
        { source: 'YT_LIVE_DUBBER_CONTENT', type: 'REQUEST_CAPTION_TRACKS' },
        '*'
      );
    }
  }
})();
