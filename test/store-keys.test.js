const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// src/store.js talks to Electron's app and safeStorage. Intercepting the module
// load lets the real store be tested under both a working keychain and a
// machine that has none, which is the case the fallback exists for.
function loadStore({ encryptionAvailable }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-store-'));
  const fakeElectron = {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      // A reversible stand-in for the platform keychain: the test cares that
      // the value on disk is not the value in memory, not about the cipher.
      encryptString: (text) => Buffer.from('enc:' + text, 'utf8'),
      decryptString: (buffer) => {
        const text = Buffer.from(buffer).toString('utf8');
        if (!text.startsWith('enc:')) throw new Error('not decryptable here');
        return text.slice(4);
      }
    }
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...rest);
  };
  const resolved = require.resolve('../src/store');
  delete require.cache[resolved];
  try {
    return { store: require('../src/store'), userData, file: path.join(userData, 'voicegoat-data.json') };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('encrypts api keys on disk and returns them decrypted', () => {
  const { store, file } = loadStore({ encryptionAvailable: true });
  store.setSettings({ apiKeys: { openai: 'sk-super-secret' } });

  const onDisk = readFile(file);
  assert.strictEqual(onDisk.apiKeys.openai, '', 'the plaintext slot must be blanked');
  assert.ok(onDisk.apiKeysEnc.openai, 'an encrypted blob must be written');
  // The raw file must not contain the secret in any form.
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /sk-super-secret/);

  assert.strictEqual(store.getSettings().apiKeys.openai, 'sk-super-secret');
});

test('reports secure storage but never persists that flag', () => {
  const { store, file } = loadStore({ encryptionAvailable: true });
  store.setSettings({ provider: 'anthropic' });
  assert.strictEqual(store.getSettings().secureStorage, true);
  assert.ok(!('secureStorage' in readFile(file)), 'a derived value must not be written');
});

test('a caller cannot write the computed flag back into storage', () => {
  const { store, file } = loadStore({ encryptionAvailable: true });
  // The renderer round-trips the whole settings object, flag included.
  store.setSettings({ secureStorage: false, provider: 'gemini' });
  assert.ok(!('secureStorage' in readFile(file)));
  assert.strictEqual(store.getSettings().secureStorage, true);
});

test('falls back to plain storage and says so when there is no keychain', () => {
  const { store, file } = loadStore({ encryptionAvailable: false });
  store.setSettings({ apiKeys: { openai: 'sk-plain' } });

  const settings = store.getSettings();
  assert.strictEqual(settings.secureStorage, false, 'the UI must be told the promise cannot be kept');
  assert.strictEqual(settings.apiKeys.openai, 'sk-plain');
  assert.strictEqual(readFile(file).apiKeys.openai, 'sk-plain');
});

test('reads a settings file written before keys were encrypted', () => {
  const { store, file } = loadStore({ encryptionAvailable: true });
  fs.writeFileSync(file, JSON.stringify({ provider: 'groq', apiKeys: { groq: 'gsk-legacy' } }));
  assert.strictEqual(store.getSettings().apiKeys.groq, 'gsk-legacy');
});

test('survives a key it cannot decrypt instead of failing to start', () => {
  const { store, file } = loadStore({ encryptionAvailable: true });
  // What a store copied from another machine or user account looks like.
  fs.writeFileSync(file, JSON.stringify({ apiKeysEnc: { openai: Buffer.from('garbage').toString('base64') } }));
  assert.strictEqual(store.getSettings().apiKeys.openai, '');
});

test('keeps the settings file readable only by its owner', () => {
  const { store, file } = loadStore({ encryptionAvailable: false });
  store.setSettings({ provider: 'openai' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('clamps the appearance settings to their usable range', () => {
  const { store } = loadStore({ encryptionAvailable: true });
  let settings = store.setSettings({ textScale: 9, panelOpacity: 0 });
  assert.strictEqual(settings.textScale, 1.3);
  assert.strictEqual(settings.panelOpacity, 0.4);

  settings = store.setSettings({ textScale: 'nonsense', panelOpacity: 'nonsense' });
  assert.strictEqual(settings.textScale, 1);
  assert.strictEqual(settings.panelOpacity, 0.72);
});

test('ships the defaults the redesigned interface depends on', () => {
  const { store } = loadStore({ encryptionAvailable: true });
  const settings = store.getSettings();
  assert.strictEqual(settings.language, 'auto');
  assert.strictEqual(settings.answerLanguage, 'ui');
  assert.strictEqual(settings.sttAutofill, true);
  assert.strictEqual(settings.confirmQuit, true);
  assert.strictEqual(settings.disguiseProcess, true);
  assert.ok(settings.shortcuts.assist, 'every action needs a default accelerator');
  assert.ok(settings.shortcuts.quit);
});

test('defaults to a model on this machine rather than a paid account', () => {
  const { store } = loadStore({ encryptionAvailable: true });
  const settings = store.getSettings();
  assert.strictEqual(settings.provider, 'ollama');
  // Naming a model nobody has pulled yet would 404 on the first question, so
  // the field stays empty until the in-app downloader fills it.
  assert.strictEqual(settings.models.ollama.fast, '');
});
