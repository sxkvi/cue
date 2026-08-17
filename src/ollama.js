// Talking to a local Ollama server: what is installed, what can be pulled, and
// crucially whether a model can see a screenshot.
//
// That last question is not a detail. Two of voicegoat's four headline actions
// — Assist and Solve screen — send an image. Point them at a text-only model
// and they fail with whatever the provider happens to say, which is never
// "this model has no eyes". The capability is resolved up front so the UI can
// disable those actions and explain why, instead of letting them break.

const DEFAULT_BASE_URL = 'http://localhost:11434';

// Small models only. The point of the in-app downloader is to get someone
// running without a 40 GB detour, so nothing here is over about 6 GB, and the
// sizes are the real compressed layer totals from the registry manifests
// rather than the round numbers model cards advertise.
const CATALOGUE = [
  {
    id: 'qwen2.5vl:3b',
    label: 'Qwen2.5-VL 3B',
    bytes: 3.2e9,
    vision: true,
    recommended: true,
    note: 'Smallest model that still reads your screen. Everything works.'
  },
  {
    id: 'granite3.2-vision:2b',
    label: 'Granite Vision 2B',
    bytes: 2.4e9,
    vision: true,
    note: 'Lighter still, tuned for reading documents and screenshots.'
  },
  {
    id: 'moondream:1.8b',
    label: 'Moondream 1.8B',
    bytes: 1.7e9,
    vision: true,
    note: 'The smallest download that can see. Terse, and weaker at long answers.'
  },
  {
    id: 'gemma3:4b',
    label: 'Gemma 3 4B',
    bytes: 3.3e9,
    vision: true,
    note: 'Stronger writing than the 3B models, slightly bigger.'
  },
  {
    id: 'qwen2.5vl:7b',
    label: 'Qwen2.5-VL 7B',
    bytes: 6.0e9,
    vision: true,
    note: 'Best answers of the set. Wants a machine with memory to spare.'
  },
  {
    id: 'llama3.2:3b',
    label: 'Llama 3.2 3B',
    bytes: 2.0e9,
    vision: false,
    note: 'Fast and small, but cannot see your screen.'
  },
  {
    id: 'qwen2.5:3b',
    label: 'Qwen2.5 3B',
    bytes: 1.9e9,
    vision: false,
    note: 'Fast and small, but cannot see your screen.'
  }
];

function catalogueEntry(id) {
  return CATALOGUE.find((model) => model.id === id) || null;
}

function normalizeBase(baseUrl) {
  const raw = String(baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, '');
}

async function request(baseUrl, route, { method = 'GET', body, signal, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(normalizeBase(baseUrl) + route, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Is a server there at all? Answered quickly, because the UI waits on it. */
async function probe(baseUrl) {
  try {
    const response = await request(baseUrl, '/api/version', { timeoutMs: 2500 });
    if (!response.ok) return { running: false };
    const body = await response.json();
    return { running: true, version: body.version || '' };
  } catch (_) {
    return { running: false };
  }
}

/**
 * Whether a model accepts images.
 *
 * Ollama reports this directly on recent versions, and that answer is trusted
 * over the catalogue — a model can gain the capability in a later revision, and
 * a hardcoded table would then be wrong in the direction that disables working
 * features. The catalogue is only the fallback for older servers.
 */
async function supportsVision(baseUrl, model) {
  try {
    const response = await request(baseUrl, '/api/show', { method: 'POST', body: { model } });
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body.capabilities)) return body.capabilities.includes('vision');
      // Older servers describe it through the projector family instead.
      const families = (body.details && body.details.families) || [];
      if (families.some((family) => /clip|mllama|vision/i.test(family))) return true;
      if (body.projector_info || body.projector) return true;
    }
  } catch (_) { /* fall through to what the catalogue claims */ }
  const known = catalogueEntry(model);
  return known ? known.vision : false;
}

/** Installed models, merged with the catalogue so the UI has one list. */
async function listModels(baseUrl) {
  const server = await probe(baseUrl);
  if (!server.running) return { running: false, version: '', models: [] };

  let installed = [];
  try {
    const response = await request(baseUrl, '/api/tags');
    if (response.ok) installed = (await response.json()).models || [];
  } catch (_) { /* an empty list is the right answer for a server with nothing */ }

  const byName = new Map(installed.map((model) => [model.name, model]));
  const models = CATALOGUE.map((entry) => {
    const local = byName.get(entry.id);
    return { ...entry, installed: !!local, installedBytes: local ? local.size : 0 };
  });
  // Anything pulled outside the app still belongs in the list, or the UI would
  // claim a model the user is running is not installed.
  for (const [name, model] of byName) {
    if (models.some((entry) => entry.id === name)) continue;
    models.push({
      id: name,
      label: name,
      bytes: model.size,
      vision: /vl|vision|llava|moondream|gemma3/i.test(name),
      installed: true,
      installedBytes: model.size,
      note: ''
    });
  }
  return { running: true, version: server.version, models };
}

