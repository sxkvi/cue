// Using the Claude Code CLI as a model backend, so someone with a Claude
// subscription can run voicegoat without a separate API key.
//
// The trade is latency, and it is not small. The CLI has to start a process,
// initialise a session and authenticate before the model is even asked, which
// measures around three seconds to the first token on a warm machine — against
// roughly half a second for a direct API call and less for a local model. For
// an overlay whose whole job is to hand you a sentence while someone waits for
// you to speak, that gap is the difference between useful and too late. The UI
// says so; this file just makes it work as well as it can.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A packaged Electron app does not inherit a login shell's PATH, so the binary
// has to be looked for where installers actually put it.
const CANDIDATE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
];

function resolveBinary() {
  for (const candidate of CANDIDATE_PATHS) {
    try { if (fs.existsSync(candidate) && (fs.statSync(candidate).mode & 0o111)) return candidate; }
    catch (_) { /* keep looking */ }
  }
  // Last resort: let the OS resolve it, which works when a shell PATH is present.
  return 'claude';
}

function isAvailable() {
  return CANDIDATE_PATHS.some((candidate) => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  });
}

function version(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(resolveBinary(), ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(null); }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim() || null); });
  });
}

/**
 * Ask the CLI for one answer, streaming tokens as they arrive.
 *
 * The screenshot is handed over as a file on disk rather than inline: the CLI
 * takes a text prompt, and pointing it at a path is the one way to get an image
 * in front of the model.
 */
async function stream({ system, turns, imageDataUrl, onToken, abortSignal, model }) {
  const scratchFiles = [];
  let imagePath = null;
  if (imageDataUrl) {
    const match = /^data:(.+?);base64,(.*)$/s.exec(imageDataUrl);
    if (match) {
      imagePath = path.join(os.tmpdir(), `voicegoat-screen-${process.pid}-${Date.now()}.png`);
      fs.writeFileSync(imagePath, Buffer.from(match[2], 'base64'));
      scratchFiles.push(imagePath);
    }
  }

  const question = turns.map((turn) => turn.text).join('\n\n');
  const prompt = imagePath
    ? `Read the screenshot at ${imagePath}, then answer.\n\n${question}`
    : question;

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    // The user's own hooks, MCP servers and agents are irrelevant here and each
    // one adds start-up time to a request that is already too slow.
    '--strict-mcp-config',
    '--settings', '{}',
    '--append-system-prompt', system || ''
  ];
  if (model) args.push('--model', model);
  if (imagePath) args.push('--allowed-tools', 'Read');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolveBinary(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: os.tmpdir()   // never let it wander into a project directory
      });
    } catch (error) {
      cleanup();
      return reject(new Error(`Claude Code could not be started: ${error.message}`));
    }

    let full = '';
    let buffer = '';
    let stderr = '';
    let settled = false;

    function cleanup() {
      for (const file of scratchFiles) { try { fs.unlinkSync(file); } catch (_) {} }
    }
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      cleanup();
      fn(value);
    }
    function onAbort() {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(resolve, full);
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdin.end(prompt);
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }

        // Partial deltas are the streaming path; the assistant message is the
        // fallback for a CLI build that does not emit them.
        if (event.type === 'stream_event') {
          const inner = event.event || {};
          if (inner.type === 'content_block_delta' && inner.delta && typeof inner.delta.text === 'string') {
            full += inner.delta.text;
            onToken(inner.delta.text);
          }
          continue;
        }
        if (event.type === 'assistant' && event.message && Array.isArray(event.message.content) && !full) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) { full += block.text; onToken(block.text); }
          }
          continue;
        }
        if (event.type === 'result' && event.is_error) {
          finish(reject, new Error(event.result || 'Claude Code reported an error.'));
          return;
        }
      }
    });

    child.on('error', (error) => {
      finish(reject, new Error(`Claude Code could not be started: ${error.message}. Is the claude command installed?`));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && !full) {
        const detail = stderr.trim().split('\n').slice(-1)[0] || `exit code ${code}`;
        finish(reject, new Error(`Claude Code failed: ${detail}`));
        return;
      }
      finish(resolve, full);
    });
  });
}

module.exports = { isAvailable, version, resolveBinary, stream };
