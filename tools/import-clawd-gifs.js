// Imports pixel-art Clawd animations from KebeliSamet0/clawd for LOCAL use.
//
// The artwork in that repo is All-Rights-Reserved fan art (the repo's MIT
// license covers code only). This tool therefore downloads and converts the
// GIFs on YOUR machine into assets/clawd-external/, which is gitignored —
// nothing is committed or redistributed with this project.
//
// Usage: node tools/import-clawd-gifs.js [path-to-local-clone-or-gif-dir]
//        (no argument: downloads from raw.githubusercontent.com)
const fs = require('node:fs');
const path = require('node:path');
const { GifReader } = require('omggif');
const { PNG } = require('pngjs');

const LCD_W = 240;
const LCD_H = 135;
const BG = [0x10, 0x13, 0x19]; // same dark background as the procedural art

const ANIMS = [
  'sleeping',
  'typing',
  'thinking',
  'building',
  'debugger',
  'notification',
  'happy',
  'carrying',
  'react-annoyed',
  'react-double-jump',
];

const RAW_BASE = 'https://raw.githubusercontent.com/KebeliSamet0/clawd/master/assets/gif';

async function getGif(name) {
  const local = process.argv[2];
  const file = `clawd-${name}.gif`;
  if (local) {
    // Accept either the repo root or the gif directory itself.
    for (const p of [
      path.join(local, file),
      path.join(local, 'assets', 'gif', file),
    ]) {
      if (fs.existsSync(p)) return fs.readFileSync(p);
    }
    throw new Error(`${file} not found under ${local}`);
  }
  const url = `${RAW_BASE}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Box-average downscale of RGBA to the target rect (better than NN for downscale). */
function scaleInto(dst, dstW, dstH, ox, oy, targetW, targetH, src, srcW, srcH) {
  for (let y = 0; y < targetH; y++) {
    const sy0 = (y * srcH) / targetH;
    const sy1 = ((y + 1) * srcH) / targetH;
    for (let x = 0; x < targetW; x++) {
      const sx0 = (x * srcW) / targetW;
      const sx1 = ((x + 1) * srcW) / targetW;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const i = (sy * srcW + sx) * 4;
          const alpha = src[i + 3] / 255;
          r += src[i] * alpha;
          g += src[i + 1] * alpha;
          b += src[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const di = ((oy + y) * dstW + ox + x) * 4;
      const alpha = a / n;
      // Composite averaged color over the background
      dst[di] = Math.round((a ? r / a : 0) * alpha + BG[0] * (1 - alpha));
      dst[di + 1] = Math.round((a ? g / a : 0) * alpha + BG[1] * (1 - alpha));
      dst[di + 2] = Math.round((a ? b / a : 0) * alpha + BG[2] * (1 - alpha));
      dst[di + 3] = 255;
    }
  }
}

async function importAnim(name) {
  const gif = new GifReader(new Uint8Array(await getGif(name)));
  const srcW = gif.width;
  const srcH = gif.height;

  const outDir = path.join(__dirname, '..', 'assets', 'clawd-external', name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Pass 1: composite every frame (GIF frames are patches over the previous
  // one) and find the union bounding box of visible pixels so we can crop
  // away the GIF's empty margins — Clawd should fill the tiny LCD.
  const canvas = new Uint8Array(srcW * srcH * 4);
  const composited = [];
  const delays = [];
  let prevInfo = null;
  let minX = srcW,
    minY = srcH,
    maxX = -1,
    maxY = -1;

  for (let f = 0; f < gif.numFrames(); f++) {
    const info = gif.frameInfo(f);
    // GIF disposal 2: restore the previous frame's rect to transparent.
    if (prevInfo && prevInfo.disposal === 2) {
      for (let y = prevInfo.y; y < prevInfo.y + prevInfo.height; y++) {
        canvas.fill(0, (y * srcW + prevInfo.x) * 4, (y * srcW + prevInfo.x + prevInfo.width) * 4);
      }
    }
    gif.decodeAndBlitFrameRGBA(f, canvas);
    prevInfo = info;
    composited.push(Uint8Array.from(canvas));
    delays.push(Math.max(40, info.delay * 10)); // delay is in 10 ms units

    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        if (canvas[(y * srcW + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  if (maxX < 0) throw new Error(`${name}: no visible pixels`);

  // Crop with a small margin, then scale to fit the LCD, centered.
  const pad = 6;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(srcW, maxX + pad + 1) - cx;
  const ch = Math.min(srcH, maxY + pad + 1) - cy;
  const scale = Math.min(LCD_W / cw, LCD_H / ch);
  const targetW = Math.round(cw * scale);
  const targetH = Math.round(ch * scale);
  const ox = Math.floor((LCD_W - targetW) / 2);
  const oy = Math.floor((LCD_H - targetH) / 2);

  // Pass 2: render each composited frame cropped + scaled onto the background.
  for (let f = 0; f < composited.length; f++) {
    const src = composited[f];
    // Extract the crop into its own buffer
    const crop = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      const from = ((cy + y) * srcW + cx) * 4;
      crop.set(src.subarray(from, from + cw * 4), y * cw * 4);
    }
    const png = new PNG({ width: LCD_W, height: LCD_H });
    for (let i = 0; i < LCD_W * LCD_H; i++) {
      png.data[i * 4] = BG[0];
      png.data[i * 4 + 1] = BG[1];
      png.data[i * 4 + 2] = BG[2];
      png.data[i * 4 + 3] = 255;
    }
    scaleInto(png.data, LCD_W, LCD_H, ox, oy, targetW, targetH, crop, cw, ch);
    fs.writeFileSync(path.join(outDir, `${f}.png`), PNG.sync.write(png));
  }

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ delays, source: `KebeliSamet0/clawd clawd-${name}.gif` })
  );
  console.log(`${name}: ${gif.numFrames()} frames (${targetW}x${targetH})`);
}

/**
 * Shared per-user art dir, read by both the dev app and installed builds
 * (deliberately a fixed name — dev and packaged apps have different
 * userData names). Lives outside the install dir so app updates keep it.
 */
function sharedDir() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? path.join(process.env.HOME, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
  return path.join(base, 'xpad-mini-claude-code', 'clawd-external');
}

(async () => {
  for (const name of ANIMS) {
    await importAnim(name);
  }
  const repoDir = path.join(__dirname, '..', 'assets', 'clawd-external');
  const shared = sharedDir();
  fs.rmSync(shared, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.cpSync(repoDir, shared, { recursive: true });
  console.log(`\nDone. Frames are in assets/clawd-external/ and ${shared}`);
  console.log('(gitignored / local-only — the artwork is All-Rights-Reserved');
  console.log('fan art and must not be committed or redistributed).');
})();