/**
 * Pull a model, reporting progress as it goes.
 *
 * Ollama answers with a stream of JSON objects, one per line, and the byte
 * counters only appear once it starts moving layers — so `total` is absent for
 * the first few messages and the caller has to tolerate that rather than
 * dividing by zero.
 */
async function pullModel(baseUrl, model, { onProgress, signal } = {}) {
  const response = await request(baseUrl, '/api/pull', {
    method: 'POST',
    body: { model, stream: true },
    signal,
    timeoutMs: 24 * 60 * 60 * 1000
  });
  if (!response.ok || !response.body) {
    throw new Error(`Ollama refused the download (${response.status}).`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastError = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      if (event.error) { lastError = event.error; continue; }
      if (onProgress) {
        const total = Number(event.total) || 0;
        const completed = Number(event.completed) || 0;
        onProgress({
          model,
          status: event.status || '',
          completed,
          total,
          percent: total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : null
        });
      }
    }
  }
  if (lastError) throw new Error(lastError);
  return { ok: true, model };
}

/**
 * Load a model into memory ahead of being asked anything.
 *
 * Measured on an M1 Max: the first question after a cold start takes about
 * fifteen seconds, almost all of it spent moving weights into memory, while
 * every question after that answers in roughly a third of a second. Waiting for
 * a real question to pay that cost puts the worst possible delay on the moment
 * the user most needs an answer, so it is paid in advance instead — quietly,
 * and with failures ignored, because this is an optimisation and never a step
 * anything else depends on.
 */
async function warmModel(baseUrl, model, { keepAlive = '30m' } = {}) {
  if (!model) return { ok: false };
  try {
    const response = await request(baseUrl, '/api/generate', {
      method: 'POST',
      body: { model, prompt: '', keep_alive: keepAlive },
      timeoutMs: 120000
    });
    return { ok: response.ok };
  } catch (_) {
    return { ok: false };
  }
}

async function removeModel(baseUrl, model) {
  const response = await request(baseUrl, '/api/delete', { method: 'DELETE', body: { model } });
  if (!response.ok) throw new Error(`Ollama could not remove ${model} (${response.status}).`);
  return { ok: true };
}

// ---- getting a server onto the machine ----------------------------------
// A packaged app has no login shell, so both binaries have to be found by
// looking rather than by trusting PATH.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function findBinary(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    path.join(os.homedir(), '.local', 'bin', name)
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* keep looking */ }
  }
  return null;
}

function isInstalled() {
  return !!findBinary('ollama') || fs.existsSync('/Applications/Ollama.app');
}

/** Start the server and wait until it answers, or give up saying so. */
async function startServer(baseUrl, { timeoutMs = 20000 } = {}) {
  if ((await probe(baseUrl)).running) return { running: true };
  const binary = findBinary('ollama');
  if (!binary) return { running: false, reason: 'not-installed' };

  // Detached, because the server should outlive a restart of the overlay.
  const child = spawn(binary, ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = await probe(baseUrl);
    if (state.running) return state;
  }
  return { running: false, reason: 'timeout' };
}

/**
 * Install Ollama through Homebrew, reporting each line as it happens.
 *
 * Installing system software is not something an overlay should do quietly, so
 * this is only ever reached from a button the user pressed, and every line brew
 * prints is shown rather than hidden behind a spinner. Without Homebrew there
 * is nothing safe to do automatically, and the caller is told to send the user
 * to the download page instead.
 */
function install({ onOutput } = {}) {
  return new Promise((resolve) => {
    const brew = findBinary('brew');
    if (!brew) return resolve({ ok: false, reason: 'no-homebrew' });

    const child = spawn(brew, ['install', 'ollama'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const report = (chunk) => {
      const text = String(chunk).trim();
      if (text && onOutput) onOutput(text);
    };
    child.stdout.on('data', report);
    child.stderr.on('data', report);   // brew reports progress on stderr
    child.on('error', (error) => resolve({ ok: false, reason: 'failed', message: error.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, reason: 'failed', message: `brew exited with ${code}` }));
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  findBinary,
  isInstalled,
  startServer,
  install,
  CATALOGUE,
  catalogueEntry,
  normalizeBase,
  probe,
  listModels,
  supportsVision,
  pullModel,
  warmModel,
  removeModel
};
