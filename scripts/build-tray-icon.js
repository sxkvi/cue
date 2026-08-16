#!/usr/bin/env node
// Generates the menu-bar / tray icon as macOS template images into src/assets,
// which is inside the packager's file allowlist so the icon ships with the app.
//
// Run with `node scripts/build-tray-icon.js`. The output is committed, so a
// normal build never needs to run this — it exists so the icon can be changed
// by editing shapes here rather than by round-tripping through a design tool.
//
// A template image is black-on-transparent; macOS recolours it for light and
// dark menu bars on its own, which is why nothing here sets a colour.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'src', 'assets');

// ---- minimal PNG writer -------------------------------------------------
function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple
  // and the icons are far too small for the size difference to matter.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy
      ? rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4)
      : Buffer.from(rgba).copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- the mark -----------------------------------------------------------
// cue's logo is a ring with a pinwheel inside it. At 16 pixels the pinwheel
// turns to mush, so the tray version keeps the ring and reduces the interior to
// a single solid quadrant — recognisably the same mark, still legible at 1x.
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const centre = (size - 1) / 2;
  const outer = size * 0.44;
  const inner = outer - Math.max(1.1, size * 0.085);
  const dot = size * 0.19;

  // 3x3 supersampling: without it the ring has hard jaggies at 16px.
  const samples = 3;
  const step = 1 / (samples + 1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 1; sy <= samples; sy++) {
        for (let sx = 1; sx <= samples; sx++) {
          const px = x + sx * step - 0.5;
          const py = y + sy * step - 0.5;
          const dx = px - centre;
          const dy = py - centre;
          const distance = Math.hypot(dx, dy);

          const onRing = distance <= outer && distance >= inner;
          // Upper-right quadrant, kept clear of the ring so the two shapes read
          // as separate rather than as one blob.
          const inQuadrant = distance <= dot && dx >= -0.35 && dy <= 0.35;
          if (onRing || inQuadrant) hits++;
        }
      }
      if (!hits) continue;
      const alpha = Math.round((hits / (samples * samples)) * 255);
      const offset = (y * size + x) * 4;
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = alpha;
    }
  }
  return rgba;
}

function write(name, size) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)} (${size}x${size})`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
write('trayTemplate.png', 16);
write('trayTemplate@2x.png', 32);
write('trayTemplate@3x.png', 48);
