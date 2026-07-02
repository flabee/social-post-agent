// HTML -> PNG renderer for social posts. Turns post data into brand-ready PNGs via
// headless Chromium (Puppeteer). Ships with NEUTRAL, CSS-only example templates that
// need NO external background image, so it runs out of the box.
//
//   News:   type=cover (period) / type=news (category, title, body, image?, source?)   1080x1350
//   Event:  type=event (title, datetime, speaker, role, speaker2?, role2?)             1080x1350
//   Hiring: type=hiring (role1, role2?)                                                1080x1080
//   Carousel: GET /carousel?c=<base64url JSON {period, items}>  -> preview grid (3 cols)
//             GET /carousel.zip?c=...                           -> zip of all full-res slides
//
// Auto-fit: elements with class "fit" and data-maxh are shrunk to fit their box.
//
// ─────────────────────────────────────────────────────────────────────────────
// BRING YOUR OWN BRAND TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────
// The example templates draw everything in CSS (gradients + text). Real brand posts
// usually start from a background PNG exported from a design tool, with text and
// widgets positioned absolutely on top. The pattern to add your own:
//
//   1. Export a clean background PNG at the template's exact pixel size (e.g. 1080x1350).
//   2. Drop it in ./assets and load it as a data URI (see the commented `b64`/`BG` block below).
//   3. In the template's `widgets(f)` function, position each text/image widget with
//      absolute coordinates over the background: `<div class="abs" style="left:120px;top:700px;...">`.
//   4. Tune the coordinates by rendering (GET /render?type=...&title=...) and nudging px values.
//   5. Give long text fields the class "fit" + a data-maxh (max height in px) so they
//      auto-shrink instead of overflowing.
//
// Then set the background as the first child of the .card (see buildHtml). The engine,
// routes, fonts, auto-fit and image fetching all stay the same.

import express from 'express';
import puppeteer from 'puppeteer';
import JSZip from 'jszip';
import { readFileSync } from 'fs';

const PORT = process.env.PORT || 8080;

const b64 = (p) => readFileSync(new URL(p, import.meta.url)).toString('base64');

// Bundled fonts (SIL Open Font License — see ../NOTICE). Redistributable.
const M800 = `data:font/woff2;base64,${b64('./assets/Montserrat-800.woff2')}`;
const M700 = `data:font/woff2;base64,${b64('./assets/Montserrat-700.woff2')}`;
const L400 = `data:font/woff2;base64,${b64('./assets/Lato-400.woff2')}`;
const L700 = `data:font/woff2;base64,${b64('./assets/Lato-700.woff2')}`;

// To use your own background PNGs, drop them in ./assets and uncomment:
// const BG = {
//   cover: `data:image/png;base64,${b64('./assets/your_cover_bg.png')}`,
//   news:  `data:image/png;base64,${b64('./assets/your_news_bg.png')}`,
// };

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Up to 2 initials from a name, for the speaker avatar placeholder.
function initials_(name) {
  return String(name || '').trim().split(/\s+/).map(function(w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();
}

// Circular speaker avatar (125px, accent ring). With a photo: image cropped into the
// circle. Without: filled circle with the initials, so the layout stays intentional
// even when a photo is missing.
function eventAvatar_(img, name, left) {
  const base = 'position:absolute;left:' + left + 'px;top:1120px;width:125px;height:125px;border-radius:50%;overflow:hidden;border:4px solid #7c5cff;box-sizing:border-box;background:#7c5cff;';
  if (img) {
    return '<div style="' + base + '"><img src="' + img + '" style="width:100%;height:100%;object-fit:cover;display:block;"></div>';
  }
  return '<div style="' + base + 'display:flex;align-items:center;justify-content:center;">'
    + '<span style="font-family:\'Montserrat\';font-weight:800;font-size:44px;color:#fff;">' + esc(initials_(name)) + '</span></div>';
}

// Detects the image type from magic bytes, for when the server does not send a
// reliable image/* content-type (happens: octet-stream, empty, text/plain).
function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function fetchImageDataUri(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
      headers: {
        // Many CDNs block downloads without a browser UA (hotlink protection).
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!r.ok) { console.log('[img] HTTP ' + r.status + ' ' + url); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 12 * 1024 * 1024) { console.log('[img] size ' + buf.length + ' ' + url); return null; }
    let ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(ct)) {
      const sniffed = sniffImageType(buf);
      if (!sniffed) { console.log('[img] ct=' + (ct || 'none') + ' (not an image) ' + url); return null; }
      ct = sniffed;
    }
    console.log('[img] OK ' + ct + ' ' + buf.length + 'b ' + url);
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.log('[img] ERR ' + (e && e.message ? e.message : e) + ' ' + url);
    return null;
  }
}

