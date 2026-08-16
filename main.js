const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, hide: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

let permWin = null;
let tray = null;
// The in-flight answer, so it can be cancelled. Before this the only way out of
// a long or wrong answer was to wait for it.
let activeAbort = null;
// What produced the answer currently on screen, so "try again", "shorter" and
// "more detail" have something to work from.
let lastRun = null;      // { mode, userText }
let lastAnswer = '';

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// Status text is picked in the renderer so it can be shown in the user's own
// language. Main sends a key and the values to interpolate into it, never
// English prose — a translated interface reporting untranslated errors was one
// of the more jarring things about the old build.
function sendStatus(key, vars) { send('status', { key, vars: vars || {} }); }

// 'auto' means the system language; 'ui' means whatever the interface is set
// to. Resolving both here keeps the renderer and the prompts in agreement
// about which language an answer should come back in.
function resolveUiLanguage(settings) {
  const preference = settings.language || 'auto';
  const tag = preference === 'auto' ? app.getLocale() : preference;
  return String(tag || 'en').split('-')[0].toLowerCase();
}
function resolveAnswerLanguage(settings) {
  const preference = settings.answerLanguage || 'ui';
  return preference === 'ui' ? resolveUiLanguage(settings) : String(preference).toLowerCase();
}

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        sendStatus('err.local.error', { message: error.message });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  const shouldProtect = !process.env.CUE_NO_PROTECT;
  if (shouldProtect) {
    if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  applyDisguise(store.getSettings()); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    applyDisguise(store.getSettings());
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      sendStatus('err.contentProtection', { build: WIN_BUILD });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; sendStatus('err.nostt'); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushTranscript(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    sendStatus('err.stt.rejected', { provider: err.provider });
  } else {
    sendStatus('err.stt.generic', { provider: err.provider, message: err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          sendStatus('err.stt.fallback', { provider: err.provider });
          startFlushLoop();
        } else if (!sttDisabled) {
          sttDisabled = true;
          sendStatus('err.stt.generic', { provider: err.provider, message: err.message });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        sendStatus('err.local.failed', { message: error.message });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    refreshTray();
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopFlushLoop();
  stopStreamingSTT();
  buffers.you = []; buffers.them = [];
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  refreshTray();
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText, options = {}) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  const abort = new AbortController();
  activeAbort = abort;
  let answer = '';
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        sendStatus(process.platform === 'darwin'
          ? 'err.screen.mac'
          : process.platform === 'win32'
            ? 'err.screen.win'
            : 'err.screen.generic');
      }
    }

    const settingsForPrompt = store.getSettings();
    const contextBlock = buildInterviewContext(settingsForPrompt, mode, transcript);
    const answerLanguage = resolveAnswerLanguage(settingsForPrompt);
    const system = def.buildSystem
      ? def.buildSystem(contextBlock, settingsForPrompt.aiRules || '', answerLanguage)
      : (def.system || '');
    const built = def.build({
      transcript,
      userText: userText || '',
      previousAnswer: options.previousAnswer || ''
    });

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), STREAM_INACTIVITY_MS);
      };
      rearm();
    });
    try {
      await Promise.race([
        llm.stream({
          system,
          turns: [{ role: 'user', text: built }],
          imageDataUrl,
          abortSignal: abort.signal,
          onToken: (t) => {
            if (streamSettled) return;
            rearm();
            answer += t;
            send('llm:token', { text: t });
          }
        }),
        stalled
      ]);
    } finally {
      streamSettled = true;
      clearTimeout(watchdog);
    }
    // Only a real answer is worth keeping: refining an empty or cancelled one
    // would send the model a prompt asking it to rewrite nothing.
    if (!abort.signal.aborted && answer.trim()) {
      lastAnswer = answer;
      if (mode !== 'refine') lastRun = { mode, userText: userText || '' };
    }
    send('llm:done', { stopped: abort.signal.aborted });
  } catch (e) {
    if (abort.signal.aborted) {
      // Cancelling is a normal outcome, not a failure — nothing to report.
      send('llm:done', { stopped: true });
    } else {
      recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
      send('llm:error', { message: e && e.message ? e.message : String(e) });
    }
  } finally {
    streamSettled = true;
    state.busy = false;
    if (activeAbort === abort) activeAbort = null;
  }
}

