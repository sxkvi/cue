const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeCode = require('../src/claude-code');

// The file these tests guard is a screenshot of the user's screen taken mid
// interview. Treating it as ordinary scratch data is how it ends up readable by
// anything else running on the machine.
const PNG = 'data:image/png;base64,' + Buffer.from('not really a png').toString('base64');

test('the scratch directory is readable only by its owner', () => {
  const dir = claudeCode.createScratchDir();
  try {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    claudeCode.removeScratchDir(dir);
  }
});

test('the scratch directory name cannot be predicted', () => {
  const first = claudeCode.createScratchDir();
  const second = claudeCode.createScratchDir();
  try {
    assert.notStrictEqual(first, second);
    // The old implementation derived the path from the process id and the
    // clock, which another process can guess or simply watch for.
    assert.doesNotMatch(path.basename(first), new RegExp(String(process.pid)));
  } finally {
    claudeCode.removeScratchDir(first);
    claudeCode.removeScratchDir(second);
  }
});

test('the screenshot is written owner-read-write only', () => {
  const dir = claudeCode.createScratchDir();
  try {
    const file = claudeCode.writeScreenshot(dir, PNG);
    assert.ok(file);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'not really a png');
  } finally {
    claudeCode.removeScratchDir(dir);
  }
});

test('the screenshot never lands directly in the shared temp directory', () => {
  const dir = claudeCode.createScratchDir();
  try {
    const file = claudeCode.writeScreenshot(dir, PNG);
    assert.strictEqual(path.dirname(file), dir);
    assert.notStrictEqual(path.dirname(file), os.tmpdir());
  } finally {
    claudeCode.removeScratchDir(dir);
  }
});

test('refuses to write over something already at the path', () => {
  const dir = claudeCode.createScratchDir();
  try {
    claudeCode.writeScreenshot(dir, PNG);
    // A second write must fail rather than follow whatever is there now — the
    // shape of a symlink attack, even though mkdtemp already makes it unlikely.
    assert.throws(() => claudeCode.writeScreenshot(dir, PNG), /EEXIST/);
  } finally {
    claudeCode.removeScratchDir(dir);
  }
});

test('a prompt with no image writes nothing at all', () => {
  const dir = claudeCode.createScratchDir();
  try {
    assert.strictEqual(claudeCode.writeScreenshot(dir, ''), null);
    assert.strictEqual(claudeCode.writeScreenshot(dir, 'not-a-data-url'), null);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    claudeCode.removeScratchDir(dir);
  }
});

test('cleanup removes the screenshot along with the directory', () => {
  const dir = claudeCode.createScratchDir();
  const file = claudeCode.writeScreenshot(dir, PNG);
  claudeCode.removeScratchDir(dir);
  assert.strictEqual(fs.existsSync(file), false, 'the screenshot outlived the request');
  assert.strictEqual(fs.existsSync(dir), false);
});

test('cleaning up twice, or cleaning up nothing, is not an error', () => {
  const dir = claudeCode.createScratchDir();
  claudeCode.removeScratchDir(dir);
  assert.doesNotThrow(() => claudeCode.removeScratchDir(dir));
  assert.doesNotThrow(() => claudeCode.removeScratchDir(null));
});

test('reports whether the CLI is present without running it', () => {
  assert.strictEqual(typeof claudeCode.isAvailable(), 'boolean');
  assert.strictEqual(typeof claudeCode.resolveBinary(), 'string');
});