const FONTS = `
  @font-face{font-family:'Montserrat';font-weight:800;src:url(${M800}) format('woff2');}
  @font-face{font-family:'Montserrat';font-weight:700;src:url(${M700}) format('woff2');}
  @font-face{font-family:'Lato';font-weight:400;src:url(${L400}) format('woff2');}
  @font-face{font-family:'Lato';font-weight:700;src:url(${L700}) format('woff2');}
  *{margin:0;padding:0;box-sizing:border-box;}
  .abs{position:absolute;}`;

// Neutral CSS backgrounds (no external images). Tasteful dark gradients per type.
const BG_CSS = {
  cover:  'background:radial-gradient(120% 120% at 20% 10%, #2a2350 0%, #14112b 60%, #0c0a1c 100%);',
  news:   'background:linear-gradient(160deg, #171432 0%, #0f0d24 100%);',
  event:  'background:radial-gradient(120% 120% at 80% 0%, #26224d 0%, #131126 60%, #0b0a1a 100%);',
  hiring: 'background:linear-gradient(155deg, #1d1a3c 0%, #100e26 100%);',
};

// A small brand mark drawn in CSS. Replace "Acme" with your brand, or swap for a logo.
const BRAND_MARK = (left, top, color) =>
  `<div class="abs" style="left:${left}px;top:${top}px;font-family:'Montserrat';font-weight:800;font-size:34px;letter-spacing:2px;color:${color || '#7c5cff'};">ACME</div>`;

