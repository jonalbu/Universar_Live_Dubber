// Lógica del Popup de Configuración - Universal Web & YouTube Live Dubber

const EDGE_NEURAL_VOICES = {
  es: [
    { id: 'es-ES-AlvaroNeural', label: '🇪🇸 Álvaro (España - Masculina Natural)' },
    { id: 'es-ES-ElviraNeural', label: '🇪🇸 Elvira (España - Femenina Natural)' },
    { id: 'es-MX-DaliaNeural', label: '🇲🇽 Dalia (México - Femenina Natural)' },
    { id: 'es-MX-JorgeNeural', label: '🇲🇽 Jorge (México - Masculina Natural)' },
    { id: 'es-CO-GonzaloNeural', label: '🇨🇴 Gonzalo (Colombia - Masculina Natural)' },
    { id: 'es-CO-SalomeNeural', label: '🇨🇴 Salomé (Colombia - Femenina Natural)' },
    { id: 'es-AR-TomasNeural', label: '🇦🇷 Tomás (Argentina - Masculina Natural)' },
    { id: 'es-AR-ElenaNeural', label: '🇦🇷 Elena (Argentina - Femenina Natural)' },
    { id: 'es-US-AlonsoNeural', label: '🇺🇸 Alonso (EE.UU. Neutro - Masculina Natural)' }
  ],
  en: [
    { id: 'en-US-AndrewMultilingualNeural', label: '🇺🇸 Andrew (US - Masculina Ultra Natural)' },
    { id: 'en-US-AvaMultilingualNeural', label: '🇺🇸 Ava (US - Femenina Ultra Natural)' },
    { id: 'en-US-GuyNeural', label: '🇺🇸 Guy (US - Masculina Natural)' },
    { id: 'en-GB-RyanNeural', label: '🇬🇧 Ryan (UK - Masculina Natural)' },
    { id: 'en-GB-SoniaNeural', label: '🇬🇧 Sonia (UK - Femenina Natural)' }
  ],
  pt: [
    { id: 'pt-BR-AntonioNeural', label: '🇧🇷 Antônio (Brasil - Masculina Natural)' },
    { id: 'pt-BR-FranciscaNeural', label: '🇧🇷 Francisca (Brasil - Femenina Natural)' },
    { id: 'pt-PT-DuarteNeural', label: '🇵🇹 Duarte (Portugal - Masculina Natural)' }
  ],
  fr: [
    { id: 'fr-FR-HenriNeural', label: '🇫🇷 Henri (Francia - Masculina Natural)' },
    { id: 'fr-FR-DeniseNeural', label: '🇫🇷 Denise (Francia - Femenina Natural)' }
  ],
  de: [
    { id: 'de-DE-ConradNeural', label: '🇩🇪 Conrad (Alemania - Masculina Natural)' },
    { id: 'de-DE-KatjaNeural', label: '🇩🇪 Katja (Alemania - Femenina Natural)' }
  ],
  it: [
    { id: 'it-IT-DiegoNeural', label: '🇮🇹 Diego (Italia - Masculina Natural)' },
    { id: 'it-IT-ElsaNeural', label: '🇮🇹 Elsa (Italia - Femenina Natural)' }
  ]
};

const SAMPLE_PHRASES = {
  es: 'Hola, esta es una prueba de doblaje inmediato con inteligencia artificial para cualquier video de la web.',
  en: 'Hello, this is a real-time artificial intelligence dubbing test for any web video.',
  pt: 'Olá, este é um teste de dublagem imediata com inteligência artificial para qualquer vídeo da web.',
  fr: 'Bonjour, ceci est un test de doublage instantané par intelligence artificielle pour toute vidéo web.',
  de: 'Hallo, dies ist ein Echtzeit-Synchronisationstest mit künstlicher Intelligenz für jedes Webvideo.',
  it: 'Ciao, questo è un test di doppiaggio istantaneo con intelligenza artificiale per qualsiasi video web.'
};

