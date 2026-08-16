/* cue renderer — UI state, audio capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const { renderMarkdown } = window.CUE_MARKDOWN;
  const t = (key, vars) => window.i18n.t(key, vars);
  const cue = window.cue;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const isWindows = cue.platform === 'win32';

  const MOD = isWindows ? 'Ctrl' : '⌘';
  const SHIFT = isWindows ? 'Shift' : '⇧';
  const ALT = isWindows ? 'Alt' : '⌥';
  const ENTER = isWindows ? 'Enter' : '↵';

  // ---- state -------------------------------------------------------------
  let settings = null;
  let platformInfo = { platform: cue.platform, systemLocale: 'en', shortcuts: { registered: {}, combos: {} } };
  let whisperOverview = null;
  let busy = false;
  let capturing = false;

  const MAX_ANSWERS = 12;
  const messages = $('#messages');

  // ======================================================================
  //  Small helpers
  // ======================================================================
  function setIcon(selector, name, size) {
    const el = typeof selector === 'string' ? $(selector) : selector;
    if (el) el.innerHTML = icon(name, { size: size || 16 });
  }

  /** navigator.clipboard needs a secure context, which file:// is not always. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to the older path */ }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.appendChild(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      scratch.remove();
      return ok;
    } catch (_) { return false; }
  }

  let toastTimer = null;
  function showToast(message, ms) {
    const el = $('#toast');
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2000);
  }

  // ======================================================================
  //  Status notes
  //  Main sends a translation key and its values, never English prose, so the
  //  interface and its errors are always in the same language.
  // ======================================================================
  let statusTimer = null;
  function showStatus(message, action) {
    let el = $('#cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      el.className = 'status-note';
      $('#panel').insertBefore(el, $('#action-row'));
    }
    el.textContent = '';
    const text = document.createElement('div');
    text.textContent = message;
    el.appendChild(text);
    if (action) {
      const button = document.createElement('button');
      button.className = 'status-act';
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      el.appendChild(button);
    }
    el.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.hidden = true; }, 12000);
  }

  // ======================================================================
  //  Answers
  // ======================================================================
  let currentGroup = null;
  let currentBody = null;   // the .ai-text being streamed into
  let currentRaw = '';
  let renderQueued = false;

  function paintOverflow() {
    const room = messages.scrollHeight - messages.clientHeight;
    messages.classList.toggle('fade-top', room > 4 && messages.scrollTop > 4);
    messages.classList.toggle('fade-bottom', room > 4 && messages.scrollTop < room - 4);
  }
  messages.addEventListener('scroll', paintOverflow, { passive: true });

  function markPast() {
    const groups = $$('#messages .answer-group');
    groups.forEach((group, index) => group.classList.toggle('past', index !== groups.length - 1));
  }

  function showEmptyState() {
    messages.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = t('empty.title');
    const body = document.createElement('p');
    body.className = 'empty-body';
    body.textContent = t('empty.body', { key: `${MOD}${ENTER}` });
    wrap.append(title, body);
    messages.appendChild(wrap);
  }

  function clearEmptyState() {
    const empty = messages.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  /** Re-render the markdown at most once a frame while tokens arrive, so
   *  formatting appears as it is written instead of snapping in at the end. */
  function scheduleRender() {
    if (renderQueued || !currentBody) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!currentBody) return;
      currentBody.innerHTML = renderMarkdown(currentRaw);
      const caret = document.createElement('span');
      caret.className = 'ai-caret';
      caret.setAttribute('aria-hidden', 'true');
      currentBody.appendChild(caret);
      paintOverflow();
      // Follow the text as it is written, the way a prompter scrolls.
      messages.scrollTop = messages.scrollHeight;
    });
  }

  function startAnswer({ question, small, category }) {
    clearEmptyState();

    const group = document.createElement('article');
    group.className = 'answer-group';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'q-eyebrow';
    const label = document.createElement('span');
    label.textContent = category ? category.toUpperCase() : t('transcript.them');
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    eyebrow.append(label, time);
    group.appendChild(eyebrow);

    if (question) {
      const q = document.createElement('p');
      q.className = 'q-text';
      q.textContent = question;
      group.appendChild(q);
    }

    const body = document.createElement('div');
    body.className = 'ai-text' + (small ? ' small' : '');
    group.appendChild(body);

    messages.appendChild(group);
    while (messages.querySelectorAll('.answer-group').length > MAX_ANSWERS) {
      messages.querySelector('.answer-group').remove();
    }

    currentGroup = group;
    currentBody = body;
    currentRaw = '';
    markPast();
    requestAnimationFrame(() => group.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function appendToken(text) {
    if (!currentBody) startAnswer({ question: null, small: false });
    currentRaw += text;
    scheduleRender();
  }

  function actionButton(iconName, labelKey, run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-action';
    const glyph = document.createElement('span');
    glyph.className = 'ic';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = icon(iconName, { size: 14 });
    const text = document.createElement('span');
    text.textContent = t(labelKey);
    button.append(glyph, text);
    button.addEventListener('click', () => run(button, text, glyph));
    return button;
  }

  function finishAnswer({ stopped } = {}) {
    if (!currentBody) return;
    const body = currentBody;
    const group = currentGroup;
    const raw = currentRaw;
    currentBody = null;
    currentGroup = null;
    currentRaw = '';

    body.innerHTML = renderMarkdown(raw);
    if (stopped) {
      const note = document.createElement('p');
      note.className = 'q-text';
      note.textContent = t('answer.stopped');
      body.appendChild(note);
    }
    if (!raw.trim()) return;

    // Copy is the reason this app exists: the answer is words to say or paste.
    const actions = document.createElement('div');
    actions.className = 'answer-actions';
    actions.append(
      actionButton('copy', 'answer.copy', async (button, text, glyph) => {
        if (!(await copyText(raw))) return;
        button.classList.add('done');
        glyph.innerHTML = icon('check', { size: 14 });
        text.textContent = t('answer.copied');
        setTimeout(() => {
          button.classList.remove('done');
          glyph.innerHTML = icon('copy', { size: 14 });
          text.textContent = t('answer.copy');
        }, 1600);
      }),
      actionButton('refresh-cw', 'answer.regenerate', () => { if (!busy) cue.refineAnswer('retry'); }),
      actionButton('fold', 'answer.shorter', () => { if (!busy) cue.refineAnswer('shorter'); }),
      actionButton('unfold', 'answer.longer', () => { if (!busy) cue.refineAnswer('longer'); })
    );
    group.appendChild(actions);
    // Copy is why this screen exists, so it must not finish its life below the
    // fold of a scroll region nobody realises is scrollable.
    requestAnimationFrame(() => {
      paintOverflow();
      actions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Per-block copy, wired here because the markup is generated as a string.
    group.querySelectorAll('[data-copy-code]').forEach((button) => {
      const label = button.querySelector('.code-copy-label');
      if (label) label.textContent = t('answer.copy.code');
      button.addEventListener('click', async () => {
        const block = button.closest('.code-block');
        if (!block || !(await copyText(block.dataset.code || ''))) return;
        if (label) {
          label.textContent = t('answer.copied');
          setTimeout(() => { label.textContent = t('answer.copy.code'); }, 1600);
        }
      });
    });

    // Anchors would navigate the overlay away from itself.
    group.querySelectorAll('a[data-external]').forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        cue.openPane(anchor.getAttribute('href'));
      });
    });
  }

  function setBusy(value) {
    busy = value;
    $('#send-btn').disabled = value;
    $('#stop-answer-btn').hidden = !value;
    $$('.act').forEach((button) => { button.disabled = value; });
  }

  // ======================================================================
  //  Listening bar — the one indicator
  // ======================================================================
  const listenBar = $('#listen-bar');
  const speaking = { you: false, them: false };

  function paintListenBar() {
    listenBar.classList.toggle('active', capturing);
    listenBar.classList.toggle('idle', capturing && !speaking.you && !speaking.them);
    $('#lb-them').style.width = speaking.them ? '100%' : '0';
    $('#lb-you').style.width = speaking.you ? '100%' : '0';

    let label = t('listen.off');
    if (capturing) {
      if (speaking.them) label = t('transcript.them') + ' — ' + t('listen.speaking');
      else if (speaking.you) label = t('transcript.you') + ' — ' + t('listen.speaking');
      else label = t('listen.on');
    }
    $('#lb-label').textContent = label;
    listenBar.setAttribute('aria-label', label);
  }

  function setListenError() {
    listenBar.classList.add('error');
    $('#lb-label').textContent = t('listen.error');
  }

  // ======================================================================
  //  Auto-fill: the other person's question, typed into the box for you
  //
  //  Powerful and surprising in equal measure — text you did not type appears
  //  and later vanishes on its own. It is now labelled while it is happening,
  //  can be pinned so it stops moving, and can be switched off entirely.
  // ======================================================================
  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  let borrowed = false;      // the box currently holds transcribed speech
  let pinned = false;        // the user pinned it, so nothing may replace it
  let lastBorrowedValue = '';
  let userSpeechStart = null;
  let fillTimer = null;
  let clearTimer = null;

  const history = [];
  const MAX_HISTORY = 10;

  const borrowedTag = document.createElement('span');
  borrowedTag.className = 'borrowed-tag';
  composer.appendChild(borrowedTag);

  function autofillEnabled() { return !settings || settings.sttAutofill !== false; }

  function paintComposerState() {
    composer.classList.toggle('borrowed', borrowed && !pinned);
    composer.classList.toggle('pinned', pinned);
    borrowedTag.textContent = pinned ? t('toast.pinned') : t('transcript.them');
    $('#send-btn').classList.toggle('armed', input.value.trim().length > 0);
    $('#autofill-toggle').setAttribute('aria-pressed', String(autofillEnabled()));
    $('#autofill-toggle').title = autofillEnabled() ? t('listen.autofill.on') : t('listen.autofill.off');
    $('#autofill-toggle').setAttribute('aria-label', $('#autofill-toggle').title);
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  }

  function remember(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 5) return;
    if (history[history.length - 1] === trimmed) return;
    history.push(trimmed);
    while (history.length > MAX_HISTORY) history.shift();
    paintHistoryBadge();
  }

  function paintHistoryBadge() {
    const badge = $('#history-badge');
    badge.hidden = history.length === 0;
    badge.textContent = history.length > 9 ? '9+' : String(history.length);
  }

  function releaseBox() {
    input.value = '';
    borrowed = false;
    pinned = false;
    lastBorrowedValue = '';
    userSpeechStart = null;
    clearTimeout(fillTimer);
    clearTimeout(clearTimer);
    syncPlaceholder();
    paintComposerState();
  }

  function fillFromSpeech(text) {
    if (!autofillEnabled() || pinned) return;
    // Never overwrite something typed by hand.
    if (!borrowed && input.value.trim()) return;

    clearTimeout(clearTimer);
    const next = input.value.trim() ? input.value.trim() + ' ' + text : text;
    input.value = next;
    borrowed = true;
    lastBorrowedValue = next;
    syncPlaceholder();
    paintComposerState();

    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => remember(input.value), 6000);
  }

  /** The user started answering, so the question can go — but not instantly:
   *  a two-word acknowledgement should leave it on screen. */
  function fadeQuestionWhileUserSpeaks() {
    if (!borrowed || pinned) return;
    if (!userSpeechStart) userSpeechStart = Date.now();
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (Date.now() - userSpeechStart > 2000) {
        remember(input.value);
        releaseBox();
      }
    }, 800);
  }

  function restoreLast() {
    const last = history.pop();
    paintHistoryBadge();
    if (!last) { showToast(t('toast.nothingToRestore')); return; }
    input.value = last;
    borrowed = true;
    lastBorrowedValue = last;
    syncPlaceholder();
    paintComposerState();
    showToast(t('toast.restored'));
  }

  input.addEventListener('input', () => {
    // A typo fix should not detach the box from the speech it came from; a
    // rewrite should.
    if (borrowed && lastBorrowedValue) {
      const drift = Math.abs(input.value.length - lastBorrowedValue.length);
      if (!input.value.trim() || drift > lastBorrowedValue.length * 0.3) {
        remember(lastBorrowedValue);
        borrowed = false;
        pinned = false;
        lastBorrowedValue = '';
      }
    }
    syncPlaceholder();
    paintComposerState();
  });
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) { run('assist'); return; }
    const fromSpeech = borrowed;
    remember(text);
    releaseBox();
    run(fromSpeech ? 'answerThis' : 'ask', text);
  }

  function run(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  // ======================================================================
  //  Audio capture
  // ======================================================================
  let audioCtx = null, micStream = null, micWorklet = null;

  function pcmFromFloat(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000 }
      });
      // getUserMedia can hand back a stream with no usable track — a virtual
      // device, or one unplugged between the grant and the capture. Failing
      // loudly here beats the "cue never hears me and says nothing" symptom.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus(t('err.mic.notrack'));
        return;
      }
      cue.log('mic started: ' + (track.label || '(no label — permission may be stale)'));
      audioCtx = new AudioContext({ sampleRate: 16000 });
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => cue.micPcm(e.data);
        source.connect(micWorklet);
      } catch (workletError) {
        cue.log('AudioWorklet unavailable, using ScriptProcessor: ' + workletError.message);
        const node = audioCtx.createMediaStreamSource(micStream);
        const proc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        node.connect(proc); proc.connect(sink); sink.connect(audioCtx.destination);
        proc.onaudioprocess = (e) => cue.micPcm(pcmFromFloat(e.inputBuffer.getChannelData(0)));
        micWorklet = { _legacy: true, proc, node, sink };
      }
    } catch (err) {
      // DOMException.name is the reliable signal; .message wording moves between
      // Chromium versions. Three names mean three different things to do next.
      const name = err && err.name;
      cue.log('mic error: ' + name + ' — ' + (err && err.message));
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') showStatus(t('err.mic.none'));
      else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showStatus(t(isWindows ? 'err.mic.denied.win' : 'err.mic.denied.mac'), {
          label: t('ob.perms.open'),
          run: () => cue.openPane(isWindows
            ? 'ms-settings:privacy-microphone'
            : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
        });
      } else if (name === 'NotReadableError' || name === 'TrackStartError') showStatus(t('err.mic.busy'));
      else showStatus(t('err.mic.generic'));
    }
  }

  function stopMic() {
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else micWorklet.disconnect();
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((track) => track.stop()); micStream = null; }
  }

  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the listen button (a fresh user gesture, which
    // getDisplayMedia requires) and from the capture:state handler. The await
    // means `if (sysStream) return` alone loses the race and can open a second
    // loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    sysStarting = true;
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        showStatus(t('err.sys.unsupported'));
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((track) => track.stop()); // audio is all we want
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        showStatus(t(isWindows ? 'err.sys.notrack.win' : 'err.sys.notrack.mac'));
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => cue.systemPcm(e.data);
        source.connect(sysWorklet);
      } catch (workletError) {
        const node = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const proc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        node.connect(proc); proc.connect(sink); sink.connect(sysCtx.destination);
        proc.onaudioprocess = (e) => cue.systemPcm(pcmFromFloat(e.inputBuffer.getChannelData(0)));
        sysWorklet = { _legacy: true, proc, node, sink };
      }
    } catch (err) {
      cue.log('system audio error: ' + (err && err.message));
      showStatus(t('err.sys.generic'));
    } finally {
      sysStarting = false;
    }
  }

  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else sysWorklet.disconnect();
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((track) => track.stop()); sysStream = null; }
  }

  async function toggleListening() {
    const turningOn = !capturing;
    // Loopback capture needs the user gesture to still be warm, so this runs
    // before the round trip to main rather than after it.
    if (turningOn) { try { await startSystemAudio(); } catch (_) { /* mic still works */ } }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  }

  // ======================================================================
  //  Conversation rail
  // ======================================================================
  const railRows = { you: null, them: null };
  const railTimers = { you: null, them: null };
  const RAIL_GAP_MS = 10000;
  let railInterim = null;

  function railOpen() { return !$('#transcript-rail').classList.contains('hidden'); }

  function toggleRail(force) {
    const open = force === undefined ? !railOpen() : force;
    $('#transcript-rail').classList.toggle('hidden', !open);
    $('#stage').classList.toggle('rail-open', open);
    $('#history-btn').setAttribute('aria-expanded', String(open));
    if (open) {
      const list = $('#ts-list');
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
  }

  function addRailTurn(channel, text, interim) {
    const list = $('#ts-list');
    const empty = list.querySelector('.rail-empty');
    if (empty) empty.remove();

    if (interim) {
      if (!railInterim) {
        railInterim = document.createElement('div');
        railInterim.className = 'ts-turn ts-' + channel;
        const who = document.createElement('span');
        who.className = 'ts-channel';
        who.textContent = t(channel === 'them' ? 'transcript.them' : 'transcript.you');
        const body = document.createElement('span');
        body.className = 'ts-interim';
        railInterim.append(who, body);
        list.appendChild(railInterim);
      }
      railInterim.querySelector('.ts-interim').textContent = text;
      list.scrollTop = list.scrollHeight;
      return;
    }

    if (railInterim) { railInterim.remove(); railInterim = null; }

    // Consecutive fragments from one speaker join one row, so the rail reads as
    // turns rather than as a list of transcription chunks.
    const existing = railRows[channel];
    if (existing && existing.isConnected) {
      const body = existing.querySelector('.ts-text');
      body.textContent = body.textContent ? body.textContent + ' ' + text : text;
    } else {
      const row = document.createElement('div');
      row.className = 'ts-turn ts-' + channel;
      const who = document.createElement('span');
      who.className = 'ts-channel';
      who.textContent = t(channel === 'them' ? 'transcript.them' : 'transcript.you');
      const body = document.createElement('span');
      body.className = 'ts-text';
      body.textContent = text;
      row.append(who, body);
      list.appendChild(row);
      railRows[channel] = row;
    }

    clearTimeout(railTimers[channel]);
    railTimers[channel] = setTimeout(() => { railRows[channel] = null; }, RAIL_GAP_MS);
    const other = channel === 'you' ? 'them' : 'you';
    clearTimeout(railTimers[other]);
    railRows[other] = null;
    list.scrollTop = list.scrollHeight;
  }

  function clearRail() {
    const list = $('#ts-list');
    list.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'rail-empty';
    empty.textContent = t('transcript.empty');
    list.appendChild(empty);
    railInterim = null;
    railRows.you = null; railRows.them = null;
    clearTimeout(railTimers.you); clearTimeout(railTimers.them);
  }

  // ======================================================================
  //  Provider catalogue
  //  Model suggestions are the values this project already ships as defaults,
  //  rather than a hand-written list of model names that goes stale or was
  //  never right. Any name can still be typed.
  // ======================================================================
  const PROVIDERS = {
    openai:    { label: 'OpenAI',    placeholder: 'sk-…',      url: 'https://platform.openai.com/api-keys' },
    anthropic: { label: 'Anthropic', placeholder: 'sk-ant-…',  url: 'https://console.anthropic.com/settings/keys' },
    gemini:    { label: 'Gemini',    placeholder: 'AIza…',     url: 'https://aistudio.google.com/apikey' },
    groq:      { label: 'Groq',      placeholder: 'gsk_…',     url: 'https://console.groq.com/keys' },
    ollama:    { label: 'Ollama',    placeholder: 'http://localhost:11434', url: 'https://ollama.com/download', secret: false },
    minimax:   { label: 'MiniMax',   placeholder: 'MiniMax API key', url: 'https://www.minimax.io/platform' },
    azure:     { label: 'Azure',     placeholder: 'Azure key or Entra token', url: 'https://ai.azure.com/' },
    custom:    { label: 'Custom',    placeholder: 'optional',  url: '', secret: true }
  };

  function providerModels(provider) {
    const models = (settings.models && settings.models[provider]) || {};
    return [models.fast, models.smart].filter(Boolean);
  }

  // ======================================================================
  //  Settings
  // ======================================================================
  const settingsScrim = $('#settings-scrim');
  let keyVisible = false;

  function openSettings(tab) {
    fillSettings();
    settingsScrim.classList.remove('hidden');
    refreshWhisperModels();
    trapFocus($('#settings'));
    if (tab) selectTab(tab);
  }

  async function closeSettings() {
    // Saving can fail — an unusable custom endpoint is rejected by the store.
    // Closing anyway would drop the error and the edit with it.
    if (!(await saveSettings())) return false;
    settingsScrim.classList.add('hidden');
    releaseFocus();
    return true;
  }

  function selectTab(name) {
    $$('.s-tab').forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('on', on);
      tab.setAttribute('aria-selected', String(on));
    });
    $$('.s-pane').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.pane !== name));
    // The strip scrolls, so a tab selected from elsewhere has to bring itself
    // into view or the interface looks like nothing was selected.
    const active = $(`.s-tab[data-tab="${name}"]`);
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function paintProviderPane() {
    const provider = settings.provider;
    const meta = PROVIDERS[provider] || { label: provider, placeholder: '', url: '' };

    $('#active-key-name').textContent = meta.label;
    const keyInput = $('#active-key');
    keyInput.placeholder = meta.placeholder;
    keyInput.type = meta.secret === false || keyVisible ? 'text' : 'password';
    keyInput.value = settings.apiKeys[provider] || '';

    const help = $('#key-help-link');
    help.hidden = !meta.url;
    help.onclick = (event) => { event.preventDefault(); cue.openPane(meta.url); };

    $('#key-storage-note').textContent = settings.secureStorage
      ? t('settings.key.stored')
      : t('settings.key.stored.plain');

    const reveal = $('#key-reveal');
    reveal.hidden = meta.secret === false;
    reveal.innerHTML = icon(keyVisible ? 'eye-off' : 'eye', { size: 14 });
    reveal.setAttribute('aria-pressed', String(keyVisible));
    reveal.title = t(keyVisible ? 'settings.key.hide' : 'settings.key.show');
    reveal.setAttribute('aria-label', reveal.title);

    // Fields only some providers need, built rather than hidden, so the pane is
    // never a stack of empty rows belonging to a provider nobody chose.
    const extra = $('#provider-extra');
    extra.innerHTML = '';
    if (provider === 'custom') {
      extra.appendChild(fieldRow(t('settings.baseurl'), 'base-url', settings.baseUrl || '', 'http://127.0.0.1:18789/v1'));
      extra.appendChild(noteRow(t('settings.baseurl.hint')));
    }
    if (provider === 'azure') {
      extra.appendChild(fieldRow(t('settings.azure.endpoint'), 'azure-endpoint', settings.azureEndpoint || '', 'https://host.cognitiveservices.azure.com'));
      extra.appendChild(noteRow(t('settings.azure.hint')));
    }
    if (provider === 'minimax') {
      const wrap = document.createElement('div');
      wrap.className = 's-seg';
      [['global_en', 'settings.minimax.global'], ['cn_zh', 'settings.minimax.cn']].forEach(([region, key]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = t(key);
        button.classList.toggle('on', (settings.minimaxRegion || 'global_en') === region);
        button.addEventListener('click', () => {
          settings.minimaxRegion = region;
          paintProviderPane();
        });
        wrap.appendChild(button);
      });
      extra.appendChild(wrap);
      extra.appendChild(noteRow(t('settings.minimax.hint')));
    }

    const models = settings.models[provider] || { fast: '', smart: '' };
    $('#model-fast').value = models.fast || '';
    $('#model-smart').value = models.smart || '';
    const suggestions = $('#model-suggestions');
    suggestions.innerHTML = '';
    providerModels(provider).forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      suggestions.appendChild(option);
    });

    // Every key that is not the active provider's, tucked behind a disclosure.
    const others = $('#other-keys');
    others.innerHTML = '';
    others.appendChild(fieldRow('Deepgram', 'key-deepgram', settings.apiKeys.deepgram || '', 'dg-…', true));
    Object.keys(PROVIDERS).forEach((name) => {
      if (name === provider) return;
      const other = PROVIDERS[name];
      others.appendChild(fieldRow(other.label, 'key-' + name, settings.apiKeys[name] || '', other.placeholder, other.secret !== false));
    });

    $('#s-status').textContent = statusLine();
    $('#test-result').textContent = '';
    $('#test-result').className = 's-result';
  }

  function fieldRow(label, id, value, placeholder, secret) {
    const row = document.createElement('div');
    row.className = 's-field';
    const name = document.createElement('span');
    name.className = 's-field-name';
    name.textContent = label;
    const field = document.createElement('input');
    field.id = id;
    field.type = secret ? 'password' : 'text';
    field.value = value;
    field.placeholder = placeholder || '';
    field.autocomplete = 'off';
    field.spellcheck = false;
    row.append(name, field);
    return row;
  }

  function noteRow(text) {
    const note = document.createElement('p');
    note.className = 's-note';
    note.textContent = text;
    return note;
  }

  function statusLine() {
    const keys = settings.apiKeys;
    const stt = (settings.sttProvider || 'auto') === 'auto'
      ? (keys.deepgram ? 'Deepgram' : keys.openai ? 'OpenAI' : keys.groq ? 'Groq' : keys.gemini ? 'Gemini' : '—')
      : settings.sttProvider === 'local' ? t('settings.stt.local') : settings.sttProvider;
    const label = (PROVIDERS[settings.provider] || {}).label || settings.provider;
    return `${label} · ${t('settings.stt')}: ${stt}`;
  }

  function fillSettings() {
    $$('#provider-seg button').forEach((button) => {
      const on = button.dataset.provider === settings.provider;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    });
    paintProviderPane();
    fillAppLinkCallers();

    $$('#stt-provider-seg button').forEach((button) => {
      const on = button.dataset.sttProvider === (settings.sttProvider || 'auto');
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    });
    paintSttNote();
    $('#autofill-setting').checked = autofillEnabled();

    const local = settings.localWhisper || {};
    $('#whisper-language').value = local.language || 'auto';
    $('#whisper-threads').value = Number(local.threads) || 0;

    $('#resume-text').value = settings.resumeText || '';
    $('#job-description').value = settings.jobDescription || '';
    $('#star-stories').value = settings.starStories || '';
    $('#why-company').value = settings.whyCompany || '';
    $('#why-leaving').value = settings.whyLeaving || '';
    $('#work-style').value = settings.workStyle || '';
    $('#ai-rules').value = settings.aiRules || '';
    updateRulesCounter();
    $('#salary-target').value = settings.salaryTarget || '';
    $('#questions-to-ask').value = settings.questionsToAsk || '';

    fillLanguageSelects();
    $('#text-scale').value = settings.textScale || 1;
    $('#panel-opacity').value = settings.panelOpacity || 0.72;
    $('#confirm-quit').checked = settings.confirmQuit !== false;
    $('#reduce-motion').checked = !!settings.reduceMotion;
    $('#disguise-process').checked = settings.disguiseProcess !== false;
    paintShortcuts();
  }

  function paintSttNote() {
    $('#stt-note').textContent = (settings.sttProvider || 'auto') === 'local'
      ? t('settings.stt.local.hint')
      : t('settings.stt.auto.hint');
    $('#whisper-card').classList.toggle('hidden', (settings.sttProvider || 'auto') !== 'local');
  }

  function fillLanguageSelects() {
    const ui = $('#ui-language');
    ui.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = t('settings.language.auto');
    ui.appendChild(auto);

    const answer = $('#answer-language');
    answer.innerHTML = '';
    const sameAsUi = document.createElement('option');
    sameAsUi.value = 'ui';
    sameAsUi.textContent = t('settings.answerLanguage.ui');
    answer.appendChild(sameAsUi);

    window.i18n.available.forEach(({ code, name }) => {
      const a = document.createElement('option');
      a.value = code; a.textContent = name;
      ui.appendChild(a);
      const b = document.createElement('option');
      b.value = code; b.textContent = name;
      answer.appendChild(b);
    });
    ui.value = settings.language || 'auto';
    answer.value = settings.answerLanguage || 'ui';
  }

  const SHORTCUT_LABELS = {
    assist: 'settings.shortcuts.assist',
    say: 'settings.shortcuts.say',
    leetcode: 'settings.shortcuts.leetcode',
    hide: 'settings.shortcuts.hide',
    quit: 'settings.shortcuts.quit'
  };

  /** Turn a keypress into an Electron accelerator. */
  function acceleratorFrom(event) {
    const key = event.key;
    if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return null;
    const parts = [];
    if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    let name = key;
    if (key === 'Enter') name = 'Return';
    else if (key === ' ') name = 'Space';
    else if (key === 'Escape') name = 'Escape';
    else if (key.length === 1) name = key.toUpperCase();
    parts.push(name);
    return parts.length > 1 ? parts.join('+') : null;
  }

  /** Electron accelerators read as machine text; this is the human form.
   *  Escaped because the onboarding step interpolates it into innerHTML and the
   *  value ultimately comes from the settings file. */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function prettyAccelerator(accelerator) {
    if (!accelerator) return '—';
    return accelerator
      .replace('CommandOrControl', MOD)
      .replace('Shift', SHIFT)
      .replace('Alt', ALT)
      .replace('Return', ENTER)
      .split('+').join(isWindows ? '+' : '');
  }

  function paintShortcuts() {
    const host = $('#shortcut-list');
    host.innerHTML = '';
    const state = platformInfo.shortcuts || { registered: {}, combos: {} };
    const combos = { ...state.combos, ...(settings.shortcuts || {}) };

    Object.keys(SHORTCUT_LABELS).forEach((name) => {
      const row = document.createElement('div');
      row.className = 's-shortcut';
      const taken = state.registered[name] === false;
      row.classList.toggle('taken', taken);

      const label = document.createElement('span');
      label.textContent = t(SHORTCUT_LABELS[name]);
      const field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.value = prettyAccelerator(combos[name]);
      field.dataset.accelerator = combos[name] || '';
      // Read-only and captured rather than typed: an accelerator is a key
      // combination, so pressing it is the natural way to enter it.
      field.addEventListener('keydown', (event) => {
        event.preventDefault();
        const accelerator = acceleratorFrom(event);
        if (!accelerator) return;
        field.value = prettyAccelerator(accelerator);
        field.dataset.accelerator = accelerator;
      });
      row.append(label, field);
      host.appendChild(row);

      if (taken) {
        const warn = document.createElement('p');
        warn.className = 's-shortcut-warn';
        warn.textContent = t('settings.shortcuts.taken');
        host.appendChild(warn);
      }
    });
  }

  function updateRulesCounter() {
    const field = $('#ai-rules');
    const counter = $('#ai-rules-count');
    const count = field.value.length;
    counter.textContent = String(count);
    counter.parentElement.classList.toggle('warn', count >= 1900);
  }

  async function saveSettings() {
    const provider = settings.provider;
    settings.apiKeys[provider] = $('#active-key').value.trim();
    if ($('#base-url')) settings.baseUrl = $('#base-url').value.trim();
    if ($('#azure-endpoint')) settings.azureEndpoint = $('#azure-endpoint').value.trim();
    $$('#other-keys input').forEach((field) => {
      const name = field.id.replace(/^key-/, '');
      settings.apiKeys[name] = field.value.trim();
    });

    if (!settings.models[provider]) settings.models[provider] = {};
    settings.models[provider].fast = $('#model-fast').value.trim();
    settings.models[provider].smart = $('#model-smart').value.trim();

    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    settings.sttAutofill = $('#autofill-setting').checked;

    settings.resumeText = $('#resume-text').value.trim();
    settings.jobDescription = $('#job-description').value.trim();
    settings.starStories = $('#star-stories').value.trim();
    settings.whyCompany = $('#why-company').value.trim();
    settings.whyLeaving = $('#why-leaving').value.trim();
    settings.workStyle = $('#work-style').value.trim();
    settings.aiRules = $('#ai-rules').value.trim();
    settings.salaryTarget = $('#salary-target').value.trim();
    settings.questionsToAsk = $('#questions-to-ask').value.trim();

    settings.language = $('#ui-language').value;
    settings.answerLanguage = $('#answer-language').value;
    settings.textScale = Number($('#text-scale').value);
    settings.panelOpacity = Number($('#panel-opacity').value);
    settings.confirmQuit = $('#confirm-quit').checked;
    settings.reduceMotion = $('#reduce-motion').checked;
    settings.disguiseProcess = $('#disguise-process').checked;

    const shortcuts = {};
    $$('#shortcut-list input').forEach((field, index) => {
      shortcuts[Object.keys(SHORTCUT_LABELS)[index]] = field.dataset.accelerator;
    });
    settings.shortcuts = shortcuts;

    try {
      settings = await cue.settingsSet(settings);
      applyPreferences();
      $('#s-status').textContent = statusLine();
      paintPrepStatus();
      paintSmartTooltip();
      paintComposerState();
      return true;
    } catch (error) {
      $('#s-status').textContent = (error && error.message) || String(error);
      return false;
    }
  }

  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '';
      const empty = document.createElement('p');
      empty.className = 's-caller-empty';
      empty.textContent = t('settings.access.empty');
      host.appendChild(empty);
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => t(scope === 'action' ? 'settings.access.control' : 'settings.access.read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : t('settings.access.denied'));
      label.title = id;
      const forget = document.createElement('button');
      forget.className = 's-action';
      forget.type = 'button';
      forget.textContent = t('settings.access.forget');
      forget.addEventListener('click', async () => { await cue.appLinkRevoke(id); fillAppLinkCallers(); });
      row.append(label, forget);
      host.appendChild(row);
    }
  }

  // ---- settings search ----------------------------------------------------
  function runSettingsSearch(query) {
    const needle = query.trim().toLowerCase();
    const empty = $('#s-search-empty');
    if (!needle) {
      $$('.s-group').forEach((group) => group.classList.remove('hidden'));
      $$('.s-pane').forEach((pane) => pane.classList.toggle('hidden', !$(`.s-tab[data-tab="${pane.dataset.pane}"]`).classList.contains('on')));
      $('.s-tabs').classList.remove('hidden');
      empty.classList.add('hidden');
      return;
    }
    // Searching spans every tab at once, so the tab strip stops being the way
    // you navigate and every matching group is shown together.
    $('.s-tabs').classList.add('hidden');
    let hits = 0;
    $$('.s-pane').forEach((pane) => {
      let paneHits = 0;
      pane.querySelectorAll('.s-group').forEach((group) => {
        const haystack = ((group.dataset.search || '') + ' ' + group.textContent).toLowerCase();
        const match = haystack.includes(needle);
        group.classList.toggle('hidden', !match);
        if (match) paneHits++;
      });
      pane.classList.toggle('hidden', paneHits === 0);
      hits += paneHits;
    });
    empty.textContent = t('settings.search.empty', { query });
    empty.classList.toggle('hidden', hits > 0);
  }

  // ======================================================================
  //  Whisper models
  // ======================================================================
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value >= 10 || index < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function selectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function paintWhisperModel() {
    const model = selectedWhisperModel();
    if (!model) return;
    const parts = [
      formatBytes(model.bytes),
      t(model.englishOnly ? 'settings.whisper.english' : 'settings.whisper.multi'),
      model.quantization,
      model.hardwareTier
    ];
    if (model.recommended) parts.push(t('settings.whisper.recommended'));
    if (model.partialBytes > 0 && !model.installed) parts.push(t('settings.whisper.resumable', { size: formatBytes(model.partialBytes) }));
    $('#whisper-model-detail').textContent = parts.join(' · ');

    const percent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    $('#whisper-progress-wrap').classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = percent;
    $('#whisper-progress-label').textContent = `${percent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = t(model.installed
      ? 'settings.whisper.installed'
      : model.partialBytes ? 'settings.whisper.resume' : 'settings.whisper.download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previous = $('#whisper-model').value || (settings.localWhisper && settings.localWhisper.modelId) || 'base.en';
      whisperOverview = await cue.whisperModels();
      const badge = $('#whisper-runtime-status');
      badge.classList.toggle('ready', whisperOverview.runtime.available);
      badge.classList.toggle('error', !whisperOverview.runtime.available);
      badge.textContent = whisperOverview.runtime.available
        ? t('settings.whisper.ready', { version: whisperOverview.runtime.version, target: whisperOverview.runtime.target })
        : t('settings.whisper.missing');
      badge.title = whisperOverview.runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}`
          + (model.recommended ? ` (${t('settings.whisper.recommended')})` : '')
          + (model.installed ? ' ✓' : '');
        select.appendChild(option);
      }
      select.value = whisperOverview.models.some((model) => model.id === previous) ? previous : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available ? '' : whisperOverview.runtime.message;
      paintWhisperModel();
    } catch (error) {
      status.textContent = error.message;
    }
  }

  // ======================================================================
  //  Focus management for dialogs
  // ======================================================================
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let trapped = null;
  let focusBeforeTrap = null;

  function trapFocus(container) {
    focusBeforeTrap = document.activeElement;
    trapped = container;
    const first = container.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function releaseFocus() {
    trapped = null;
    if (focusBeforeTrap && focusBeforeTrap.isConnected) focusBeforeTrap.focus();
    focusBeforeTrap = null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !trapped) return;
    const items = Array.from(trapped.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  // ======================================================================
  //  Preferences applied to the document
  // ======================================================================
  function applyPreferences() {
    document.documentElement.style.setProperty('--scale', String(settings.textScale || 1));
    document.documentElement.style.setProperty('--panel-alpha', String(settings.panelOpacity || 0.72));
    document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
  }

  function paintPrepStatus() {
    const present = {
      resume: !!(settings.resumeText || '').trim(),
      jd: !!(settings.jobDescription || '').trim(),
      stories: !!(settings.starStories || '').trim(),
      salary: !!(settings.salaryTarget || '').trim()
    };
    $$('#prep-status .prep-item').forEach((chip) => {
      const loaded = present[chip.dataset.field];
      chip.classList.toggle('loaded', loaded);
      const name = t(chip.dataset.name);
      chip.title = t(loaded ? 'prep.loaded' : 'prep.missing', { name });
      chip.setAttribute('aria-label', chip.title);
    });
  }

  function paintSmartTooltip() {
    const models = (settings.models && settings.models[settings.provider]) || {};
    const button = $('#smart-toggle');
    button.title = t('composer.smart.tip', { fast: models.fast || '—', smart: models.smart || '—' });
    button.setAttribute('aria-pressed', String(!!settings.smart));
  }

  function paintStaticLabels() {
    setIcon('#logo-btn', 'logo', 17);
    setIcon('#grip-btn', 'grip', 14);
    setIcon('.tb-hide .chev', 'chevron-down', 14);
    setIcon('#stop-btn', 'stop-square', 14);
    setIcon('#quit-btn', 'x', 14);
    setIcon('.act[data-mode="say"] .ic', 'wand-sparkles', 15);
    setIcon('.act[data-mode="assist"] .ic', 'sparkles', 15);
    setIcon('.act[data-mode="followup"] .ic', 'message-circle', 15);
    setIcon('.act[data-mode="recap"] .ic', 'refresh-cw', 15);
    setIcon('#smart-toggle .ic', 'zap', 13);
    setIcon('#autofill-toggle .ic', 'audio-lines', 14);
    setIcon('#history-btn .ic', 'message-square-text', 15);
    setIcon('#more-btn', 'more-horizontal', 17);
    setIcon('#send-btn', 'play', 13);
    setIcon('#stop-answer-btn', 'stop-square', 13);
    setIcon('#close-rail-btn', 'x', 13);
    setIcon('#key-reveal', 'eye', 14);

    $('#hide-btn').title = t('toolbar.hide.tip', { key: prettyAccelerator((settings.shortcuts || {}).hide) });
    $('#quit-btn').title = t('toolbar.quit', { key: prettyAccelerator((settings.shortcuts || {}).quit) });
    $('#quit-btn').setAttribute('aria-label', $('#quit-btn').title);
    $('#more-btn').title = t('composer.settings', { key: MOD + ',' });
    $('#more-btn').setAttribute('aria-label', $('#more-btn').title);
    $('#send-btn').title = t('composer.send.tip', { key: `${MOD}${SHIFT}A` });
    $('#send-btn').setAttribute('aria-label', t('composer.send'));
    $('#grip-btn').title = t(isWindows ? 'toolbar.move.tip.win' : 'toolbar.move.tip');
    paintListenButton();

    $('#say-shortcut-hint').textContent = prettyAccelerator((settings.shortcuts || {}).say);
    $('#assist-shortcut-hint').textContent = prettyAccelerator((settings.shortcuts || {}).assist);

    placeholder.innerHTML = '';
    const ask = document.createElement('span');
    ask.textContent = t('composer.placeholder');
    placeholder.appendChild(ask);
    const hint = document.createElement('span');
    hint.textContent = ' ' + t('composer.placeholder.assist', { keys: `${MOD}${ENTER}` });
    hint.style.color = 'var(--faint)';
    placeholder.appendChild(hint);
  }

  function paintListenButton() {
    const button = $('#stop-btn');
    button.setAttribute('aria-pressed', String(capturing));
    button.title = t(capturing ? 'toolbar.listen.stop' : 'toolbar.listen.start');
    button.setAttribute('aria-label', button.title);
  }

  // ======================================================================
  //  Wiring
  // ======================================================================
  $$('.act').forEach((button) => button.addEventListener('click', () => run(button.dataset.mode)));
  $('#send-btn').addEventListener('click', send);
  $('#stop-answer-btn').addEventListener('click', () => cue.stopAnswer());
  $('#stop-btn').addEventListener('click', toggleListening);
  $('#history-btn').addEventListener('click', () => toggleRail());
  $('#close-rail-btn').addEventListener('click', () => toggleRail(false));
  $('#more-btn').addEventListener('click', () => openSettings());
  $('#logo-btn').addEventListener('click', showOnboard);
  $('#quit-btn').addEventListener('click', () => cue.requestQuit());

  $('#smart-toggle').addEventListener('click', async () => {
    settings.smart = !settings.smart;
    paintSmartTooltip();
    settings = await cue.settingsSet({ smart: settings.smart });
  });

  $('#autofill-toggle').addEventListener('click', async () => {
    const next = !autofillEnabled();
    settings.sttAutofill = next;
    if (!next) releaseBox();
    paintComposerState();
    showToast(t(next ? 'listen.autofill.on' : 'listen.autofill.off'));
    settings = await cue.settingsSet({ sttAutofill: next });
  });

  $$('.prep-item').forEach((chip) => chip.addEventListener('click', () => {
    openSettings(chip.dataset.field === 'salary' ? 'qa' : chip.dataset.field === 'stories' ? 'prep' : 'profile');
  }));

  function toggleHide(force) {
    const collapsed = force === undefined
      ? $('#panel').classList.toggle('collapsed')
      : (($('#panel').classList.toggle('collapsed', force)), force);
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#hide-btn').setAttribute('aria-expanded', String(!collapsed));
    $('.tb-hide-label').textContent = t(collapsed ? 'toolbar.show' : 'toolbar.hide');
    if (collapsed) toggleRail(false);
  }
  $('#hide-btn').addEventListener('click', () => toggleHide());

  input.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !input.value.trim()) {
      event.preventDefault(); restoreLast(); return;
    }
    // Escape clears, but only after it has stopped a running answer.
    if (event.key === 'Escape') {
      if (busy) { event.preventDefault(); cue.stopAnswer(); return; }
      if (input.value.trim()) {
        event.preventDefault();
        remember(input.value);
        releaseBox();
        showToast(t('toast.cleared', { key: `${MOD}Z` }));
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); send(); }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run('assist'); }
    // Pin the borrowed question so the auto-fill stops moving it around.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && borrowed) {
      event.preventDefault();
      pinned = !pinned;
      paintComposerState();
      showToast(t(pinned ? 'toast.pinned' : 'toast.unpinned'));
    }
  });

  // ---- settings wiring ----------------------------------------------------
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  settingsScrim.addEventListener('click', (event) => { if (event.target === settingsScrim) void closeSettings(); });
  $$('.s-tab').forEach((tab) => tab.addEventListener('click', async () => {
    if (tab.classList.contains('on')) return;
    if (!(await saveSettings())) return;
    selectTab(tab.dataset.tab);
  }));
  $$('#provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.apiKeys[settings.provider] = $('#active-key').value.trim();
    settings.provider = button.dataset.provider;
    keyVisible = false;
    $$('#provider-seg button').forEach((other) => {
      other.classList.toggle('on', other === button);
      other.setAttribute('aria-checked', String(other === button));
    });
    paintProviderPane();
  }));
  $('#key-reveal').addEventListener('click', () => { keyVisible = !keyVisible; paintProviderPane(); });
  $$('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    $$('#stt-provider-seg button').forEach((other) => {
      other.classList.toggle('on', other === button);
      other.setAttribute('aria-checked', String(other === button));
    });
    paintSttNote();
    $('#s-status').textContent = statusLine();
  }));
  $('#ai-rules').addEventListener('input', updateRulesCounter);
  $('#settings-search').addEventListener('input', (event) => runSettingsSearch(event.target.value));
  // Live preview: reading these back from a saved value would mean committing
  // before you can see what you chose.
  $('#text-scale').addEventListener('input', (event) => document.documentElement.style.setProperty('--scale', event.target.value));
  $('#panel-opacity').addEventListener('input', (event) => document.documentElement.style.setProperty('--panel-alpha', event.target.value));
  $('#reduce-motion').addEventListener('change', (event) => document.body.classList.toggle('reduce-motion', event.target.checked));
  $('#ui-language').addEventListener('change', (event) => {
    window.i18n.set(event.target.value);
    paintStaticLabels();
    fillSettings();
  });

  $('#test-provider').addEventListener('click', async () => {
    const result = $('#test-result');
    const button = $('#test-provider');
    button.disabled = true;
    result.className = 's-result';
    result.textContent = t('settings.test.running');
    // Tested against what is on screen, not what is stored, so a key can be
    // checked before it is committed.
    const draft = {
      provider: settings.provider,
      apiKeys: { [settings.provider]: $('#active-key').value.trim() },
      models: { [settings.provider]: { fast: $('#model-fast').value.trim(), smart: $('#model-smart').value.trim() } },
      baseUrl: $('#base-url') ? $('#base-url').value.trim() : settings.baseUrl,
      azureEndpoint: $('#azure-endpoint') ? $('#azure-endpoint').value.trim() : settings.azureEndpoint,
      minimaxRegion: settings.minimaxRegion,
      smart: false
    };
    try {
      const outcome = await cue.testProvider(draft);
      if (outcome && outcome.ok) {
        result.className = 's-result ok';
        result.textContent = t('settings.test.ok', { ms: outcome.ms });
      } else {
        result.className = 's-result fail';
        result.textContent = t('settings.test.fail', { message: (outcome && outcome.message) || '' });
      }
    } catch (error) {
      result.className = 's-result fail';
      result.textContent = t('settings.test.fail', { message: error.message });
    } finally {
      button.disabled = false;
    }
  });

  $('#upload-resume-btn').addEventListener('click', () => importDocument('#resume-text', '#resume-filename'));
  $('#upload-jd-btn').addEventListener('click', () => importDocument('#job-description', '#jd-filename'));
  async function importDocument(target, nameTarget) {
    const result = await cue.pickProfileDocument();
    if (!result || result.canceled) return;
    if (result.error) { $('#s-status').textContent = t('settings.importFailed', { message: result.error }); return; }
    $(target).value = result.text || '';
    $(nameTarget).textContent = result.fileName;
    $('#s-status').textContent = t('settings.imported', { file: result.fileName });
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    paintWhisperModel();
  });
  $('#whisper-download').addEventListener('click', async () => {
    const model = selectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    paintWhisperModel();
    try { await cue.whisperModelDownload(model.id); }
    catch (error) { $('#whisper-status').textContent = error.message; }
    finally { await refreshWhisperModels(); }
  });
  $('#whisper-cancel').addEventListener('click', async () => {
    const model = selectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });
  $('#whisper-import').addEventListener('click', async () => {
    const model = selectedWhisperModel();
    if (!model) return;
    try { await cue.whisperModelImport(model.id); }
    catch (error) { $('#whisper-status').textContent = error.message; }
    finally { await refreshWhisperModels(); }
  });
  $('#whisper-delete').addEventListener('click', async () => {
    const model = selectedWhisperModel();
    if (!model) return;
    const question = t('settings.whisper.deleteConfirm', { model: model.id, size: formatBytes(model.bytes) });
    if (!window.confirm(question)) return;
    try { await cue.whisperModelDelete(model.id); }
    catch (error) { $('#whisper-status').textContent = error.message; }
    finally { await refreshWhisperModels(); }
  });

  $('#export-transcript-btn').addEventListener('click', async () => {
    const result = await cue.exportTranscript();
    if (!result || result.cancelled) return;
    if (result.error) { showToast(result.error, 3000); return; }
    showToast(t('transcript.exported', { file: result.fileName }), 3000);
  });

  $('#clear-transcript-btn').addEventListener('click', async () => {
    remember(input.value);
    await cue.clearTranscript();
    clearRail();
    releaseBox();
    showEmptyState();
    showToast(t('transcript.cleared', { key: `${MOD}Z` }), 3000);
  });

  // ---- quit dialog --------------------------------------------------------
  const quitScrim = $('#quit-scrim');
  function showQuitDialog() {
    quitScrim.classList.remove('hidden');
    setIgnore(false);
    trapFocus($('#quit-dialog'));
  }
  function hideQuitDialog() { quitScrim.classList.add('hidden'); releaseFocus(); }
  $('#quit-cancel').addEventListener('click', hideQuitDialog);
  $('#quit-confirm').addEventListener('click', () => cue.quit());
  $('#quit-export').addEventListener('click', async () => {
    const result = await cue.exportTranscript();
    if (result && result.cancelled) return;   // a cancelled save must not quit
    cue.quit();
  });
  quitScrim.addEventListener('click', (event) => { if (event.target === quitScrim) hideQuitDialog(); });

  // ---- consent ------------------------------------------------------------
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;
  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
    releaseFocus();
  }
  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, Escape and clicking away
  // included.
  consentScrim.addEventListener('click', (event) => { if (event.target === consentScrim) answerConsent(false); });

  // ---- global keys --------------------------------------------------------
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (pendingConsentId) { event.preventDefault(); answerConsent(false); return; }
      if (!quitScrim.classList.contains('hidden')) { event.preventDefault(); hideQuitDialog(); return; }
      if (!$('#onboard-scrim').classList.contains('hidden')) { event.preventDefault(); finishOnboard(); return; }
      if (!settingsScrim.classList.contains('hidden')) { event.preventDefault(); void closeSettings(); return; }
      if (railOpen()) { event.preventDefault(); toggleRail(false); return; }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings(); return; }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (input.value.trim()) send(); else showToast(t('toast.noQuestion'));
      return;
    }
    // Moving the window without a mouse. The overlay has no title bar, so
    // without this the only way to reposition it is to drag the grip.
    if (event.altKey && event.key.startsWith('Arrow')) {
      const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = deltas[event.key];
      if (delta) {
        event.preventDefault();
        cue.nudgeWindow(delta[0], delta[1], event.shiftKey ? 96 : 24);
      }
    }
  });

  // ---- click-through ------------------------------------------------------
  // Only real UI blocks the mouse; the gaps pass clicks to whatever is behind.
  const UI_SELECTOR = '#toolbar, #panel-wrap, #transcript-rail, .scrim, #toast';
  let ignoring = null;
  function setIgnore(value) {
    if (value === ignoring) return;
    ignoring = value;
    cue.setIgnoreMouse(value);
  }
  // Throttled to one test per frame: this used to run elementFromPoint on every
  // mousemove event, which is a layout read per event.
  let pendingPoint = null;
  document.addEventListener('mousemove', (event) => {
    const first = pendingPoint === null;
    pendingPoint = { x: event.clientX, y: event.clientY };
    if (!first) return;
    requestAnimationFrame(() => {
      const point = pendingPoint;
      pendingPoint = null;
      if (!point) return;
      const element = document.elementFromPoint(point.x, point.y);
      setIgnore(!(element && element.closest && element.closest(UI_SELECTOR)));
    });
  });
  setIgnore(true);

  // ======================================================================
  //  Onboarding — reactive, so nobody is told to do something and then left
  //  to guess whether it worked.
  // ======================================================================
  const obScrim = $('#onboard-scrim');
  let obIndex = 0;
  let permissionPoll = null;

  function permissionStep() {
    const winTen = isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000;
    return {
      icon: 'eye',
      title: t('ob.perms.title'),
      body: t(isWindows ? (winTen ? 'ob.perms.body.win10' : 'ob.perms.body.win') : 'ob.perms.body.mac'),
      checks: [
        {
          id: 'mic',
          name: t('ob.perms.mic'),
          why: t('ob.perms.mic.why'),
          open: () => cue.openPane(isWindows ? 'ms-settings:privacy-microphone' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
        },
        !winTen && {
          id: 'screen',
          name: t('ob.perms.screen'),
          why: t('ob.perms.screen.why'),
          open: () => cue.openPane(isWindows ? 'ms-settings:privacy-screenrecorder' : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
        }
      ].filter(Boolean)
    };
  }

  function steps() {
    return [
      { icon: 'logo', title: t('ob.welcome.title'), body: t('ob.welcome.body') },
      permissionStep(),
      {
        icon: 'zap',
        title: t('ob.key.title'),
        body: t('ob.key.body'),
        checks: [{ id: 'key', name: t('ob.key.paste'), why: '', open: () => { finishOnboard(); openSettings('keys'); }, openLabel: t('ob.key.open') }],
        buttons: [{ label: t('ob.key.open'), run: () => { finishOnboard(); openSettings('keys'); } }]
      },
      { icon: 'eye-off', title: t('ob.zoom.title'), body: t('ob.zoom.body') },
      {
        icon: 'sparkles',
        title: t('ob.done.title'),
        body: t('ob.done.body') + '<ul>'
          + `<li><span class="keycap">${escapeHtml(MOD + ENTER)}</span> — ${t('ob.done.assist')}</li>`
          + `<li><span class="keycap">${escapeHtml(prettyAccelerator((settings.shortcuts || {}).leetcode))}</span> — ${t('ob.done.solve')}</li>`
          + `<li>${t('ob.done.listen')}</li>`
          + `<li>${t('ob.done.ask', { enter: `<span class="keycap">${escapeHtml(ENTER)}</span>` })}</li>`
          + '</ul><p>' + t('ob.done.footer', { quit: `<span class="keycap">${escapeHtml(prettyAccelerator((settings.shortcuts || {}).quit))}</span>` }) + '</p>'
      }
    ];
  }

  async function paintChecks(step) {
    const host = $('#ob-checks');
    host.innerHTML = '';
    if (!step.checks) return;

    let permissions = { mic: 'granted', screen: 'granted' };
    try { permissions = await cue.permissionsCheck(); } catch (_) { /* non-mac reports granted */ }
    const hasKey = !!(settings.apiKeys && settings.apiKeys[settings.provider]);

    for (const check of step.checks) {
      const done = check.id === 'key' ? hasKey : permissions[check.id] === 'granted';
      const row = document.createElement('div');
      row.className = 'ob-check' + (done ? ' done' : '');

      const glyph = document.createElement('span');
      glyph.className = 'ic';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icon(done ? 'check' : 'external-link', { size: 15 });

      const text = document.createElement('div');
      text.className = 'ob-check-text';
      const name = document.createElement('div');
      name.className = 'ob-check-name';
      name.textContent = check.name;
      const state = document.createElement('div');
      state.className = 'ob-check-state';
      state.textContent = done
        ? t(check.id === 'key' ? 'ob.key.ok' : 'ob.perms.granted')
        : (check.id === 'key' ? t('ob.key.none') : t('ob.perms.pending'));
      text.append(name, state);
      if (check.why) {
        const why = document.createElement('div');
        why.className = 'ob-check-why';
        why.textContent = check.why;
        text.insertBefore(why, state);
      }

      row.append(glyph, text);
      if (!done) {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = check.openLabel || t('ob.perms.open');
        open.addEventListener('click', check.open);
        row.appendChild(open);
      }
      host.appendChild(row);
    }
  }

  function renderOnboard() {
    const list = steps();
    const step = list[obIndex];
    $('#ob-icon').innerHTML = icon(step.icon, { size: 26 });
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    paintChecks(step);

    const buttons = $('#ob-buttons');
    buttons.innerHTML = '';
    (step.buttons || []).forEach((definition) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = definition.label;
      button.addEventListener('click', definition.run);
      buttons.appendChild(button);
    });

    const dots = $('#ob-dots');
    dots.innerHTML = '';
    list.forEach((_, index) => {
      const dot = document.createElement('span');
      if (index === obIndex) dot.className = 'on';
      dots.appendChild(dot);
    });

    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = t(obIndex === list.length - 1 ? 'ob.done' : 'ob.next');
    $('#ob-skip').style.visibility = obIndex === list.length - 1 ? 'hidden' : 'visible';

    // The user leaves for System Settings and comes back; without a poll the
    // panel would still claim nothing has been allowed.
    clearInterval(permissionPoll);
    if (step.checks) permissionPoll = setInterval(() => paintChecks(step), 1500);
  }

  function showOnboard() {
    obIndex = 0;
    renderOnboard();
    obScrim.classList.remove('hidden');
    setIgnore(false);
    trapFocus($('#onboard'));
  }

  async function finishOnboard() {
    clearInterval(permissionPoll);
    obScrim.classList.add('hidden');
    releaseFocus();
    if (settings && !settings.onboarded) {
      settings.onboarded = true;
      settings = await cue.settingsSet({ onboarded: true });
    }
  }

  $('#ob-next').addEventListener('click', () => {
    if (obIndex === steps().length - 1) finishOnboard();
    else { obIndex++; renderOnboard(); }
  });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);

  // ======================================================================
  //  Events from main
  // ======================================================================
  cue.on('capture:state', ({ active, mode }) => {
    capturing = active;
    paintListenButton();
    listenBar.classList.remove('error');
    $('#history-btn').classList.toggle('listening', active);
    if (active) startMic();
    else { stopMic(); stopSystemAudio(); speaking.you = false; speaking.them = false; }
    paintListenBar();
    if (active && mode === 'local') $('#lb-label').textContent = t('listen.on.local');
  });
  cue.on('capture:request-toggle', () => { void toggleListening(); });

  cue.on('vad:state', ({ channel, speaking: isSpeaking }) => {
    speaking[channel] = !!isSpeaking;
    paintListenBar();
  });
  cue.on('stt:interim', ({ channel, text }) => addRailTurn(channel, text, true));
  cue.on('stt:final', () => { if (railInterim) { railInterim.remove(); railInterim = null; } });
  cue.on('stt:status', ({ status, provider }) => {
    cue.log(`[stt] ${provider || ''} ${status}`);
    if (status === 'error') setListenError();
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    addRailTurn(channel, text, false);
    if (channel === 'them') { clearTimeout(clearTimer); userSpeechStart = null; fillFromSpeech(text); }
    else fadeQuestionWhileUserSpeaks();
  });

  cue.on('llm:start', ({ userBubble, small, category }) => {
    startAnswer({ question: userBubble, small, category });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', (payload) => { finishAnswer(payload || {}); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!currentBody) startAnswer({ question: null, small: true });
    currentRaw = message;
    finishAnswer({});
    setBusy(false);
  });

  cue.on('status', (payload) => {
    // Main sends keys; the older shape carried English text.
    const message = payload && payload.key ? t(payload.key, payload.vars) : (payload && payload.message) || '';
    if (!message) return;
    cue.log('[status] ' + message);
    const needsKey = payload && (payload.key === 'err.nokey' || payload.key === 'err.nostt');
    showStatus(message, needsKey ? { label: t('empty.settings'), run: () => openSettings('keys') } : null);
  });

  cue.on('hide:toggle', (payload) => toggleHide(payload && typeof payload.hidden === 'boolean' ? payload.hidden : undefined));
  cue.on('settings:show', () => openSettings());
  cue.on('onboard:show', showOnboard);
  cue.on('app:confirm-quit', showQuitDialog);
  cue.on('shortcuts:state', (state) => {
    platformInfo.shortcuts = state;
    if (!settingsScrim.classList.contains('hidden')) paintShortcuts();
    paintStaticLabels();
  });

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // The pointer may already be still, and the sheet would be unclickable
    // until it moved.
    setIgnore(false);
    trapFocus($('#consent'));
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  // ======================================================================
  //  Boot
  // ======================================================================
  (async function boot() {
    settings = await cue.settingsGet();
    platformInfo = await cue.platformInfo();

    // The system locale comes from the main process: navigator.language inside
    // Electron does not always match what the OS is set to.
    window.i18n.init(settings.language === 'auto' || !settings.language
      ? platformInfo.systemLocale
      : settings.language);

    applyPreferences();
    paintStaticLabels();
    paintPrepStatus();
    paintSmartTooltip();
    paintComposerState();
    paintHistoryBadge();
    clearRail();
    showEmptyState();
    syncPlaceholder();
    paintListenBar();

    const state = await cue.captureState();
    capturing = !!state.active;
    paintListenButton();
    paintListenBar();

    if (!settings.onboarded) showOnboard();
  })();
})();