// -------- menu-bar presence --------
// Without this, a hidden overlay whose show shortcut is owned by another
// application is unreachable: no dock icon, no taskbar entry, nothing to click.
// The tray is the way back in, and the one place quitting is always possible.
const TRAY_STRINGS = {
  en: {
    show: 'Show cue', hide: 'Hide cue',
    listen: 'Start listening', stopListening: 'Stop listening',
    settings: 'Settings…', export: 'Export conversation…',
    guide: 'Open the guide', quit: 'Quit cue'
  },
  fr: {
    show: 'Afficher cue', hide: 'Masquer cue',
    listen: 'Commencer à écouter', stopListening: 'Arrêter d’écouter',
    settings: 'Réglages…', export: 'Exporter la conversation…',
    guide: 'Ouvrir le guide', quit: 'Quitter cue'
  }
};
function trayStrings() {
  return TRAY_STRINGS[resolveUiLanguage(store.getSettings())] || TRAY_STRINGS.en;
}

let panelHidden = false;

function buildTrayMenu() {
  const t = trayStrings();
  return Menu.buildFromTemplate([
    {
      label: panelHidden ? t.show : t.hide,
      click: () => { panelHidden = !panelHidden; send('hide:toggle', { hidden: panelHidden }); refreshTray(); }
    },
    {
      label: state.capturing ? t.stopListening : t.listen,
      click: () => { send('capture:request-toggle', {}); }
    },
    { type: 'separator' },
    { label: t.guide, click: () => send('onboard:show', {}) },
    { label: t.settings, click: () => send('settings:show', {}) },
    { label: t.export, enabled: transcript.length > 0, click: () => exportTranscript() },
    { type: 'separator' },
    { label: t.quit, click: () => requestQuit() }
  ]);
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(state.capturing ? 'cue — ' + trayStrings().stopListening : 'cue');
}

function createTray() {
  if (tray) return;
  const image = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'trayTemplate.png'));
  if (image.isEmpty()) {
    console.log('[cue] tray icon missing — menu-bar entry not created');
    return;
  }
  image.setTemplateImage(true);
  tray = new Tray(image);
  refreshTray();
}

// -------- quitting --------
// Quitting throws away everything cue has heard, and the quit shortcut sits one
// key away from the hide shortcut, so it asks first unless told not to.
function requestQuit() {
  const settings = store.getSettings();
  if (settings.confirmQuit && win && !win.isDestroyed()) {
    send('app:confirm-quit', {});
    return;
  }
  app.quit();
}

// -------- transcript export --------
function transcriptAsMarkdown() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = ['# cue — conversation', '', '_' + stamp + '_', ''];
  for (const turn of transcript) {
    const time = new Date(turn.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    lines.push('**' + (turn.channel === 'them' ? 'Them' : 'You') + '** _(' + time + ')_  ');
    lines.push(turn.text, '');
  }
  return lines.join('\n');
}

async function exportTranscript() {
  if (!transcript.length) return { cancelled: true, empty: true };
  const suggested = 'cue-conversation-' + new Date().toISOString().slice(0, 10) + '.md';
  const result = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : undefined, {
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  try {
    require('fs').writeFileSync(result.filePath, transcriptAsMarkdown(), 'utf8');
    return { cancelled: false, filePath: result.filePath, fileName: path.basename(result.filePath) };
  } catch (error) {
    return { cancelled: false, error: error.message };
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const next = store.setSettings(patch);
  // Shortcuts and the process disguise live in the main process, so a settings
  // write has to be applied here as well as stored.
  if (patch && patch.shortcuts) registerShortcuts();
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'disguiseProcess')) applyDisguise(next);
  refreshTray();
  return next;
});
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION,
  // The renderer picks the interface language from this when the setting is
  // 'auto'; navigator.language inside Electron does not always match the OS.
  systemLocale: app.getLocale(),
  shortcuts: shortcutSnapshot()
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('llm:stop', () => { if (activeAbort) activeAbort.abort(); });
// "Try again", "shorter" and "more detail" used to mean retyping the question.
// The instructions are written in English on purpose: they steer the edit, while
// the system prompt decides which language the answer comes back in.
const REFINE_INSTRUCTIONS = {
  shorter: 'Make it about half as long. Keep only the strongest points and drop everything else.',
  longer: 'Add more detail: concrete specifics, a short example, and the reasoning behind it.'
};
ipcMain.on('llm:refine', (_e, payload) => {
  const kind = payload && payload.kind;
  if (kind === 'retry') {
    if (lastRun) runFeature(lastRun.mode, lastRun.userText);
    return;
  }
  const instruction = REFINE_INSTRUCTIONS[kind];
  if (!instruction || !lastAnswer) return;
  runFeature('refine', instruction, { previousAnswer: lastAnswer });
});