const DEFAULT_SETTINGS = {
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

let currentSettings = { ...DEFAULT_SETTINGS };
let activeWebTabId = null;
let isTabDubbingActive = false;

const modeTtsOnlyBtn = document.getElementById('modeTtsOnlyBtn');
const modeGeminiBtn = document.getElementById('modeGeminiBtn');
const geminiApiSectionEl = document.getElementById('geminiApiSection');
const browserTtsSectionEl = document.getElementById('browserTtsSection');
const geminiApiKeyEl = document.getElementById('geminiApiKey');
const geminiVoiceSelectEl = document.getElementById('geminiVoiceSelect');
const testGeminiVoiceBtn = document.getElementById('testGeminiVoiceBtn');

const targetLangEl = document.getElementById('targetLang');
const engineSelectEl = document.getElementById('engineSelect');
const edgeVoiceGroupEl = document.getElementById('edgeVoiceGroup');
const edgeVoiceSelectEl = document.getElementById('edgeVoiceSelect');
const nativeVoiceGroupEl = document.getElementById('nativeVoiceGroup');
const nativeVoiceSelectEl = document.getElementById('nativeVoiceSelect');
const duckVolumeEl = document.getElementById('duckVolume');
const duckVolumeValEl = document.getElementById('duckVolumeVal');
const dubVolumeEl = document.getElementById('dubVolume');
const dubVolumeValEl = document.getElementById('dubVolumeVal');
const baseSpeedEl = document.getElementById('baseSpeed');
const baseSpeedValEl = document.getElementById('baseSpeedVal');
const showSubtitlesOverlayEl = document.getElementById('showSubtitlesOverlay');
const toggleDubbingBtn = document.getElementById('toggleDubbingBtn');
const tabStatusBanner = document.getElementById('tabStatusBanner');
const testVoiceBtn = document.getElementById('testVoiceBtn');
const testNativeVoiceBtn = document.getElementById('testNativeVoiceBtn');
const testStatusText = document.getElementById('testStatusText');

function populateEdgeVoices(langCode, selectedVoice) {
  const list = EDGE_NEURAL_VOICES[langCode] || EDGE_NEURAL_VOICES.es;
  edgeVoiceSelectEl.innerHTML = '';
  for (const v of list) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    edgeVoiceSelectEl.appendChild(opt);
  }
  const exists = list.some((v) => v.id === selectedVoice);
  edgeVoiceSelectEl.value = exists ? selectedVoice : list[0].id;
}

function populateNativeVoices(langCode, selectedURI) {
  if (!window.speechSynthesis) return;
  const allVoices = window.speechSynthesis.getVoices();
  if (!allVoices.length) return;

  const baseLang = (langCode || 'es').split('-')[0].toLowerCase();
  const filtered = allVoices.filter((v) => v.lang.toLowerCase().startsWith(baseLang));
  const voicesToShow = filtered.length > 0 ? filtered : allVoices;

  voicesToShow.sort((a, b) => {
    const aNat = /natural|online/i.test(a.name) ? 0 : 1;
    const bNat = /natural|online/i.test(b.name) ? 0 : 1;
    return aNat - bNat;
  });

  nativeVoiceSelectEl.innerHTML = '';
  for (const v of voicesToShow) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    const badge = /natural|online/i.test(v.name) ? '⭐ ' : '';
    opt.textContent = `${badge}${v.name} (${v.lang})`;
    nativeVoiceSelectEl.appendChild(opt);
  }

  if (selectedURI && voicesToShow.some((v) => v.voiceURI === selectedURI)) {
    nativeVoiceSelectEl.value = selectedURI;
  }
}

/**
 * Al elegir "Usar Clave Gemini API" desaparecen las opciones de TTS del navegador
 * y se muestran únicamente la clave API y las voces nativas de IA de Gemini (Kore, Puck, Aoede, Charon, Fenrir...)
 */
function updateModeVisibility(mode) {
  const isGemini = mode === 'gemini-api';
  modeTtsOnlyBtn.classList.toggle('active', !isGemini);
  modeGeminiBtn.classList.toggle('active', isGemini);
  geminiApiSectionEl.classList.toggle('hidden', !isGemini);
  browserTtsSectionEl.classList.toggle('hidden', isGemini);
}

function updateEngineVisibility() {
  const isEdgeNeural = engineSelectEl.value === 'edge-neural';
  edgeVoiceGroupEl.classList.toggle('hidden', !isEdgeNeural);
  nativeVoiceGroupEl.classList.toggle('hidden', isEdgeNeural);
}

function saveSettings() {
  const activeMode = modeGeminiBtn.classList.contains('active') ? 'gemini-api' : 'tts-only';
  currentSettings = {
    workMode: activeMode,
    targetLang: targetLangEl.value,
    engine: engineSelectEl.value,
    edgeVoice: edgeVoiceSelectEl.value,
    geminiVoice: geminiVoiceSelectEl.value || 'Kore',
    nativeVoiceURI: nativeVoiceSelectEl.value || '',
    duckVolume: Number(duckVolumeEl.value) / 100,
    dubVolume: Number(dubVolumeEl.value) / 100,
    baseSpeed: Number(baseSpeedEl.value),
    showSubtitlesOverlay: showSubtitlesOverlayEl.checked,
    geminiApiKey: (geminiApiKeyEl.value || '').trim()
  };

  chrome.storage.local.set({ ytDubberSettings: currentSettings });
}