const TEMPLATES = {
  // Carousel cover: brand mark + big "News" label + period.
  cover: { w: 1080, h: 1350, css: BG_CSS.cover, widgets: (f) => `
    ${BRAND_MARK(96, 110, '#a99bff')}
    <div class="abs" style="left:96px;top:520px;width:888px;font-family:'Montserrat';font-weight:800;font-size:120px;line-height:.98;letter-spacing:-2px;color:#fff;">News<br>round-up</div>
    <div class="abs" style="left:96px;top:1180px;width:888px;font-family:'Lato';font-weight:700;font-size:40px;color:#a99bff;">${esc(f.period)}</div>
    <div class="abs" style="left:96px;top:816px;width:120px;height:8px;background:#7c5cff;border-radius:4px;"></div>` },

  // News slide: article photo fills the top zone; category/title/body below.
  // Without a photo, the top zone is a subtle gradient band (still on-brand).
  news: { w: 1080, h: 1350, css: BG_CSS.news, widgets: (f) => {
    const top = f._img ? `
      <div class="abs" style="left:0;top:0;width:1080px;height:600px;overflow:hidden;">
        <img src="${f._img}" style="width:1080px;height:600px;object-fit:cover;display:block;">
        <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(15,13,36,0) 55%, rgba(15,13,36,1) 100%);"></div>
      </div>
      ${BRAND_MARK(84, 74, '#fff')}
      ${f.source ? `<div class="abs" style="left:60px;top:540px;width:960px;text-align:right;font-family:'Lato';font-weight:400;font-size:22px;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.75);">Source: ${esc(f.source)}</div>` : ''}
    ` : `
      <div class="abs" style="left:0;top:0;width:1080px;height:360px;background:linear-gradient(135deg,#3a2f6e 0%, #211c44 100%);"></div>
      ${BRAND_MARK(84, 74, '#fff')}`;
    const textTop = f._img ? 640 : 430;
    return top + `
      <div class="abs" style="left:84px;top:${textTop}px;width:912px;font-family:'Montserrat';font-weight:700;font-size:30px;color:#a99bff;text-transform:uppercase;letter-spacing:2px;">${esc(f.category)}</div>
      <div class="abs fit" data-maxh="230" style="left:84px;top:${textTop + 54}px;width:912px;font-family:'Montserrat';font-weight:800;font-size:60px;line-height:1.04;letter-spacing:-.5px;color:#fff;">${esc(f.title)}</div>
      <div class="abs fit" data-maxh="300" style="left:84px;top:${textTop + 300}px;width:912px;font-family:'Lato';font-weight:400;font-size:31px;line-height:1.34;color:#d9d6ee;">${esc(f.body)}</div>`;
  } },

  // Event/Webinar: title + datetime + one or two speaker avatars with name/role.
  event: { w: 1080, h: 1350, css: BG_CSS.event, widgets: (f) =>
    BRAND_MARK(84, 96, '#a99bff')
    + `<div class="abs" style="left:84px;top:300px;width:840px;font-family:'Lato';font-weight:700;font-size:30px;color:#a99bff;">${esc(f.datetime)}</div>
    <div class="abs fit" data-maxh="560" style="left:84px;top:360px;width:912px;font-family:'Montserrat';font-weight:800;font-size:72px;line-height:1.03;letter-spacing:-1px;color:#fff;">${esc(f.title)}</div>`
    + eventAvatar_(f._imgSpk, f.speaker, 84)
    + (f.speaker2 ? eventAvatar_(f._imgSpk2, f.speaker2, 564) : '')
    + `<div class="abs" style="left:231px;top:1145px;width:320px;font-family:'Montserrat';font-weight:700;font-size:26px;color:#fff;">${esc(f.speaker)}</div>
    <div class="abs" style="left:231px;top:1189px;width:360px;font-family:'Lato';font-weight:400;font-size:22px;color:#c7c2e6;">${esc(f.role)}</div>
    ${f.speaker2 ? `<div class="abs" style="left:711px;top:1145px;width:320px;font-family:'Montserrat';font-weight:700;font-size:26px;color:#fff;">${esc(f.speaker2)}</div>` : ''}
    ${f.role2 ? `<div class="abs" style="left:711px;top:1189px;width:360px;font-family:'Lato';font-weight:400;font-size:22px;color:#c7c2e6;">${esc(f.role2)}</div>` : ''}` },

  // Hiring: "We're hiring" + one or two roles.
  hiring: { w: 1080, h: 1080, css: BG_CSS.hiring, widgets: (f) =>
    BRAND_MARK(84, 96, '#a99bff')
    + `<div class="abs" style="left:84px;top:300px;width:912px;font-family:'Montserrat';font-weight:800;font-size:96px;line-height:1;letter-spacing:-2px;color:#fff;">We're<br>hiring</div>
    <div class="abs" style="left:84px;top:560px;width:120px;height:8px;background:#7c5cff;border-radius:4px;"></div>
    <div class="abs" style="left:84px;top:640px;width:912px;font-family:'Lato';font-weight:700;font-size:44px;color:#d9d6ee;">${esc(f.role1)}</div>
    ${f.role2 ? `<div class="abs" style="left:84px;top:720px;width:912px;font-family:'Lato';font-weight:700;font-size:44px;color:#d9d6ee;">${esc(f.role2)}</div>` : ''}` },
};

// Shrinks the font size of .fit elements until they fit within data-maxh (px).
const AUTOFIT_JS = `
  document.querySelectorAll('.fit').forEach(function(el){
    var maxh = parseFloat(el.getAttribute('data-maxh') || '0');
    if (!maxh) return;
    var fs = parseFloat(getComputedStyle(el).fontSize);
    var guard = 0;
    while (el.scrollHeight > maxh && fs > 11 && guard < 60) { fs -= 1; el.style.fontSize = fs + 'px'; guard++; }
  });`;

