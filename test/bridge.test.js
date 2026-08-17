const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The preload bridge is the one seam in this app that nothing else checks. It
// is plain property access resolved at runtime, the permissions window uses it
// from inline script inside an HTML file, and a wrong name there fails as a
// silent ReferenceError that kills every button in the window.
//
// That is exactly what happened: a rename swept through permissions.html and
// renamed the calls onto a bridge object that did not exist under that name.
// Node's syntax check cannot see inline HTML script, and no test covered it, so
// the window shipped with every control dead. These tests close that gap.

const ROOT = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

const CONSUMERS = ['renderer/renderer.js', 'renderer/permissions.html'];

function exposedName() {
  const match = /exposeInMainWorld\(\s*'([^']+)'/.exec(preloadSource);
  assert.ok(match, 'preload.js does not expose a bridge');
  return match[1];
}

function exposedMembers() {
  // Everything from the opening of the exposed object to the end of the file is
  // the bridge body; top-level keys are the members the renderer may call.
  const start = preloadSource.indexOf('exposeInMainWorld');
  const body = preloadSource.slice(start);
  const members = new Set();
  // Both `name: value` and the shorthand `name,` are members.
  for (const match of body.matchAll(/^\s{2}(\w+)\s*[:,]/gm)) members.add(match[1]);
  return members;
}

function eventChannels() {
  const match = /const EVENT_CHANNELS = \[([\s\S]*?)\];/.exec(preloadSource);
  assert.ok(match, 'preload.js has no EVENT_CHANNELS allowlist');
  return new Set(Array.from(match[1].matchAll(/'([^']+)'/g), (m) => m[1]));
}

const BRIDGE = exposedName();
const MEMBERS = exposedMembers();
const CHANNELS = eventChannels();

test('the bridge exposes a usable surface', () => {
  assert.ok(MEMBERS.size > 10, `only found ${MEMBERS.size} bridge members`);
  assert.ok(MEMBERS.has('on'), 'the event subscription is missing');
});

for (const file of CONSUMERS) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');

  test(`${file} calls the bridge by the name preload actually exposes`, () => {
    // Any identifier used as `something.method(` that looks like the bridge.
    const suspects = new Set();
    for (const match of source.matchAll(/\b([a-zA-Z_$][\w$]*)\.(\w+)\(/g)) {
      const [, object, member] = match;
      if (MEMBERS.has(member)) suspects.add(object);
    }
    // Built-ins that legitimately share a method name with the bridge — Math.log
    // against the bridge's own log(), for instance.
    const unrelated = new Set([
      'window', 'document', 'console', 'navigator', 'performance',
      'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Date', 'Promise',
      'ipcRenderer', 'contextBridge'
    ]);
    for (const name of suspects) {
      if (unrelated.has(name)) continue;
      assert.strictEqual(
        name, BRIDGE,
        `${file} calls "${name}.…" but preload exposes "${BRIDGE}" — that is a silent ReferenceError at runtime`
      );
    }
  });

  test(`${file} only calls bridge members that exist`, () => {
    const missing = new Set();
    const pattern = new RegExp(`\\b${BRIDGE}\\.(\\w+)`, 'g');
    for (const match of source.matchAll(pattern)) {
      if (!MEMBERS.has(match[1])) missing.add(match[1]);
    }
    assert.deepStrictEqual([...missing], [], `${file} calls bridge members preload does not expose`);
  });

  test(`${file} only subscribes to channels the bridge forwards`, () => {
    // preload returns silently for an unknown channel, so a typo here is an
    // event that simply never arrives, with nothing logged anywhere.
    const unknown = new Set();
    const pattern = new RegExp(`\\b${BRIDGE}\\.on\\(\\s*'([^']+)'`, 'g');
    for (const match of source.matchAll(pattern)) {
      if (!CHANNELS.has(match[1])) unknown.add(match[1]);
    }
    assert.deepStrictEqual([...unknown], [], `${file} listens to channels preload never forwards`);
  });
}

test('no consumer still refers to the pre-rename bridge name', () => {
  for (const file of CONSUMERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /\bcue\.\w+\(/, `${file} still calls the old bridge name`);
  }
});

test('macOS settings links use the pane identifier that still exists', () => {
  // com.apple.preference.security belonged to System Preferences, which Ventura
  // replaced. Links built on it open System Settings without reaching the pane.
  for (const file of CONSUMERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(
      source, /com\.apple\.preference\.security/,
      `${file} links to the retired System Preferences pane`
    );
  }
});
