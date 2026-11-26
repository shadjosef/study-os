#!/usr/bin/env node
/**
 * Headless Chromium end-to-end smoke test for a built Study-OS static bundle.
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
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/tmp/pw-ci/node_modules/playwright'].filter(Boolean)) {
  try {
    pw = require(candidate);
    break;
  } catch {}
}
if (!pw) throw new Error('Playwright module not found. Set PLAYWRIGHT_MODULE or install playwright.');
const { chromium } = pw;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors = [];
  const localFailures = [];
  page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));
  page.on('response', (resp) => {
    const u = resp.url();
    if (u.startsWith(baseUrl) && resp.status() >= 400) {
      localFailures.push(`${resp.status()} ${u}`);
    }
  });

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

  assert(pageErrors.length === 0, `Uncaught page errors:\n${pageErrors.join('\n')}`);
  assert(localFailures.length === 0, `Same-origin HTTP errors:\n${localFailures.join('\n')}`);
  console.log('ALL E2E SMOKE TESTS PASSED!');
} finally {
  if (browser) await browser.close();
  server.close();
}
