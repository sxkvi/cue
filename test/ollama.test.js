const test = require('node:test');
const assert = require('node:assert');

const ollama = require('../src/ollama');

// The server is not assumed to exist here; anything that needs one stubs fetch.
function withFetch(handler, run) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve()
    .then(run)
    .finally(() => { global.fetch = original; });
}

const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test('every catalogue entry carries what the interface needs to decide', () => {
  assert.ok(ollama.CATALOGUE.length > 0);
  for (const model of ollama.CATALOGUE) {
    assert.match(model.id, /^[\w.\-]+:[\w.\-]+$/, `${model.id} is not a tagged model reference`);
    assert.ok(model.label, `${model.id} has no label`);
    assert.ok(model.bytes > 0, `${model.id} has no size`);
    // Whether a model can see decides whether two of the four actions work, so
    // it must never be left undefined and quietly read as false.
    assert.strictEqual(typeof model.vision, 'boolean', `${model.id} does not declare vision`);
  }
});

test('keeps the download list small enough to be worth offering in-app', () => {
  for (const model of ollama.CATALOGUE) {
    assert.ok(model.bytes <= 6.5e9, `${model.id} is too large for a first-run download`);
  }
});

test('offers exactly one recommended model, and it can see the screen', () => {
  const recommended = ollama.CATALOGUE.filter((model) => model.recommended);
  assert.strictEqual(recommended.length, 1);
  assert.strictEqual(recommended[0].vision, true);
});

test('normalises the base url so a trailing slash cannot double up', () => {
  assert.strictEqual(ollama.normalizeBase('http://localhost:11434/'), 'http://localhost:11434');
  assert.strictEqual(ollama.normalizeBase('  '), ollama.DEFAULT_BASE_URL);
  assert.strictEqual(ollama.normalizeBase(undefined), ollama.DEFAULT_BASE_URL);
});

test('reports a missing server rather than throwing', () => withFetch(
  async () => { throw new Error('ECONNREFUSED'); },
  async () => {
    assert.deepStrictEqual(await ollama.probe('http://localhost:1'), { running: false });
    const state = await ollama.listModels('http://localhost:1');
    assert.strictEqual(state.running, false);
    assert.deepStrictEqual(state.models, []);
  }
));

test('trusts the server over the catalogue about vision', () => withFetch(
  async () => json({ capabilities: ['completion', 'vision'] }),
  // llama3.2:3b is listed as text-only; a server saying otherwise wins, because
  // a hardcoded table would disable features that actually work.
  async () => assert.strictEqual(await ollama.supportsVision('http://x', 'llama3.2:3b'), true)
));

test('reads vision from the projector family on older servers', () => withFetch(
  async () => json({ details: { families: ['llama', 'clip'] } }),
  async () => assert.strictEqual(await ollama.supportsVision('http://x', 'whatever:1b'), true)
));

test('falls back to the catalogue when the server says nothing useful', () => withFetch(
  async () => json({ details: { families: ['llama'] } }),
  async () => {
    assert.strictEqual(await ollama.supportsVision('http://x', 'qwen2.5vl:3b'), true);
    assert.strictEqual(await ollama.supportsVision('http://x', 'llama3.2:3b'), false);
  }
));

test('treats an unknown model as unable to see', () => withFetch(
  async () => { throw new Error('offline'); },
  // Guessing yes would let Assist fail in front of the user; guessing no only
  // hides a button that can be turned back on.
  async () => assert.strictEqual(await ollama.supportsVision('http://x', 'mystery:9b'), false)
));

test('merges installed models with the catalogue without duplicating them', () => withFetch(
  async (url) => {
    if (String(url).endsWith('/api/version')) return json({ version: '0.32.14' });
    return json({ models: [
      { name: 'qwen2.5vl:3b', size: 3.2e9 },
      { name: 'something-else:7b', size: 4.1e9 }
    ] });
  },
  async () => {
    const state = await ollama.listModels('http://x');
    const ids = state.models.map((model) => model.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'a model appeared twice');

    const known = state.models.find((model) => model.id === 'qwen2.5vl:3b');
    assert.strictEqual(known.installed, true);

    // A model pulled outside the app still belongs in the list, or the UI would
    // tell the user the model they are running is not installed.
    const stranger = state.models.find((model) => model.id === 'something-else:7b');
    assert.ok(stranger);
    assert.strictEqual(stranger.installed, true);
  }
));

test('a model the user never pulled is not reported as installed', () => withFetch(
  async (url) => {
    if (String(url).endsWith('/api/version')) return json({ version: '0.32.14' });
    return json({ models: [] });
  },
  async () => {
    const state = await ollama.listModels('http://x');
    assert.ok(state.models.every((model) => !model.installed));
  }
));

test('warming never becomes something the caller has to handle', () => withFetch(
  async () => { throw new Error('server went away'); },
  // It is an optimisation; a failure must not surface as an error anywhere.
  async () => assert.deepStrictEqual(await ollama.warmModel('http://x', 'any:1b'), { ok: false })
));

test('warming without a model chosen does nothing', async () => {
  assert.deepStrictEqual(await ollama.warmModel('http://x', ''), { ok: false });
});
