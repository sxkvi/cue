const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Both files are browser IIFEs that publish onto window. Running them in a VM
// keeps the test honest: it exercises the same files the renderer loads.
function loadRendererGlobals() {
  const context = {
    window: {},
    navigator: { language: 'en-US', languages: ['en-US'] },
    document: { documentElement: {}, querySelectorAll: () => [] }
  };
  vm.createContext(context);
  for (const file of ['locales.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8'), context);
  }
  return context.window;
}

const { CUE_LOCALES, i18n } = loadRendererGlobals();
const LOCALES = Object.keys(CUE_LOCALES);
const BASE = 'en';

function placeholders(value) {
  return new Set(Array.from(String(value).matchAll(/\{(\w+)\}/g), (match) => match[1]));
}

test('ships more than one locale', () => {
  assert.ok(LOCALES.length > 1, 'expected at least two locales');
  assert.ok(LOCALES.includes(BASE));
});

test('every locale has a display name', () => {
  for (const code of LOCALES) {
    assert.ok(CUE_LOCALES[code].name, `${code} is missing a display name`);
  }
});

// Drift between locales is invisible at runtime — a missing key silently falls
// back to English — so it is caught here instead.
for (const code of LOCALES) {
  if (code === BASE) continue;

  test(`${code} translates every ${BASE} key`, () => {
    const missing = Object.keys(CUE_LOCALES[BASE].strings)
      .filter((key) => !(key in CUE_LOCALES[code].strings));
    assert.deepStrictEqual(missing, [], `${code} is missing: ${missing.join(', ')}`);
  });

  test(`${code} has no key that ${BASE} lacks`, () => {
    const extra = Object.keys(CUE_LOCALES[code].strings)
      .filter((key) => !(key in CUE_LOCALES[BASE].strings));
    assert.deepStrictEqual(extra, [], `${code} has stray keys: ${extra.join(', ')}`);
  });

  // A placeholder dropped in translation renders as a sentence with a hole in
  // it; one invented renders as a literal {brace} in the interface.
  test(`${code} keeps the same placeholders`, () => {
    const problems = [];
    for (const [key, value] of Object.entries(CUE_LOCALES[BASE].strings)) {
      const expected = placeholders(value);
      const actual = placeholders(CUE_LOCALES[code].strings[key] || '');
      if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
        problems.push(`${key}: expected {${[...expected]}} got {${[...actual]}}`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  test(`${code} has no blank strings`, () => {
    const blank = Object.entries(CUE_LOCALES[code].strings)
      .filter(([, value]) => !String(value).trim())
      .map(([key]) => key);
    assert.deepStrictEqual(blank, []);
  });
}

test('resolves a regional tag to its base language', () => {
  assert.strictEqual(i18n.init('fr-CA'), 'fr');
  assert.strictEqual(i18n.init('en-GB'), 'en');
});

test('falls back to English for an unsupported language', () => {
  assert.strictEqual(i18n.init('is-IS'), 'en');
});

test('an explicit preference beats the system language', () => {
  assert.strictEqual(i18n.init('fr'), 'fr');
});

test('substitutes placeholders', () => {
  i18n.init('en');
  assert.strictEqual(i18n.t('settings.test.ok', { ms: 412 }), 'Works — answered in 412 ms');
});

test('leaves an unsupplied placeholder untouched rather than printing undefined', () => {
  i18n.init('en');
  assert.match(i18n.t('settings.test.fail', {}), /\{message\}/);
});

test('returns the key itself when it is unknown, so gaps are visible', () => {
  assert.strictEqual(i18n.t('no.such.key'), 'no.such.key');
});

test('reports the available locales for the settings picker', () => {
  // Array.from rehomes the VM realm's array: deepStrictEqual compares
  // prototypes, and an array built inside the sandbox is not the host's Array.
  const codes = Array.from(i18n.available, (entry) => entry.code);
  assert.deepStrictEqual(codes.sort(), LOCALES.slice().sort());
});