function buildHtml(type, fields) {
  const t = TEMPLATES[type] || TEMPLATES.news;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
    html,body{width:${t.w}px;height:${t.h}px;}
    .card{position:relative;width:${t.w}px;height:${t.h}px;overflow:hidden;${t.css}}
  </style></head><body><div class="card">
    ${t.widgets(fields)}
  </div></body></html>`;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
    });
  }
  return browserPromise;
}

async function renderPng(type, fields) {
  if (type === 'news' && fields.image && !fields._img) {
    fields._img = await fetchImageDataUri(fields.image);
  }
  if (type === 'event') {
    if (fields.speaker_image && !fields._imgSpk) fields._imgSpk = await fetchImageDataUri(fields.speaker_image);
    if (fields.speaker2_image && !fields._imgSpk2) fields._imgSpk2 = await fetchImageDataUri(fields.speaker2_image);
  }
  const t = TEMPLATES[type] || TEMPLATES.news;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: 1 });
    await page.setContent(buildHtml(type, fields), { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(AUTOFIT_JS);
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: t.w, height: t.h } });
    return Buffer.from(shot);
  } finally {
    await page.close();
  }
}

// ─── Carousel preview: cover + 5 news in a 3-column grid ──────────────────────
const STRIP_SCALE = 0.5;
const GRID_COLS = 3;
const GRID_GAP = 16;

function carouselHtml(period, items) {
  const W = 1080, H = 1350;
  const tw = Math.round(W * STRIP_SCALE), th = Math.round(H * STRIP_SCALE);
  const panel = (type, f) => {
    const t = TEMPLATES[type];
    return `<div class="thumb" style="width:${tw}px;height:${th}px;">
      <div class="card" style="width:${W}px;height:${H}px;transform:scale(${STRIP_SCALE});transform-origin:top left;${t.css}">
        ${t.widgets(f)}
      </div></div>`;
  };
  const panels = [panel('cover', { period })]
    .concat((items || []).slice(0, 5).map((it) => panel('news', it)));
  const n = panels.length;
  const rows = Math.ceil(n / GRID_COLS);
  const totalW = GRID_COLS * tw + (GRID_COLS - 1) * GRID_GAP;
  const totalH = rows * th + (rows - 1) * GRID_GAP;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${FONTS}
    body{background:#e9e9f1;}
    .grid{display:flex;flex-wrap:wrap;gap:${GRID_GAP}px;width:${totalW}px;}
    .thumb{overflow:hidden;position:relative;border-radius:14px;}
    .card{position:relative;overflow:hidden;}
  </style></head><body><div class="grid">${panels.join('')}</div></body></html>`;
  return { html, w: totalW, h: totalH };
}

async function renderCarousel(period, items) {
  items = (items || []).slice(0, 5);
  await Promise.all(items.map(async (it) => {
    if (it.image && !it._img) it._img = await fetchImageDataUri(it.image);
  }));
  const { html, w, h } = carouselHtml(period, items);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(AUTOFIT_JS);
    const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: w, height: h } });
    return Buffer.from(shot);
  } finally {
    await page.close();
  }
}

const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.send('Social post renderer running.'));

app.get('/carousel', async (req, res) => {
  try {
    let payload = {};
    if (req.query.c) payload = JSON.parse(Buffer.from(req.query.c, 'base64url').toString('utf8'));
    const png = await renderCarousel(payload.period || '', payload.items || []);
    res.set('Content-Type', 'image/png');
    if (req.query.dl) res.set('Content-Disposition', 'attachment; filename="carousel.png"');
    res.send(png);
  } catch (err) {
    console.error('carousel error:', err);
    res.status(500).send('Carousel error: ' + (err && err.message ? err.message : err));
  }
});

async function handle(req, res) {
  const s = req.method === 'POST' ? (req.body || {}) : req.query;
  const type = TEMPLATES[s.type] ? s.type : 'news';
  const fields = {
    period: s.period, category: s.category, title: s.title, body: s.body,
    image: s.image, source: s.source,
    datetime: s.datetime, speaker: s.speaker, role: s.role,
    speaker2: s.speaker2, role2: s.role2, role1: s.role1,
    speaker_image: s.speaker_image, speaker2_image: s.speaker2_image,
  };
  try {
    const png = await renderPng(type, fields);
    res.set('Content-Type', 'image/png');
    if (s.dl) res.set('Content-Disposition', 'attachment; filename="' + type + '.png"');
    res.send(png);
  } catch (err) {
    console.error('render error:', err);
    res.status(500).send('Render error: ' + (err && err.message ? err.message : err));
  }
}
app.get('/render', handle);
app.post('/render', handle);

app.get('/carousel.zip', async (req, res) => {
  try {
    let payload = {};
    if (req.query.c) payload = JSON.parse(Buffer.from(req.query.c, 'base64url').toString('utf8'));
    const items = (payload.items || []).slice(0, 5);
    const zip = new JSZip();
    zip.file('00-cover.png', await renderPng('cover', { period: payload.period || '' }));
    for (let i = 0; i < items.length; i++) {
      zip.file(('0' + (i + 1)).slice(-2) + '-news.png', await renderPng('news', items[i]));
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="news-carousel.zip"');
    res.send(buf);
  } catch (err) {
    console.error('zip error:', err);
    res.status(500).send('Zip error: ' + (err && err.message ? err.message : err));
  }
});

app.listen(PORT, () => console.log('Social post renderer listening on port ' + PORT));
