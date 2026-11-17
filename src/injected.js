// Se ejecuta en el MAIN world en cualquier página web:
// 1. En YouTube: extrae captionTracks de #movie_player, activa el módulo de subtítulos si es necesario e intercepta /api/timedtext.
// 2. En toda la web: intercepta descargas de pistas de subtítulos (.vtt, .srt, .ttml, timedtext) por XHR o fetch.

(function () {
  if (window.__ytLiveDubberInjected) return;
  window.__ytLiveDubberInjected = true;

  const isYouTube = /(^|\.)youtube\.com$/i.test(window.location.hostname);
  let lastVideoId = null;
  let lastTimedTextUrl = null;

  function isSubtitleUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('/api/timedtext') ||
      /\.(vtt|srt|ttml|dfxp)(\?|$|#)/i.test(url) ||
      /[?&](format|fmt)=(vtt|srt|json3|srv3)/i.test(url)
    );
  }

  function looksLikeSubtitleContent(text) {
    if (!text || typeof text !== 'string') return false;
    const head = text.trim().slice(0, 120);
    return (
      head.startsWith('WEBVTT') ||
      /^\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head) ||
      head.includes('"events"') ||
      head.includes('<transcript') ||
      head.includes('<tt ')
    );
  }

  function extractTracksFromYouTubePlayer() {
    if (!isYouTube) return null;
    try {
      const player = document.getElementById('movie_player');
      let playerResponse = null;

      if (player && typeof player.getPlayerResponse === 'function') {
        playerResponse = player.getPlayerResponse();
      }
      if (!playerResponse && window.ytInitialPlayerResponse) {
        playerResponse = window.ytInitialPlayerResponse;
      }
      if (!playerResponse) return null;

      const videoId =
        playerResponse?.videoDetails?.videoId ||
        new URLSearchParams(window.location.search).get('v') ||
        window.location.pathname;

      const tracklist =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      return {
        videoId,
        captionTracks: tracklist.map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          vssId: t.vssId,
          kind: t.kind || '',
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
          isTranslatable: Boolean(t.isTranslatable)
        })),
        lastTimedTextUrl
      };
    } catch (_) {
      return null;
    }
  }

  function broadcastYouTubeTracks(reason = 'auto') {
    if (!isYouTube) return;
    const info = extractTracksFromYouTubePlayer();
    if (!info || !info.videoId) return;
    lastVideoId = info.videoId;

    window.postMessage(
      {
        source: 'YT_LIVE_DUBBER_MAIN',
        type: 'CAPTION_TRACKS_INFO',
        reason,
        payload: info
      },
      '*'
    );
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytDubberUrl = typeof url === 'string' ? url : String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (isSubtitleUrl(this.__ytDubberUrl)) {
      if (this.__ytDubberUrl.includes('/api/timedtext')) {
        lastTimedTextUrl = this.__ytDubberUrl;
      }
      this.addEventListener('load', function () {
        try {
          if (typeof this.responseText === 'string' && looksLikeSubtitleContent(this.responseText)) {
            window.postMessage(
              {
                source: 'YT_LIVE_DUBBER_MAIN',
                type: 'TIMEDTEXT_INTERCEPTED',
                payload: {
                  url: this.__ytDubberUrl,
                  responseText: this.responseText
                }
              },
              '*'
            );
          }
        } catch (_) {}
      });
    }
    return origSend.apply(this, args);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const response = await origFetch.apply(this, args);
    if (isSubtitleUrl(reqUrl)) {
      if (reqUrl.includes('/api/timedtext')) {
        lastTimedTextUrl = reqUrl;
      }
      try {
        const clone = response.clone();
        clone.text().then((text) => {
          if (looksLikeSubtitleContent(text)) {
            window.postMessage(
              {
                source: 'YT_LIVE_DUBBER_MAIN',
                type: 'TIMEDTEXT_INTERCEPTED',
                payload: {
                  url: reqUrl,
                  responseText: text
                }
              },
              '*'
            );
          }
        });
      } catch (_) {}
    }
    return response;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'YT_LIVE_DUBBER_CONTENT') {
      return;
    }

    if (event.data.type === 'REQUEST_CAPTION_TRACKS') {
      if (isYouTube) {
        try {
          const player = document.getElementById('movie_player');
          if (player && typeof player.loadModule === 'function') {
            player.loadModule('captions');
          }
        } catch (_) {}
        broadcastYouTubeTracks('request');
      }
    }

    if (event.data.type === 'TRIGGER_NATIVE_SUBTITLE_LOAD') {
      if (isYouTube) {
        try {
          const player = document.getElementById('movie_player');
          if (player) {
            if (typeof player.loadModule === 'function') {
              player.loadModule('captions');
            }
            if (typeof player.toggleSubtitlesOn === 'function') {
              player.toggleSubtitlesOn();
            }
            // Si el botón CC de YouTube está apagado, activarlo para que YouTube emita /api/timedtext con token POT
            const ccBtn = document.querySelector('.ytp-subtitles-button');
            if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
              ccBtn.click();
            }
          }
        } catch (_) {}
      }
    }
  });

  if (isYouTube) {
    window.addEventListener('yt-navigate-finish', () => {
      lastTimedTextUrl = null;
      setTimeout(() => broadcastYouTubeTracks('yt-navigate-finish'), 500);
      setTimeout(() => broadcastYouTubeTracks('yt-navigate-finish-delayed'), 1800);
    });

    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => broadcastYouTubeTracks('dom-ready'), 700);
    });

    setInterval(() => {
      const currentVideoId =
        new URLSearchParams(window.location.search).get('v') || window.location.pathname;
      if (currentVideoId && currentVideoId !== lastVideoId) {
        lastTimedTextUrl = null;
        broadcastYouTubeTracks('url-change');
      }
    }, 1500);
  }
})();
