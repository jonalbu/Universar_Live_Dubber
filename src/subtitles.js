// Módulo Universal de Subtítulos con Traducción por Ventana Deslizante (Soporta videos de 30+ horas sin HTTP 429)

window.YTDubberSubtitles = (function () {
  let windowTranslationInFlight = false;

  function decodeHtmlEntities(str) {
    if (!str) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  }

  function cleanCaptionText(raw) {
    if (!raw) return '';
    return decodeHtmlEntities(raw)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/♪+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseTimestampToSeconds(ts) {
    if (!ts) return 0;
    const clean = ts.trim().replace(',', '.');
    const parts = clean.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return Number(parts[0]) || 0;
  }

  function parseVttOrSrt(text) {
    if (!text) return [];
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const rawEvents = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();
      const timeMatch = line.match(
        /((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})/
      );

      if (timeMatch) {
        const start = parseTimestampToSeconds(timeMatch[1]);
        const end = parseTimestampToSeconds(timeMatch[2]);
        const duration = Math.max(0.6, end - start);
        i++;

        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i].trim());
          i++;
        }

        const cleaned = cleanCaptionText(textLines.join(' '));
        if (cleaned) {
          rawEvents.push({ start, duration, text: cleaned });
        }
      } else {
        i++;
      }
    }

    return mergeIntoNaturalSegments(rawEvents);
  }

  function parseJson3(jsonText) {
    const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
    if (!data || !Array.isArray(data.events)) return [];

    const rawEvents = [];
    for (const ev of data.events) {
      if (!ev.segs || typeof ev.tStartMs !== 'number') continue;
      const text = cleanCaptionText(ev.segs.map((s) => s.utf8 || '').join(''));
      if (!text) continue;

      const start = ev.tStartMs / 1000;
      const duration = (ev.dDurationMs || 2500) / 1000;
      rawEvents.push({ start, duration, text });
    }
    return mergeIntoNaturalSegments(rawEvents);
  }

  function parseXml(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const textNodes = Array.from(doc.querySelectorAll('text, p'));
    const rawEvents = [];

    for (const node of textNodes) {
      let start = parseFloat(node.getAttribute('start') || '0');
      let duration = parseFloat(node.getAttribute('dur') || '0');
      const beginAttr = node.getAttribute('begin');
      const endAttr = node.getAttribute('end');

      if (beginAttr) {
        start = beginAttr.endsWith('s')
          ? parseFloat(beginAttr)
          : parseTimestampToSeconds(beginAttr);
      }
      if (endAttr) {
        const endSec = endAttr.endsWith('s')
          ? parseFloat(endAttr)
          : parseTimestampToSeconds(endAttr);
        duration = Math.max(0.6, endSec - start);
      }
      if (!duration) duration = 2.5;

      const text = cleanCaptionText(node.textContent || '');
      if (!text) continue;
      rawEvents.push({ start, duration, text });
    }
    return mergeIntoNaturalSegments(rawEvents);
  }

  function mergeIntoNaturalSegments(rawEvents) {
    if (!rawEvents.length) return [];

    const sorted = [...rawEvents].sort((a, b) => a.start - b.start);
    const deduped = [];

    for (const item of sorted) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === item.text && Math.abs(item.start - prev.start) < 4) {
        continue;
      }
      deduped.push({ ...item });
    }

    for (let i = 0; i < deduped.length - 1; i++) {
      const curr = deduped[i];
      const next = deduped[i + 1];
      if (curr.start + curr.duration > next.start) {
        curr.duration = Math.max(0.4, next.start - curr.start);
      }
    }

    const merged = [];
    let buffer = null;

    for (let i = 0; i < deduped.length; i++) {
      const seg = deduped[i];
      if (!buffer) {
        buffer = {
          start: seg.start,
          end: seg.start + seg.duration,
          text: seg.text
        };
      } else {
        const gap = seg.start - buffer.end;
        const combinedDuration = seg.start + seg.duration - buffer.start;
        const combinedLength = buffer.text.length + 1 + seg.text.length;
        const endsWithSentencePunct = /[.!?…:;]$/.test(buffer.text);

        // Segmentos más cortos y ágiles para videos rápidos (evita bloques largos que retrasan la síntesis)
        if (
          gap > 0.65 ||
          (endsWithSentencePunct && (combinedDuration > 2.2 || buffer.text.length > 45)) ||
          combinedDuration > 4.8 ||
          combinedLength > 125
        ) {
          merged.push({
            id: merged.length,
            start: Number(buffer.start.toFixed(2)),
            duration: Number(Math.max(0.8, buffer.end - buffer.start).toFixed(2)),
            text: buffer.text.trim(),
            originalText: buffer.text.trim(),
            needsTranslation: false
          });
          buffer = {
            start: seg.start,
            end: seg.start + seg.duration,
            text: seg.text
          };
        } else {
          buffer.end = seg.start + seg.duration;
          if (!buffer.text.endsWith(seg.text)) {
            buffer.text += ' ' + seg.text;
          }
        }
      }
    }

    if (buffer) {
      merged.push({
        id: merged.length,
        start: Number(buffer.start.toFixed(2)),
        duration: Number(Math.max(0.8, buffer.end - buffer.start).toFixed(2)),
        text: buffer.text.trim(),
        originalText: buffer.text.trim(),
        needsTranslation: false
      });
    }

    return merged;
  }

  function parseAnySubtitleText(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{')) {
      try {
        return parseJson3(trimmed);
      } catch (_) {}
    }
    if (trimmed.startsWith('WEBVTT') || /-->/.test(trimmed)) {
      const vttParsed = parseVttOrSrt(trimmed);
      if (vttParsed.length > 0) return vttParsed;
    }
    if (trimmed.startsWith('<')) {
      return parseXml(trimmed);
    }
    return [];
  }

  async function fetchUrlViaPageOrBg(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim().length > 0) return text;
      }
    } catch (_) {}

    const bgRes = await chrome.runtime.sendMessage({
      type: 'FETCH_URL_TEXT',
      payload: { url }
    });
    if (bgRes && bgRes.ok && bgRes.text) {
      return bgRes.text;
    }
    return '';
  }

  /**
   * Traduce únicamente una ventana deslizante de segmentos alrededor de currentTime (ej. -5s a +85s)
   * Evita por completo el error HTTP 429 en cursos largos (como videos de 10 o 30 horas).
   */
  async function ensureWindowTranslated(segments, currentTime = 0, targetLang = 'es') {
    if (!Array.isArray(segments) || !segments.length) return;
    const baseLang = (targetLang || 'es').split('-')[0].toLowerCase();

    // Seleccionar hasta 24 segmentos cercanos al tiempo actual que aún tengan needsTranslation = true
    const windowSegments = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.needsTranslation) continue;
      if (seg.start + seg.duration < currentTime - 3) continue;
      if (seg.start > currentTime + 115 && windowSegments.length >= 10) break;
      windowSegments.push(seg);
      if (windowSegments.length >= 24) break;
    }

    if (windowSegments.length === 0 || windowTranslationInFlight) return;

    windowTranslationInFlight = true;
    try {
      const texts = windowSegments.map((s) => s.originalText || s.text);
      const response = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_BATCH',
        payload: { texts, targetLang: baseLang }
      });

      if (response?.warning && window.YTDubberTTSEngine?.notifyRuntimeWarning) {
        window.YTDubberTTSEngine.notifyRuntimeWarning(`⚠️ ${response.warning}`);
      }

      if (response && response.ok && Array.isArray(response.translated)) {
        for (let j = 0; j < windowSegments.length; j++) {
          const seg = windowSegments[j];
          seg.text = response.translated[j] || seg.text;
          seg.needsTranslation = false;
        }
      }
    } catch (_) {
      // Si falla temporalmente, se reintentará en el siguiente ciclo sin romper el reproductor
    } finally {
      windowTranslationInFlight = false;
    }
  }

  /**
   * Marca todos los segmentos como pendientes de traducción por ventana y traduce de inmediato el primer minuto actual
   */
  async function prepareWindowedTranslation(segments, videoEl, targetLang) {
    for (const seg of segments) {
      seg.originalText = seg.text;
      seg.needsTranslation = true;
    }
    const now = videoEl ? videoEl.currentTime || 0 : 0;
    await ensureWindowTranslated(segments, now, targetLang);
    return segments;
  }

  async function extractFromHtml5Video(videoEl, targetLang = 'es') {
    if (!videoEl) return null;
    const baseLang = targetLang.split('-')[0].toLowerCase();

    if (videoEl.textTracks && videoEl.textTracks.length > 0) {
      const tracksArr = Array.from(videoEl.textTracks);
      for (const t of tracksArr) {
        if (t.mode === 'disabled') {
          try {
            t.mode = 'hidden';
          } catch (_) {}
        }
      }

      const trackWithCues =
        tracksArr.find(
          (t) => t.cues && t.cues.length > 0 && (t.language || '').toLowerCase().startsWith(baseLang)
        ) || tracksArr.find((t) => t.cues && t.cues.length > 0);

      if (trackWithCues && trackWithCues.cues.length > 0) {
        const rawEvents = [];
        for (let i = 0; i < trackWithCues.cues.length; i++) {
          const cue = trackWithCues.cues[i];
          const text = cleanCaptionText(cue.text || '');
          if (!text) continue;
          const start = Number(cue.startTime) || 0;
          const duration = Math.max(0.6, (Number(cue.endTime) || start + 2.5) - start);
          rawEvents.push({ start, duration, text });
        }
        const merged = mergeIntoNaturalSegments(rawEvents);
        if (merged.length > 0) {
          const isSameLang = (trackWithCues.language || '').toLowerCase().startsWith(baseLang);
          const finalSegments = isSameLang
            ? merged
            : await prepareWindowedTranslation(merged, videoEl, baseLang);
          return {
            segments: finalSegments,
            sourceTrack: `HTML5 TextTrack (${trackWithCues.label || trackWithCues.language || 'auto'})`,
            mode: 'html5-texttrack'
          };
        }
      }
    }

    const trackElements = Array.from(videoEl.querySelectorAll('track[src]'));
    if (trackElements.length > 0) {
      const preferredEl =
        trackElements.find((el) =>
          (el.getAttribute('srclang') || '').toLowerCase().startsWith(baseLang)
        ) || trackElements[0];

      const srcUrl = preferredEl.src || preferredEl.getAttribute('src');
      if (srcUrl) {
        const fullUrl = new URL(srcUrl, window.location.href).toString();
        const rawText = await fetchUrlViaPageOrBg(fullUrl);
        const parsed = parseAnySubtitleText(rawText);
        if (parsed.length > 0) {
          const srclang = (preferredEl.getAttribute('srclang') || '').toLowerCase();
          const finalSegments = srclang.startsWith(baseLang)
            ? parsed
            : await prepareWindowedTranslation(parsed, videoEl, baseLang);
          return {
            segments: finalSegments,
            sourceTrack: `HTML5 <track> (${srclang || 'subtitles'})`,
            mode: 'html5-track-src'
          };
        }
      }
    }

    return null;
  }

  async function loadTranslatedSubtitles(
    tracksInfo,
    targetLang = 'es',
    interceptedData = null,
    videoEl = null
  ) {
    const baseLang = targetLang.split('-')[0].toLowerCase();
    const tracks = tracksInfo?.captionTracks || [];

    // 1. Pistas de YouTube (captionTracks)
    if (tracks.length > 0) {
      const nativeMatch =
        tracks.find((t) => t.languageCode.toLowerCase() === targetLang.toLowerCase()) ||
        tracks.find((t) => t.languageCode.toLowerCase().startsWith(baseLang));

      if (nativeMatch) {
        const urlObj = new URL(nativeMatch.baseUrl);
        urlObj.searchParams.set('fmt', 'json3');
        const rawText = await fetchUrlViaPageOrBg(urlObj.toString());
        const parsed = parseAnySubtitleText(rawText);
        if (parsed.length > 0) {
          return { segments: parsed, sourceTrack: nativeMatch.name, mode: 'native' };
        }
      }

      const preferredTrack = tracks.find((t) => t.kind !== 'asr') || tracks[0];

      // Intentar traducción nativa de YouTube (&tlang=...) si el usuario no forzó traducción con Gemini API
      const stored = await chrome.storage.local.get(['ytDubberSettings']);
      const useGeminiForTrans =
        stored?.ytDubberSettings?.workMode === 'gemini-api' &&
        Boolean(stored?.ytDubberSettings?.geminiApiKey?.trim());

      if (preferredTrack.isTranslatable && !useGeminiForTrans) {
        const tlangUrl = new URL(preferredTrack.baseUrl);
        tlangUrl.searchParams.set('fmt', 'json3');
        tlangUrl.searchParams.set('tlang', baseLang);
        const tlangText = await fetchUrlViaPageOrBg(tlangUrl.toString());
        const tlangParsed = parseAnySubtitleText(tlangText);
        if (tlangParsed.length > 0) {
          return {
            segments: tlangParsed,
            sourceTrack: `${preferredTrack.name} → ${baseLang.toUpperCase()}`,
            mode: 'yt-tlang'
          };
        }
      }

      // Descargar pista base y usar Traducción por Ventana Deslizante (nunca satura con 429 aunque dure 30 horas)
      const origUrl = new URL(preferredTrack.baseUrl);
      origUrl.searchParams.set('fmt', 'json3');
      const origText = await fetchUrlViaPageOrBg(origUrl.toString());
      const origParsed = parseAnySubtitleText(origText);
      if (origParsed.length > 0) {
        const windowedSegments = await prepareWindowedTranslation(origParsed, videoEl, baseLang);
        return {
          segments: windowedSegments,
          sourceTrack: `${preferredTrack.name} → ${baseLang.toUpperCase()}`,
          mode: 'windowed-batch'
        };
      }
    }

    // 2. Pistas HTML5 estándar (<video>.textTracks o <track src="...">)
    if (videoEl) {
      const html5Result = await extractFromHtml5Video(videoEl, targetLang);
      if (html5Result && html5Result.segments?.length > 0) {
        return html5Result;
      }
    }

    // 3. Archivo de subtítulos interceptado por red (.vtt, .srt, timedtext)
    if (interceptedData) {
      if (interceptedData.url && interceptedData.url.includes('/api/timedtext')) {
        try {
          const signedUrl = new URL(interceptedData.url);
          signedUrl.searchParams.set('fmt', 'json3');
          signedUrl.searchParams.set('tlang', baseLang);
          const signedText = await fetchUrlViaPageOrBg(signedUrl.toString());
          const signedParsed = parseAnySubtitleText(signedText);
          if (signedParsed.length > 0) {
            return {
              segments: signedParsed,
              sourceTrack: `Pista interceptada → ${baseLang.toUpperCase()}`,
              mode: 'intercepted-tlang'
            };
          }
        } catch (_) {}
      }

      if (interceptedData.responseText) {
        const rawParsed = parseAnySubtitleText(interceptedData.responseText);
        if (rawParsed.length > 0) {
          const windowedSegments = await prepareWindowedTranslation(rawParsed, videoEl, baseLang);
          return {
            segments: windowedSegments,
            sourceTrack: `Subtítulos interceptados → ${baseLang.toUpperCase()}`,
            mode: 'intercepted-windowed'
          };
        }
      }
    }

    throw new Error('NO_STATIC_SUBTITLES');
  }

  return {
    loadTranslatedSubtitles,
    ensureWindowTranslated,
    parseAnySubtitleText,
    cleanCaptionText
  };
})();