function updateTabUI(isActive, hasVideo) {
  isTabDubbingActive = Boolean(isActive);
  if (!hasVideo) {
    toggleDubbingBtn.disabled = false;
    toggleDubbingBtn.textContent = 'Activar';
    toggleDubbingBtn.classList.remove('active');
    tabStatusBanner.classList.remove('active');
    tabStatusBanner.innerHTML =
      'Abre cualquier página con un video (YouTube, Vimeo, X, Udemy, HTML5) y pulsa el botón <strong>DUB</strong> sobre el video.';
    return;
  }

  toggleDubbingBtn.disabled = false;
  if (isActive) {
    toggleDubbingBtn.textContent = 'Activo ✓';
    toggleDubbingBtn.classList.add('active');
    tabStatusBanner.classList.add('active');
    tabStatusBanner.innerHTML =
      '🟢 <strong>Doblaje activo</strong> en el video de esta pestaña. Puedes cambiar de modo o voz en tiempo real.';
  } else {
    toggleDubbingBtn.textContent = 'Activar';
    toggleDubbingBtn.classList.remove('active');
    tabStatusBanner.classList.remove('active');
    tabStatusBanner.innerHTML =
      '🎬 Video detectado en esta página. Pulsa <strong>Activar</strong> aquí o el botón <strong>DUB</strong> en el reproductor.';
  }
}

async function checkActiveTabState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      updateTabUI(false, false);
      return;
    }
    activeWebTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, { type: 'GET_TAB_DUBBER_STATE' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        updateTabUI(false, false);
        return;
      }
      updateTabUI(res.isActive, res.hasVideo !== false);
    });
  } catch (_) {
    updateTabUI(false, false);
  }
}

modeTtsOnlyBtn.addEventListener('click', () => {
  updateModeVisibility('tts-only');
  saveSettings();
});

modeGeminiBtn.addEventListener('click', () => {
  updateModeVisibility('gemini-api');
  saveSettings();
});

targetLangEl.addEventListener('change', () => {
  populateEdgeVoices(targetLangEl.value, '');
  populateNativeVoices(targetLangEl.value, '');
  saveSettings();
});

engineSelectEl.addEventListener('change', () => {
  updateEngineVisibility();
  saveSettings();
});

edgeVoiceSelectEl.addEventListener('change', saveSettings);
geminiVoiceSelectEl.addEventListener('change', saveSettings);
nativeVoiceSelectEl.addEventListener('change', saveSettings);

duckVolumeEl.addEventListener('input', () => {
  duckVolumeValEl.textContent = `${duckVolumeEl.value}%`;
  saveSettings();
});

dubVolumeEl.addEventListener('input', () => {
  dubVolumeValEl.textContent = `${dubVolumeEl.value}%`;
  saveSettings();
});

baseSpeedEl.addEventListener('input', () => {
  baseSpeedValEl.textContent = `${Number(baseSpeedEl.value).toFixed(2)}x`;
  saveSettings();
});

geminiApiKeyEl.addEventListener('input', saveSettings);
showSubtitlesOverlayEl.addEventListener('change', saveSettings);

toggleDubbingBtn.addEventListener('click', () => {
  if (!activeWebTabId) return;
  const nextState = !isTabDubbingActive;
  chrome.tabs.sendMessage(
    activeWebTabId,
    { type: 'TOGGLE_DUBBING_FROM_POPUP', payload: { forceState: nextState } },
    (res) => {
      if (!chrome.runtime.lastError && res) {
        updateTabUI(res.isActive, true);
      }
    }
  );
});

