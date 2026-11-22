// Renders animation.html frame by frame (the page is a pure function of time, window.setT(t)) and encodes the frames to a video with Chrome itself
// (canvas + MediaRecorder), because Playwright's ffmpeg does not exist for macOS 13.
// Run from the repo root:  node design/ai-chat/render.mjs            (whole video -> apps/web/public/videos)
//                          node design/ai-chat/render.mjs 5 12 21   (only stills at those seconds -> design/ai-chat/out/stills)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../e2e/package.json'));
const { chromium } = require('@playwright/test');
const W = 1120;
const H = 700;
const FPS = 20;
const stills = process.argv.slice(2).map(Number);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'animation.html')).href);
await page.waitForFunction(() => window.READY === true);
const duration = await page.evaluate(() => window.DURATION);

if (stills.length) {
  const dir = join(here, 'out', 'stills');
  mkdirSync(dir, { recursive: true });
  for (const t of stills) {
    await page.evaluate((t) => window.setT(t), t);
    await page.screenshot({ path: join(dir, `t${String(t).replace('.', '_')}.png`) });
  }
  await browser.close();
  console.log('stills in', dir);
  process.exit(0);
}

const out = join(here, '..', '..', 'apps', 'web', 'public', 'videos');
mkdirSync(out, { recursive: true });
const n = Math.round(duration * FPS);
// 1) every frame first (the screenshots are slower than real time) ...
const frames = [];
let poster;
for (let i = 0; i < n; i++) {
  await page.evaluate((t) => window.setT(t), i / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 86 });
  if (i === Math.round(21.6 * FPS)) poster = buf;
  frames.push(buf.toString('base64'));
}
// 2) ... then a steady FPS stream into the recorder, so the video lasts exactly n / FPS seconds
const enc = await browser.newPage({ viewport: { width: 400, height: 300 } });
await enc.goto('about:blank');
const mime = await enc.evaluate(() =>
  ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)),
);
console.log('encoder', mime);
await enc.evaluate(() => (window.__frames = []));
for (let i = 0; i < frames.length; i += 40) {
  await enc.evaluate((chunk) => window.__frames.push(...chunk), frames.slice(i, i + 40));
}
const b64 = await enc.evaluate(
  async ({ W, H, FPS, mime }) => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const rec = new MediaRecorder(canvas.captureStream(FPS), { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    const draw = async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      g.drawImage(img, 0, 0);
      img.close();
    };
    await draw(window.__frames[0]);
    rec.start(500);
    const t0 = performance.now();
    for (let i = 0; i < window.__frames.length; i++) {
      await draw(window.__frames[i]);
      const wait = t0 + ((i + 1) * 1000) / FPS - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    rec.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  { W, H, FPS, mime },
);
const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
writeFileSync(join(out, `nuzm-ai-chat.${ext}`), Buffer.from(b64, 'base64'));
writeFileSync(join(out, 'nuzm-ai-chat.jpg'), poster);
console.log('saved', join(out, `nuzm-ai-chat.${ext}`));
await browser.close();
