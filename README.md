# Universal Web & YouTube Live Dubber - Traductor IA

Extensión de navegador (**Manifest V3**) para traducir y doblar al instante cualquier video de **YouTube** o de la **web** (reproductores HTML5, pistas VTT/SRT, subtítulos en el DOM o captura directa de audio mediante IA).

---

## ✨ Características principales

- **Dos modos de operación configurables:**
  1. **Motor TTS (Sin API):** Traducción gratuita con síntesis de voz mediante **Microsoft Edge Neural TTS** (voces naturales por idioma) o la **Web Speech API** nativa del navegador.
  2. **Clave Gemini API (Google AI Studio):** Traducción y transcripción de audio en tiempo real con IA, además de voces nativas de Gemini TTS (`Kore`, `Puck`, `Aoede`, `Charon`, `Fenrir`, `Zephyr`, `Leda`, `Orus`).
- **Soporte universal de video:**
  - En **YouTube**: intercepta pistas de subtítulos y activa la carga automática si es necesario.
  - En **cualquier sitio web**: detecta elementos `<video>` HTML5, pistas `TextTrack` (VTT/SRT), subtítulos renderizados en el DOM y, en modo Gemini API, captura el flujo de audio directamente (`captureStream` / `MediaRecorder`) cuando no existen subtítulos.
- **Control de audio inteligente (Audio Ducking):**
  - Reduce automáticamente el volumen original del video mientras habla la voz doblada (`0%` a `60%`).
  - Ajuste independiente del volumen de la voz traducida (`20%` a `100%`) y velocidad base (`0.85x` a `1.30x`).
- **Subtítulos flotantes opcionales:** Muestra u oculta el subtítulo traducido superpuesto sobre el video.
- **Botón rápido en pantalla (`DUB`):** Permite activar/desactivar el doblaje directamente sobre el reproductor sin abrir el popup.
- **Idiomas soportados:** Español (`es`), Inglés (`en`), Portugués (`pt`), Francés (`fr`), Alemán (`de`) e Italiano (`it`).

---

## 📁 Estructura del proyecto

```text
Plugin_Traslator/
├── manifest.json                 # Configuración de la extensión (Manifest V3)
├── rules.json                    # Reglas declarativeNetRequest para cabeceras de Edge TTS
├── icons/                        # Iconos de la extensión (16, 48 y 128 px)
├── popup/
│   ├── popup.html                # Interfaz de configuración del popup
│   ├── popup.css                 # Estilos del popup
│   └── popup.js                  # Lógica de estado, voces y guardado en chrome.storage
└── src/
    ├── background.js             # Service Worker: Edge Neural TTS, traducción y Gemini API
    ├── content.js                # HUD/botón DUB en página, detección de video y coordinación
    ├── injected.js               # Script en mundo MAIN para interceptar pistas de YouTube/fetch/XHR
    ├── subtitles.js              # Descarga y parseo de subtítulos (VTT/SRT/TimedText)
    ├── tts-engine.js             # Cola de reproducción TTS, sincronización y ducking de audio
    ├── live-audio-capturer.js    # Captura en vivo de TextTrack, DOM y audio del <video>
    └── styles.css                # Estilos del botón DUB y subtítulos flotantes
```

---

## 🚀 Cómo instalar y ejecutar la extensión

Esta extensión no requiere paso de compilación (`build`); se carga directamente como extensión descomprimida en cualquier navegador basado en Chromium (**Google Chrome**, **Microsoft Edge**, **Brave**, etc.).

### 1. Cargar la extensión en el navegador

#### En Google Chrome
1. Abre Chrome y ve a `chrome://extensions/`.
2. Activa el interruptor **Modo de desarrollador** (esquina superior derecha).
3. Haz clic en **Cargar descomprimida** (*Load unpacked*).
4. Selecciona la carpeta raíz del proyecto (`Plugin_Traslator`, donde se encuentra `manifest.json`).

#### En Microsoft Edge
1. Abre Edge y ve a `edge://extensions/`.
2. Activa **Modo de desarrollador** en el panel izquierdo/inferior.
3. Haz clic en **Cargar descomprimida**.
4. Selecciona la carpeta raíz del proyecto (`Plugin_Traslator`).

> **Nota:** Cada vez que modifiques archivos dentro de `src/` o `popup/`, vuelve a `chrome://extensions/` (o `edge://extensions/`) y pulsa el icono de **Recargar** (↻) en la tarjeta de la extensión, y recarga la pestaña del video.

---

## 🎙️ Cómo usarla

1. **Fija la extensión** en la barra de herramientas del navegador para acceder rápido a su icono.
2. Haz clic en el icono de **Universal Live Dubber** para abrir el popup y elige tu configuración:
   - **Modo de Operación:**
     - **Motor TTS (Sin API):** Funciona sin claves. Selecciona el idioma destino, el motor (`Microsoft Edge Neural` o `Web Speech API Nativa`) y la voz deseada. Puedes usar **🔊 Probar voz** antes de empezar.
     - **Usar Clave Gemini API:** Pega tu API Key de [Google AI Studio](https://aistudio.google.com/) (`AIzaSy...`) y elige una de las voces nativas de Gemini. Este modo también habilita la transcripción y traducción directa desde el audio del video si no hay subtítulos disponibles.
   - Ajusta el **volumen original** (ducking), el **volumen del doblaje**, la **velocidad** y si deseas ver los **subtítulos flotantes**.
3. Abre cualquier video en **YouTube** u otro sitio web con reproductor HTML5.
4. Pulsa **Activar** en el popup o haz clic en el botón **DUB** que aparece sobre el video.

---

## 🔧 Permisos utilizados

Definidos en `manifest.json`:
- `storage`: Guardar preferencias de idioma, voz, volumen y clave API.
- `activeTab` y `scripting`: Comunicarse con la pestaña activa y controlar el doblaje.
- `declarativeNetRequest`: Aplicar las reglas definidas en `rules.json` para las peticiones hacia `speech.platform.bing.com` (Edge Neural TTS).
- `host_permissions` (`<all_urls>`): Permitir la detección de videos y subtítulos en cualquier sitio web.