// Botón de prueba para las voces nativas de IA de Gemini (Kore, Puck, Aoede, Charon, Fenrir...)
testGeminiVoiceBtn.addEventListener('click', async () => {
  const apiKey = (geminiApiKeyEl.value || '').trim();
  if (!apiKey) {
    testStatusText.textContent = '⚠️ Primero ingresa tu Clave de Gemini API arriba';
    geminiApiKeyEl.focus();
    return;
  }

  const lang = targetLangEl.value || 'es';
  const geminiVoice = geminiVoiceSelectEl.value || 'Kore';
  const phrase = SAMPLE_PHRASES[lang] || SAMPLE_PHRASES.es;

  testStatusText.textContent = `⏳ Generando voz IA de Gemini (${geminiVoice})...`;
  testGeminiVoiceBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SYNTHESIZE_GEMINI_TTS',
      payload: { text: phrase, geminiVoice, apiKey }
    });
    testGeminiVoiceBtn.disabled = false;

    if (!res || !res.ok || !res.audioDataUrl) {
      throw new Error(res?.error || 'No se pudo sintetizar con Gemini');
    }

    const audio = new Audio(res.audioDataUrl);
    audio.volume = Number(dubVolumeEl.value || 100) / 100;
    audio.playbackRate = Number(baseSpeedEl.value || 1.0);
    testStatusText.textContent = `🔊 Reproduciendo voz Gemini: ${geminiVoice}`;
    audio.onended = () => {
      testStatusText.textContent = `✓ Voz Gemini (${geminiVoice}) lista`;
    };
    await audio.play();
  } catch (err) {
    testGeminiVoiceBtn.disabled = false;
    testStatusText.textContent = `⚠️ Error Gemini: ${err.message}`;
  }
});

// Botón de prueba de voz Edge Neural
testVoiceBtn.addEventListener('click', async () => {
  const lang = targetLangEl.value || 'es';
  const voice = edgeVoiceSelectEl.value || 'es-ES-AlvaroNeural';
  const phrase = SAMPLE_PHRASES[lang] || SAMPLE_PHRASES.es;
  const ratePct = Math.round((Number(baseSpeedEl.value || 1) - 1) * 100);

  testStatusText.textContent = '⏳ Generando audio neuronal de prueba...';
  testVoiceBtn.disabled = true;

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SYNTHESIZE_EDGE_TTS',
      payload: { text: phrase, voice, ratePct }
    });
    testVoiceBtn.disabled = false;

    if (!res || !res.ok || !res.audioDataUrl) {
      throw new Error(res?.error || 'No se pudo sintetizar');
    }

    const audio = new Audio(res.audioDataUrl);
    audio.volume = Number(dubVolumeEl.value || 100) / 100;
    testStatusText.textContent = `🔊 Reproduciendo: ${voice}`;
    audio.onended = () => {
      testStatusText.textContent = '✓ Prueba completada con éxito';
    };
    await audio.play();
  } catch (err) {
    testVoiceBtn.disabled = false;
    testStatusText.textContent = `⚠️ Error: ${err.message}`;
  }
});

// Botón de prueba de voz nativa del navegador
testNativeVoiceBtn.addEventListener('click', () => {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const lang = targetLangEl.value || 'es';
  const phrase = SAMPLE_PHRASES[lang] || SAMPLE_PHRASES.es;
  const utter = new SpeechSynthesisUtterance(phrase);
  const voices = window.speechSynthesis.getVoices();
  const chosen = voices.find((v) => v.voiceURI === nativeVoiceSelectEl.value);
  if (chosen) {
    utter.voice = chosen;
    utter.lang = chosen.lang;
  }
  utter.rate = Number(baseSpeedEl.value || 1.0);
  utter.volume = Number(dubVolumeEl.value || 100) / 100;
  window.speechSynthesis.speak(utter);
});

chrome.storage.local.get(['ytDubberSettings'], (res) => {
  if (res && res.ytDubberSettings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...res.ytDubberSettings };
  }

  updateModeVisibility(currentSettings.workMode || 'tts-only');
  targetLangEl.value = currentSettings.targetLang;
  engineSelectEl.value = currentSettings.engine;
  geminiVoiceSelectEl.value = currentSettings.geminiVoice || 'Kore';
  populateEdgeVoices(currentSettings.targetLang, currentSettings.edgeVoice);
  populateNativeVoices(currentSettings.targetLang, currentSettings.nativeVoiceURI);
  updateEngineVisibility();

  const duckPct = Math.round((currentSettings.duckVolume ?? 0.15) * 100);
  duckVolumeEl.value = String(duckPct);
  duckVolumeValEl.textContent = `${duckPct}%`;

  const dubPct = Math.round((currentSettings.dubVolume ?? 1.0) * 100);
  dubVolumeEl.value = String(dubPct);
  dubVolumeValEl.textContent = `${dubPct}%`;

  const speed = Number(currentSettings.baseSpeed ?? 1.0);
  baseSpeedEl.value = String(speed);
  baseSpeedValEl.textContent = `${speed.toFixed(2)}x`;

  geminiApiKeyEl.value = currentSettings.geminiApiKey || '';
  showSubtitlesOverlayEl.checked = currentSettings.showSubtitlesOverlay !== false;

  checkActiveTabState();
});

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    populateNativeVoices(targetLangEl.value, currentSettings.nativeVoiceURI);
  };
}