// Answers whether a key actually works, at the moment it is pasted rather than
// at the moment it is needed. Takes the unsaved settings so the user does not
// have to commit a key to find out it is wrong.
ipcMain.handle('provider:test', async (_e, patch) => {
  const base = store.getSettings();
  const incoming = patch || {};
  const merged = {
    ...base,
    ...incoming,
    apiKeys: { ...base.apiKeys, ...(incoming.apiKeys || {}) },
    models: { ...base.models, ...(incoming.models || {}) }
  };
  const llm = createLLM(merged);
  if (!llm.ready) return { ok: false, message: llm.configurationError || 'Provider settings are incomplete.' };
  try { return await llm.probe(); }
  catch (error) { return { ok: false, message: (error && error.message) || String(error) }; }
});

ipcMain.handle('transcript:export', () => exportTranscript());

// Moving a frameless overlay used to need a mouse on one small drag handle.
ipcMain.on('window:nudge', (_e, delta) => {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const step = Number(delta && delta.step) || 24;
  const nextX = Math.round(x + (Number(delta && delta.dx) || 0) * step);
  const nextY = Math.round(y + (Number(delta && delta.dy) || 0) * step);
  // Keep a strip of the window on screen so it can always be dragged back.
  const margin = 80;
  win.setPosition(
    Math.max(workArea.x - w + margin, Math.min(nextX, workArea.x + workArea.width - margin)),
    Math.max(workArea.y, Math.min(nextY, workArea.y + workArea.height - 40))
  );
});

ipcMain.handle('shortcuts:state', () => shortcutSnapshot());
ipcMain.on('app:request-quit', () => requestQuit());
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
// globalShortcut.register returns false when another application already owns a
// combination. That used to be recorded and then ignored, so the only symptom
// was a key that quietly did nothing. The result is now reported to the
// renderer, which says which key is taken, and every combination is stored in
// settings so the user can pick a different one instead of being stuck.
const SHORTCUT_ACTIONS = {
  assist: () => runFeature('assist', ''),
  say: () => runFeature('say', ''),
  leetcode: () => runFeature('leetcode', ''),
  hide: () => { panelHidden = !panelHidden; send('hide:toggle', { hidden: panelHidden }); refreshTray(); },
  quit: () => requestQuit()
};

function currentShortcuts() {
  return { ...store.getSettings().shortcuts };
}

function shortcutSnapshot() {
  return { registered: { ...shortcutState }, combos: currentShortcuts() };
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const combos = currentShortcuts();
  for (const [name, action] of Object.entries(SHORTCUT_ACTIONS)) {
    const accelerator = combos[name];
    shortcutState[name] = false;
    if (!accelerator) continue;
    // An accelerator the user typed can be syntactically invalid, and Electron
    // throws rather than returning false for those.
    try { shortcutState[name] = globalShortcut.register(accelerator, action); }
    catch (_) { shortcutState[name] = false; }
    if (!shortcutState[name]) {
      recordEvent({
        level: 'warn', event: 'shortcut_unavailable',
        msg: 'the ' + name + ' shortcut (' + accelerator + ') could not be registered',
        frame: 'registerShortcuts', context: { shortcut: name, accelerator }
      });
    }
  }
  send('shortcuts:state', shortcutSnapshot());
}

// The disguise is deliberate — cue reports itself as a background updater so it
// is not obvious in a process list — but it also means a user who wants to find
// their own app cannot. It is now a setting rather than a fact of the build.
const DISGUISE_NAME = 'Microsoft Edge Update';
function applyDisguise(settings) {
  const disguised = settings.disguiseProcess !== false;
  app.setName(disguised ? 'MicrosoftEdgeUpdate' : 'cue');
  if (isWindows) process.title = disguised ? 'MicrosoftEdgeUpdate' : 'cue';
  if (win && !win.isDestroyed()) win.setTitle(disguised ? DISGUISE_NAME : 'cue');
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      const request = { video: sources[0] };
      if (isWindows) request.audio = true;
      else request.audio = 'loopback';
      callback(request);
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();
  createTray();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  applyDisguise(store.getSettings());

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
