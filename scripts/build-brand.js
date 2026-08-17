#!/usr/bin/env node
// Generates every rasterised form of the voicegoat mark from one SVG.
//
//   node scripts/build-brand.js        (must run under Electron — see below)
//   npm run brand
//
// Output is committed, so a normal build never runs this. It exists so the
// brand can be changed by editing the SVG below rather than by round-tripping
// through a design tool, and so every size stays derived from one source.
//
// Rasterising happens in an offscreen Electron window: it is the only renderer
// already in this project's dependencies, it produces the same output as the
// app itself would, and it needs no network access.
//
//   src/assets/trayTemplate*.png   menu-bar icon (black on transparent)
//   build-resources/icon.icns      macOS app icon
//   build-resources/icon.png       1024px source, used by electron-builder
//                                  for Windows and Linux

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const BUILD = path.join(ROOT, 'build-resources');

// ---- the mark -----------------------------------------------------------
// Two horns sweeping up and outward around a voice waveform. It reads as an
// audio signal first and as horns second, which is the right order: the app is
// about hearing a conversation, and the name is the joke on top.
//
// `ink` is a colour or 'currentColor'; the tray build passes solid black
// because a macOS template image carries shape in its alpha channel alone.
function markSvg({ ink = '#0B0D12', stroke = 2.1 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1024" height="1024">
  <g fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7.6 17.9C4.2 15.1 3.2 9.7 5.3 5.6c.6-1.2 2-1.3 2.6-.3"/>
    <path d="M16.4 17.9c3.4-2.8 4.4-8.2 2.3-12.3-.6-1.2-2-1.3-2.6-.3"/>
    <path d="M12 6.6v10.8"/>
    <path d="M9.2 9.6v4.8"/>
    <path d="M14.8 9.6v4.8"/>
  </g>
</svg>`;
}

// The app icon sits on macOS's rounded square. The ground is the same near
// black as the overlay panel, so the icon and the product look like one thing.
function iconHtml() {
  const inner = markSvg({ ink: '#F2F4F8', stroke: 1.9 })
    .replace('width="1024" height="1024"', 'width="600" height="600"');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1024px;height:1024px;background:transparent}
    .plate{
      width:1024px;height:1024px;
      display:grid;place-items:center;
      border-radius:224px;
      background:radial-gradient(120% 120% at 30% 12%, #1C2230 0%, #0B0D12 62%);
      box-shadow: inset 0 6px 0 rgba(255,255,255,0.07);
    }
  </style></head><body><div class="plate">${inner}</div></body></html>`;
}

function trayHtml(size) {
  const inner = markSvg({ ink: '#000000', stroke: 2.4 })
    .replace('width="1024" height="1024"', `width="${size}" height="${size}"`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
  </style></head><body>${inner}</body></html>`;
}

async function shoot(win, html, width, height) {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.setContentSize(width, height);
  // One frame to settle before reading pixels back.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  return image;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: false }
  });

  // ---- tray: a template image, so macOS recolours it per menu bar ----
  for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32], ['trayTemplate@3x.png', 48]]) {
    const image = await shoot(win, trayHtml(size), size, size);
    fs.writeFileSync(path.join(ASSETS, name), image.toPNG());
    console.log('wrote src/assets/' + name);
  }

  // ---- app icon ----
  const master = await shoot(win, iconHtml(), 1024, 1024);
  fs.writeFileSync(path.join(BUILD, 'icon.png'), master.toPNG());
  console.log('wrote build-resources/icon.png');

  if (process.platform === 'darwin') {
    // iconutil wants a specific set of names; anything missing makes it refuse
    // the whole set rather than skip that size.
    const iconset = path.join(BUILD, 'icon.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset);
    const sizes = [16, 32, 64, 128, 256, 512, 1024];
    for (const size of sizes) {
      const resized = master.resize({ width: size, height: size, quality: 'best' });
      const png = resized.toPNG();
      if (size <= 512) fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), png);
      if (size >= 32) fs.writeFileSync(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), png);
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
    fs.rmSync(iconset, { recursive: true, force: true });
    console.log('wrote build-resources/icon.icns');
  }

  app.exit(0);
});
