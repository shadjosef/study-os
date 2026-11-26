#!/usr/bin/env node
/**
 * Headless Chromium end-to-end smoke & regression test suite for a built Study-OS static bundle.
 * Usage: node tools/smoke_test_e2e.mjs <dist-dir>
 * Keeps zero repo npm dependencies: resolves `playwright` from NODE_PATH or global/temp install.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const distDir = path.resolve(process.argv[2] || 'dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`Missing built site at ${distDir}/index.html`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
let pw = null;
for (const candidate of [
  process.env.PLAYWRIGHT_MODULE,
  'playwright-core',
  'playwright',
  '/tmp/pw-ci/node_modules/playwright-core',
  '/tmp/pw-ci/node_modules/playwright',
].filter(Boolean)) {
  try {
    pw = require(candidate);
    break;
  } catch {}
}
if (!pw) throw new Error('Playwright module not found. Set PLAYWRIGHT_MODULE or install playwright-core.');
const { chromium } = pw;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
  '.vsix': 'application/zip',
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      let filePath = path.join(rootDir, rel);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`E2E assertion failed: ${msg}`);
}

const { server, baseUrl } = await startStaticServer(distDir);
let browser;

try {
  const sysChrome = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => p && fs.existsSync(p));
  browser = await chromium.launch(sysChrome ? { headless: true, executablePath: sysChrome } : { headless: true });

  const pageErrors = [];
  const consoleErrors = [];
  const localFailures = [];

  async function mockExternalWorker(targetContext) {
    // Prevent local E2E runs on 127.0.0.1 from hitting the live production Worker
    // (whose strict CORS allowlist intentionally rejects ephemeral localhost origins).
    await targetContext.route('https://*.workers.dev/**', async (route) => {
      const reqUrl = new URL(route.request().url());
      let body = { ok: true };
      if (reqUrl.pathname === '/courses') {
        body = { courses: [] };
      } else if (reqUrl.pathname === '/leaderboard/public') {
        body = { ranks: [], hasMoreRanks: false, totalMembers: 0, activeNow: 0, now: Date.now() };
      } else if (reqUrl.pathname === '/auth/config') {
        body = { googleClientId: '', turnstileSiteKey: '', openSignup: false };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': baseUrl },
        body: JSON.stringify(body),
      });
    });
  }

  function attachErrorTrackers(targetPage) {
    targetPage.on('pageerror', (err) => pageErrors.push(`${targetPage.url()}: ${String(err?.stack || err)}`));
    targetPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location()?.url || targetPage.url();
        consoleErrors.push(`${loc}: ${msg.text()}`);
      }
    });
    targetPage.on('response', (resp) => {
      const u = resp.url();
      if (u.startsWith(baseUrl) && resp.status() >= 400) {
        localFailures.push(`${resp.status()} ${u}`);
      }
    });
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await mockExternalWorker(context);
  const page = await context.newPage();
  attachErrorTrackers(page);

  // 1. Main SPA `/` — cold visit must render courses with ZERO blocking signup modal
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-open-course], .course-card', { timeout: 15_000 });
  const gateOpen = await page.evaluate(() => Boolean(document.getElementById('profile-gate')?.open));
  assert(!gateOpen, 'Cold visitor must NOT be blocked by #profile-gate login modal on initial load');
  const h1Text = await page.locator('h1').first().textContent();
  assert(Boolean(h1Text && h1Text.trim().length > 3), 'Homepage must render a non-empty <h1>');
  console.log('  PASS: / (SPA renders courses with zero cold-visit login wall)');

  // 2. `/wiseflow-practice.html` — interactive BI WISEflow FLOWmulti mini-tryout
  await page.goto(`${baseUrl}/wiseflow-practice.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#wf-in-cf0', '200000');
  await page.fill('#wf-in-pv', '216528,93');
  await page.fill('#wf-in-npv', '16528.93');
  await page.click('#wf-check-btn');
  const cf0Msg = (await page.locator('#wf-msg-cf0').textContent()) || '';
  const pvMsg = (await page.locator('#wf-msg-pv').textContent()) || '';
  assert(/minus/i.test(cf0Msg), `Expected missing-minus warning, got: ${cf0Msg}`);
  assert(/comma/i.test(pvMsg), `Expected comma-decimal warning, got: ${pvMsg}`);
  await page.click('#wf-fill-btn');
  const wfStatus = (await page.locator('#wf-demo-status').textContent()) || '';
  assert(wfStatus.includes('3/3 passed'), `Expected 3/3 passed status, got: ${wfStatus}`);
  console.log('  PASS: /wiseflow-practice.html (FLOWmulti comma/sign checks + 3/3 grading)');

  // 3. `/gpa-calculator.html` — zero-login Norwegian ECTS GPA calculator
  await page.goto(`${baseUrl}/gpa-calculator.html`, { waitUntil: 'domcontentloaded' });
  const biAvg = (await page.locator('#gpa-avg').textContent())?.trim();
  const biLetter = (await page.locator('#gpa-letter').textContent())?.trim();
  assert(biAvg === '4.50' && biLetter === 'A', `Expected BI preset 4.50/A, got ${biAvg}/${biLetter}`);
  await page.click('[data-preset="ntnu"]');
  const ntnuAvg = (await page.locator('#gpa-avg').textContent())?.trim();
  const ntnuLetter = (await page.locator('#gpa-letter').textContent())?.trim();
  assert(ntnuAvg === '4.00' && ntnuLetter === 'B', `Expected NTNU preset 4.00/B, got ${ntnuAvg}/${ntnuLetter}`);
  console.log('  PASS: /gpa-calculator.html (BI 4.50/A & NTNU 4.00/B presets)');

  // 4. Core SEO landing pages render cleanly with seo.css and no errors
  for (const route of ['/bi-oslo.html', '/norsk.html', '/universities.html', '/courses/acct-2527.html', '/uni/nhh.html']) {
    const resp = await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
    assert(resp && resp.status() === 200, `${route} returned HTTP ${resp?.status()}`);
    const title = (await page.locator('h1').first().textContent())?.trim() || '';
    assert(title.length > 5, `${route} missing non-empty <h1>`);
  }
  console.log('  PASS: Core SEO landing pages (/bi-oslo, /norsk, /universities, /courses/acct-2527, /uni/nhh)');

  // 5. A11y landmark & semantics gate across core SPA + SEO/legal/course pages
  const a11yRoutes = [
    '/',
    '/bi-oslo.html',
    '/norsk.html',
    '/universities.html',
    '/privacy.html',
    '/terms.html',
    '/courses/acct-2527.html',
  ];
  for (const route of a11yRoutes) {
    const resp = await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
    assert(resp && resp.status() === 200, `A11y route ${route} returned HTTP ${resp?.status()}`);
    if (route === '/') {
      await page.waitForSelector('[data-open-course], .course-card', { timeout: 15_000 });
    }
    const a11y = await page.evaluate(() => {
      const h1s = [...document.querySelectorAll('h1')];
      const imgsMissingAlt = [...document.querySelectorAll('img')]
        .filter((img) => !img.hasAttribute('alt'))
        .map((img) => img.getAttribute('src') || img.outerHTML.slice(0, 80));
      return {
        h1Count: h1s.length,
        h1Text: (h1s[0]?.textContent || '').trim(),
        hasMain: Boolean(document.querySelector('main#main-content')),
        hasSkipLink: Boolean(document.querySelector('.skip-link')),
        labeledNavCount: document.querySelectorAll('nav[aria-label]').length,
        imgsMissingAlt,
      };
    });
    assert(a11y.h1Count === 1, `${route}: expected exactly 1 <h1>, found ${a11y.h1Count}`);
    assert(a11y.h1Text.length > 3, `${route}: <h1> text must be non-empty`);
    assert(a11y.hasMain, `${route}: missing <main id="main-content"> landmark`);
    assert(a11y.hasSkipLink, `${route}: missing .skip-link anchor`);
    assert(a11y.labeledNavCount >= 1, `${route}: expected at least 1 <nav aria-label>`);
    assert(
      a11y.imgsMissingAlt.length === 0,
      `${route}: found <img> missing alt attribute: ${a11y.imgsMissingAlt.join(', ')}`
    );
  }
  console.log(`  PASS: A11y landmarks & semantics (${a11yRoutes.length} routes: single <h1>, #main-content, .skip-link, nav[aria-label], img[alt])`);

  // 6. Core Web Vitals CLS gate (< 0.05) on static landing pages
  const clsRoutes = ['/bi-oslo.html', '/norsk.html', '/universities.html'];
  const clsPage = await context.newPage();
  attachErrorTrackers(clsPage);
  await clsPage.addInitScript(() => {
    window.__studyOsCls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__studyOsCls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });
  const clsReport = [];
  for (const route of clsRoutes) {
    const resp = await clsPage.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
    assert(resp && resp.status() === 200, `CLS route ${route} returned HTTP ${resp?.status()}`);
    await clsPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    await clsPage.waitForTimeout(100);
    const cls = await clsPage.evaluate(() => Number(window.__studyOsCls || 0));
    assert(Number.isFinite(cls) && cls < 0.05, `${route}: CLS ${cls.toFixed(4)} exceeded 0.05 budget`);
    clsReport.push(`${route}=${cls.toFixed(4)}`);
  }
  await clsPage.close();
  console.log(`  PASS: Core Web Vitals CLS < 0.05 (${clsReport.join(', ')})`);

  // 7. Mobile responsive horizontal-overflow gate (390×844)
  const mobileRoutes = ['/', '/bi-oslo.html', '/norsk.html', '/universities.html', '/privacy.html'];
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mockExternalWorker(mobileContext);
  const mobilePage = await mobileContext.newPage();
  attachErrorTrackers(mobilePage);
  for (const route of mobileRoutes) {
    const resp = await mobilePage.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
    assert(resp && resp.status() === 200, `Mobile route ${route} returned HTTP ${resp?.status()}`);
    if (route === '/') {
      await mobilePage.waitForSelector('[data-open-course], .course-card', { timeout: 15_000 });
    }
    await mobilePage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const dims = await mobilePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert(
      dims.scrollWidth <= dims.clientWidth,
      `${route} at 390×844 has horizontal overflow: scrollWidth=${dims.scrollWidth} > clientWidth=${dims.clientWidth}`
    );
  }
  await mobileContext.close();
  console.log(`  PASS: Mobile 390×844 zero horizontal overflow (${mobileRoutes.join(', ')})`);

  // 8. PWA Service Worker lifecycle & Option B icon precache gate on `/`
  const swContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await mockExternalWorker(swContext);
  const swPage = await swContext.newPage();
  attachErrorTrackers(swPage);
  await swPage.goto(`${baseUrl}/`, { waitUntil: 'load' });
  await swPage.waitForSelector('[data-open-course], .course-card', { timeout: 15_000 });
  const swResult = await swPage.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      return { supported: false };
    }
    const reg = await navigator.serviceWorker.register('./offline-worker.js');
    const worker = reg.installing || reg.waiting || reg.active;
    if (!worker) throw new Error('Service worker registration produced no worker instance');
    if (worker.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`SW activation timed out (state=${worker.state})`)), 15_000);
        const onState = () => {
          if (worker.state === 'activated') {
            clearTimeout(timeout);
            worker.removeEventListener('statechange', onState);
            resolve();
          } else if (worker.state === 'redundant') {
            clearTimeout(timeout);
            worker.removeEventListener('statechange', onState);
            reject(new Error('Service worker became redundant during install/activate'));
          }
        };
        worker.addEventListener('statechange', onState);
        onState();
      });
    }
    const ready = await navigator.serviceWorker.ready;
    const cacheKeys = await caches.keys();
    const v2Key = cacheKeys.find((k) => k.includes('v2-option-b')) || '';
    let cachedPaths = [];
    if (v2Key) {
      const cache = await caches.open(v2Key);
      cachedPaths = (await cache.keys()).map((req) => new URL(req.url).pathname);
    }
    return {
      supported: true,
      scriptURL: ready.active?.scriptURL || '',
      state: ready.active?.state || '',
      cacheKeys,
      v2Key,
      cachedCount: cachedPaths.length,
      hasFavicon: cachedPaths.includes('/favicon.ico'),
      hasIcon192: cachedPaths.includes('/pwa/study-os-192.png'),
      hasIcon512: cachedPaths.includes('/pwa/study-os-512.png'),
      hasSelfSw: cachedPaths.some((p) => p.endsWith('/offline-worker.js')),
    };
  });
  assert(swResult.supported, 'Service Worker API unavailable in Chromium test context');
  assert(
    swResult.scriptURL.endsWith('/offline-worker.js') && swResult.state === 'activated',
    `Expected activated offline-worker.js, got script=${swResult.scriptURL} state=${swResult.state}`
  );
  assert(Boolean(swResult.v2Key), `Expected cache key containing 'v2-option-b', got: ${swResult.cacheKeys.join(', ')}`);
  assert(swResult.hasFavicon, `Cache ${swResult.v2Key} missing /favicon.ico`);
  assert(swResult.hasIcon192, `Cache ${swResult.v2Key} missing /pwa/study-os-192.png`);
  assert(swResult.hasIcon512, `Cache ${swResult.v2Key} missing /pwa/study-os-512.png`);
  assert(!swResult.hasSelfSw, `Cache ${swResult.v2Key} must NOT self-cache /offline-worker.js`);
  await swContext.close();
  console.log(`  PASS: PWA Service Worker (${swResult.v2Key}, ${swResult.cachedCount} assets, Option B icons cached, no self-cache)`);

  await context.close();

  assert(pageErrors.length === 0, `Uncaught page errors:\n${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors:\n${consoleErrors.join('\n')}`);
  assert(localFailures.length === 0, `Same-origin HTTP errors:\n${localFailures.join('\n')}`);
  console.log('ALL E2E SMOKE TESTS PASSED!');
} finally {
  if (browser) await browser.close();
  server.close();
}
