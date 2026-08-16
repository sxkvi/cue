// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
//
// API keys are the one thing in here that is worth stealing, and the settings
// UI promises they are kept locally. They used to be written as plain text in a
// file any other process could read, which made that promise thinner than it
// sounded. They now go through Electron's safeStorage, which is backed by the
// macOS Keychain, DPAPI on Windows, and libsecret on Linux. Where no secure
// backend exists the keys still have to be stored, so they fall back to plain
// text and `secureStorage: false` is reported to the UI, which says so out loud
// rather than making a promise the platform cannot keep.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;

const KEY_NAMES = ['openai', 'anthropic', 'gemini', 'deepgram', 'custom', 'ollama', 'groq', 'minimax', 'azure'];

// Derived at read time and never written back to disk.
const COMPUTED_FIELDS = ['secureStorage'];

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '', azure: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',

  // ---- interface -------------------------------------------------------
  // 'auto' follows the system language; anything else is a locale code.
  language: 'auto',
  // Which language the model answers in. 'ui' tracks the interface language so
  // a French interface does not hand back English answers by default.
  answerLanguage: 'ui',
  textScale: 1,          // 0.85 – 1.3, multiplies the answer font size
  panelOpacity: 0.72,    // 0.4 – 0.95, how much screen shows through the panel
  reduceMotion: false,
  // Whether the other person's transcribed question is typed into the box for
  // you. Powerful, but it moves text you did not type, so it can be turned off.
  sttAutofill: true,
  confirmQuit: true,
  // cue reports itself to the OS as "Microsoft Edge Update" so it is not
  // obvious in a process list. Users who do not want that can switch it off.
  disguiseProcess: true,
  onboarded: false,

  // Global shortcuts. Registration fails silently when another application
  // already owns a combination, so these are editable rather than baked in —
  // otherwise the only way out of a clash was to quit the other app.
  shortcuts: {
    assist: 'CommandOrControl+Return',
    say: 'CommandOrControl+Shift+Return',
    leetcode: 'CommandOrControl+H',
    hide: 'CommandOrControl+Shift+/',
    quit: 'CommandOrControl+Shift+X'
  },

  // Window position
  windowX: null,
  windowY: null,
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

let data = null;

function canEncrypt() {
  try { return !!safeStorage && safeStorage.isEncryptionAvailable(); }
  catch (_) { return false; }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if (k === 'aiRules' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

/** Turn the on-disk shape into the in-memory shape (keys decrypted). */
function decryptKeys(raw) {
  const encrypted = raw.apiKeysEnc;
  if (!encrypted || typeof encrypted !== 'object') return raw;

  const keys = { ...(raw.apiKeys || {}) };
  if (canEncrypt()) {
    for (const name of KEY_NAMES) {
      const blob = encrypted[name];
      if (!blob) continue;
      try { keys[name] = safeStorage.decryptString(Buffer.from(blob, 'base64')); }
      catch (_) {
        // A key encrypted under a different user, machine or keychain state
        // cannot be recovered. Losing it silently is better than crashing at
        // launch; the UI shows an empty field and the user pastes it again.
        keys[name] = '';
      }
    }
  }
  const out = { ...raw, apiKeys: keys };
  delete out.apiKeysEnc;
  return out;
}

/** Turn the in-memory shape into the on-disk shape (keys encrypted). */
function encryptKeys(settings) {
  const out = { ...settings };
  for (const field of COMPUTED_FIELDS) delete out[field];
  if (!canEncrypt()) return out;

  const encrypted = {};
  const blanked = {};
  for (const name of KEY_NAMES) {
    const value = (settings.apiKeys || {})[name] || '';
    blanked[name] = '';
    if (value) encrypted[name] = safeStorage.encryptString(value).toString('base64');
  }
  out.apiKeys = blanked;
  out.apiKeysEnc = encrypted;
  return out;
}

function load() {
  if (data) return data;
  try { data = deepMerge(DEFAULTS, decryptKeys(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { data = deepMerge(DEFAULTS, {}); }
  return data;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(encryptKeys(data), null, 2), { mode: 0o600 });
    // writeFileSync only applies `mode` when it creates the file, so a store
    // written before this change keeps its old permissions without this.
    fs.chmodSync(FILE, 0o600);
  } catch (e) { /* ignore */ }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  MAX_AI_RULES_CHARS,
  KEY_NAMES,
  isSecureStorageAvailable: canEncrypt,
  getSettings() {
    return { ...load(), secureStorage: canEncrypt() };
  },
  setSettings(patch) {
    load();
    const incoming = { ...(patch || {}) };
    for (const field of COMPUTED_FIELDS) delete incoming[field];

    const nextSettings = deepMerge(data, incoming);
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    nextSettings.textScale = clamp(nextSettings.textScale, 0.85, 1.3, DEFAULTS.textScale);
    nextSettings.panelOpacity = clamp(nextSettings.panelOpacity, 0.4, 0.95, DEFAULTS.panelOpacity);
    data = nextSettings;
    save();
    return { ...data, secureStorage: canEncrypt() };
  }
};
