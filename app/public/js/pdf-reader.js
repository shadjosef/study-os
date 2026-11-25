'use strict';

window.StudyPdf = (() => {
  const script = new URL(document.currentScript.src);
  const vendor = new URL('../vendor/pdfjs/', script);
  let engine;
  let active;
  let inlineBatch = null;
  let excerptIndex;
  const indexUrl = new URL('../pdf-excerpts.json', script);
  indexUrl.search = script.search;
  const savedExcerpts = fetch(indexUrl)
    .then(response => response.ok ? response.json() : null)
    .then(index => { excerptIndex = index; })
    .catch(() => {});

  const geometry = new WeakMap();
  const pageText = new Map();

  // Persistent LRU caches so opening, re-rendering, tab-switching, and Next/Prev are instantaneous (< 2ms on hit)
  const MAX_DOC_CACHE = 10;
  const MAX_BITMAP_CACHE = 28;
  const docCache = new Map();     // docKey -> { promise, task, doc, textByPage: Map<page, string>, lastUsed }
  const bitmapCache = new Map();  // renderKey -> { canvas, width, height, viewportScale, viewportWidth, viewportHeight, range, trimBounds, numPages, textContent }
  const prefetchQueue = new Set();

  function pdfEngine() {
    if (!engine) {
      engine = import(new URL('pdf.min.mjs', vendor).href).then((pdf) => {
        pdf.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;
        return pdf;
      });
    }
    return engine;
  }

  function warm() {
    pdfEngine().catch(() => {});
  }

  // Eagerly warm PDF.js worker during browser idle time so the first PDF opens with zero cold-boot delay
  if (typeof window !== 'undefined') {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1400));
    idle(() => {
      if (document.visibilityState !== 'hidden') warm();
    });
  }

  function docKeyFor(source) {
    if (!source) return '';
    if (source.localSourceKey) return `local:${source.localSourceKey}`;
    if (source.memberAsset?.id) return `member:${source.memberAsset.id}`;
    return `url:${source.rawUrl || ''}`;
  }

  function activeDocKeys() {
    const keys = new Set();
    if (active?.docKey) keys.add(active.docKey);
    if (inlineBatch?.docKeys) {
      for (const k of inlineBatch.docKeys) keys.add(k);
    }
    return keys;
  }

  function evictOldDocs() {
    if (docCache.size <= MAX_DOC_CACHE) return;
    const pinned = activeDocKeys();
    const entries = [...docCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, entry] of entries) {
      if (docCache.size <= MAX_DOC_CACHE) break;
      if (pinned.has(k)) continue;
      docCache.delete(k);
      entry.task?.destroy?.().catch(() => {});
    }
  }

  function touchBitmap(key, value) {
    if (bitmapCache.has(key)) bitmapCache.delete(key);
    bitmapCache.set(key, value);
    while (bitmapCache.size > MAX_BITMAP_CACHE) {
      const oldest = bitmapCache.keys().next().value;
      bitmapCache.delete(oldest);
    }
  }

  function getBitmap(key) {
    const hit = bitmapCache.get(key);
    if (!hit) return null;
    bitmapCache.delete(key);
    bitmapCache.set(key, hit);
    return hit;
  }

  function clearCache(targetDocKey = '') {
    if (targetDocKey) {
      const entry = docCache.get(targetDocKey);
      if (entry) {
        docCache.delete(targetDocKey);
        entry.task?.destroy?.().catch(() => {});
      }
      for (const k of [...bitmapCache.keys()]) {
        if (k.startsWith(`${targetDocKey}#`)) bitmapCache.delete(k);
      }
      pageText.clear();
      return;
    }
    for (const entry of docCache.values()) {
      entry.task?.destroy?.().catch(() => {});
    }
    docCache.clear();
    bitmapCache.clear();
    pageText.clear();
  }

  async function documentOptions(source) {
    const input = source.memberAsset
      ? { data: new Uint8Array(await window.StudyMembers.pdfBytes(source.memberAsset.id)) }
      : source.localSourceKey
      ? { data: new Uint8Array(await window.StudyLocalSources.getBytes(source.localSourceKey)) }
      : { url: source.rawUrl };
    return {
      ...input,
      cMapUrl: new URL('cmaps/', vendor).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', vendor).href,
      wasmUrl: new URL('wasm/', vendor).href,
      isEvalSupported: false,
    };
  }

  async function getCachedDoc(source) {
    const key = docKeyFor(source);
    if (!key) throw new Error('Missing PDF source.');
    const existing = docCache.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.promise;
    }
    const entry = { promise: null, task: null, doc: null, textByPage: new Map(), lastUsed: Date.now() };
    entry.promise = (async () => {
      try {
        const pdf = await pdfEngine();
        const options = await documentOptions(source);
        const task = pdf.getDocument(options);
        entry.task = task;
        const doc = await task.promise;
        entry.doc = doc;
        entry.lastUsed = Date.now();
        evictOldDocs();
        return doc;
      } catch (err) {
        if (docCache.get(key) === entry) docCache.delete(key);
        entry.task?.destroy?.().catch(() => {});
        throw err;
      }
    })();
    docCache.set(key, entry);
    return entry.promise;
  }

  function savedRange(source, page) {
    const range = excerptIndex?.[source.questionId]?.[`${source.sourceId}:${page}`];
    return range && 0 <= range[0] && range[0] < range[1] && range[1] <= 1 ? range : null;
  }

  const HEADING_RE = /\b(problem|exercise|question|oppgave|task)\s+(\d+)\b/i;

  function mayHaveHeadingCrop(source) {
    if (!source?.questionId) return false;
    return Boolean(HEADING_RE.exec(source.questionTitle || '') || HEADING_RE.exec(source.label || ''));
  }

  function detectHeadingRange(source, page, content) {
    const target = HEADING_RE.exec(source.questionTitle || '') || HEADING_RE.exec(source.label || '');
    if (!target || !content?.items?.length) return null;
    const viewport = page.getViewport({ scale: 1 });
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      const row = Math.round(y);
      if (!lines.has(row)) lines.set(row, []);
      lines.get(row).push({ x, text: item.str.trim(), height: item.height || 10 });
    }
    const headings = Array.from(lines, ([y, parts]) => {
      const line = parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(' ');
      const match = HEADING_RE.exec(line);
      if (match?.index !== 0 || match[1].toLowerCase() !== target[1].toLowerCase()) return null;
      return { number: Number(match[2]), y: y - parts[0].height };
    }).filter(Boolean).sort((a, b) => a.y - b.y);
    const matches = headings.filter((section) => section.number === Number(target[2]));
    if (matches.length !== 1) return null;
    const start = matches[0].y;
    const next = headings.find((section) => section.y > start);
    const top = Math.max(0, (start - 4) / viewport.height);
    const bottom = next ? Math.min(1, (next.y - 3) / viewport.height) : 1;
    return top < bottom ? [top, bottom] : null;
  }

  async function resolveCropRange(source, page, prefetchedContent = null) {
    const { questionId, sourceId } = source;
    if (!questionId) return { range: [0, 1], isCropped: false, content: prefetchedContent };
    if (sourceId) {
      await savedExcerpts;
      const saved = savedRange(source, page.pageNumber);
      if (saved) return { range: saved, isCropped: saved[0] > 0.01 || saved[1] < 0.99, content: prefetchedContent };
    }
    if (mayHaveHeadingCrop(source)) {
      const content = prefetchedContent || await page.getTextContent().catch(() => ({ items: [], styles: {} }));
      const detected = detectHeadingRange(source, page, content);
      if (detected) {
        return { range: detected, isCropped: detected[0] > 0.01 || detected[1] < 0.99, content };
      }
      return { range: [0, 1], isCropped: false, content };
    }
    return { range: [0, 1], isCropped: false, content: prefetchedContent };
  }

  function itemsInRange(content, viewport, range) {
    const [top, bottom] = range;
    if (top <= 0 && bottom >= 1) return content.items;
    return content.items.filter((item) => {
      if (!item.transform) return false;
      const [, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return y >= top * viewport.height && y < bottom * viewport.height;
    });
  }

  async function readPageText(source) {
    const doc = await getCachedDoc(source);
    const pageNum = Math.max(1, Math.min(doc.numPages, Number(source.page) || 1));
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const { range } = await resolveCropRange(source, page, content);
    const items = itemsInRange(content, page.getViewport({ scale: 1 }), range);
    const lines = [];
    let line = '';
    let previousY;
    for (const item of items) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform[5];
      if (line && Math.abs(previousY - y) > 3) {
        lines.push(line.trim());
        line = '';
      }
      const part = item.str.trim();
      if (part) line += (line ? ' ' : '') + part;
      if (item.hasEOL && line) {
        lines.push(line.trim());
        line = '';
      }
      previousY = y;
    }
    if (line) lines.push(line.trim());
    return lines.join('\n');
  }

  function textForPage(source) {
    const key = source.questionId ? `${source.key}:${source.questionId}` : source.key;
    if (!pageText.has(key)) {
      const pending = readPageText(source).catch((error) => {
        if (pageText.get(key) === pending) pageText.delete(key);
        throw error;
      });
      pageText.set(key, pending);
      if (pageText.size > 24) pageText.delete(pageText.keys().next().value);
    }
    return pageText.get(key);
  }

  function boundsOf(surface, width, height) {
    if (geometry.has(surface)) return geometry.get(surface);
    const sampling = Math.min(1, 512 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * sampling));
    canvas.height = Math.max(1, Math.round(height * sampling));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(surface, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const columnInk = new Uint16Array(canvas.width);
    const rowInk = new Uint16Array(canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 224) {
          columnInk[x]++;
          rowInk[y]++;
        }
      }
    }
    const extent = (counts) => {
      const minimum = Math.max(2, Math.ceil(Math.max(...counts) / 45));
      return [counts.findIndex((n) => n >= minimum), counts.findLastIndex((n) => n >= minimum)];
    };
    const [left, right] = extent(columnInk);
    const [top, bottom] = extent(rowInk);
    const axis = (first, last, limit) => first < 0 ? [0, limit] :
      [Math.max(0, Math.floor(first / sampling) - limit * 0.025),
        Math.min(limit, Math.ceil((last + 1) / sampling) + limit * 0.025)];
    const [x0, x1] = axis(left, right, width);
    const [y0, y1] = axis(top, bottom, height);
    const bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    geometry.set(surface, bounds);
    return bounds;
  }

  function snapshotCanvas(sourceCanvas) {
    const copy = document.createElement('canvas');
    copy.width = sourceCanvas.width;
    copy.height = sourceCanvas.height;
    copy.getContext('2d').drawImage(sourceCanvas, 0, 0);
    return copy;
  }

  function computeRenderScale(original, targetCssWidth, maxScale = 2.4) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(460, Math.min(1200, Number(targetCssWidth) || 720));
    const desired = (cssW * dpr) / Math.max(1, original.width);
    return Math.max(1.35, Math.min(maxScale, desired));
  }

  function renderCacheKey(docKey, pageNum, range, isInline) {
    const rTag = range[0] <= 0.005 && range[1] >= 0.995
      ? 'full'
      : `${Math.round(range[0] * 1000)}-${Math.round(range[1] * 1000)}`;
    return `${docKey}#p${pageNum}:${rTag}:${isInline ? 'inl' : 'doc'}`;
  }

  const fitControls = `<button type="button" class="mini-tool-btn" data-pdf-fit="page">Fit width</button>
      <button type="button" class="mini-tool-btn" data-pdf-fit="content">Trim margins</button>`;

  function toolbar(compact = false) {
    return `<div class="pdf-zoom-tools" aria-label="Document zoom">
      <button type="button" class="mini-tool-btn" data-pdf-scale="-" aria-label="Zoom out">−</button>
      <span data-pdf-level>100%</span>
      <button type="button" class="mini-tool-btn" data-pdf-scale="+" aria-label="Zoom in">+</button>
      ${compact ? '' : fitControls}
    </div>`;
  }

  function viewer(page = 1, invert = false, sourceControl = '', fileActions = '') {
    return `<div class="pdf-reader-bar">
      <div class="pdf-page-tools" aria-label="PDF pages">
        <button type="button" class="mini-tool-btn" data-pdf-prev aria-label="Previous PDF page" title="Previous page ([)" disabled>‹</button>
        <form data-pdf-page-form><input name="page" type="number" min="1" value="${Number(page) || 1}" aria-label="PDF page number" title="Page number (press Enter)"></form>
        <span data-pdf-page-count></span>
        <button type="button" class="mini-tool-btn" data-pdf-next aria-label="Next PDF page" title="Next page (])" disabled>›</button>
      </div>
      ${toolbar(true)}
      <div class="pdf-quick-tools">
        <button type="button" class="mini-tool-btn" data-pdf-search-toggle aria-label="Search in PDF" title="Search in PDF (/)" aria-expanded="false">Search</button>
        ${window.StudyPdfCraft?.isAvailable?.() ? '<button type="button" class="mini-tool-btn pdf-edit-craft-btn" data-pdf-edit-craft title="Edit, highlight, annotate, sign, or OCR in PdfCraft (pure Rust WASM)">Edit PDF</button>' : ''}
        <details class="pdf-options">
          <summary class="mini-tool-btn" aria-label="PDF options" title="PDF options">⋯</summary>
          <div class="pdf-options-panel">
            ${sourceControl}
            ${fitControls}
            ${fileActions}
          </div>
        </details>
      </div>
    </div>
    <div class="pdf-search-bar" data-pdf-search-bar hidden>
      <input type="search" data-pdf-search-input placeholder="Search text in this PDF…" autocomplete="off" spellcheck="false" aria-label="Search text in PDF">
      <span class="muted pdf-search-count" data-pdf-search-count></span>
      <button type="button" class="mini-tool-btn" data-pdf-search-prev aria-label="Previous match" disabled>‹</button>
      <button type="button" class="mini-tool-btn" data-pdf-search-next aria-label="Next match" disabled>›</button>
      <button type="button" class="mini-tool-btn" data-pdf-search-close aria-label="Close search">×</button>
    </div>
    <p class="muted pdf-status" data-pdf-status role="status" hidden></p>
    <div class="pdf-zoom-scroll pdf-document-scroll ${invert ? 'pdf-ink-inverted' : ''}" tabindex="0" aria-label="Scrollable source PDF">
      <div class="pdf-zoom-page"><canvas aria-hidden="true"></canvas><div class="textLayer"></div></div>
    </div>`;
  }

  function bindZoom(root, scroller, paper, surface, state, sourceSize, textLayer, textOffsetY = 0, cachedBoundsGetter = null) {
    function paint() {
      const { width, height } = sourceSize();
      if (!width || !height || !scroller.clientWidth) return;
      const full = { x: 0, y: 0, width, height };
      let box = full;
      if (state.trim) {
        try {
          box = cachedBoundsGetter ? cachedBoundsGetter(surface, width, height) : boundsOf(surface, width, height);
        } catch {}
      }
      const scale = scroller.clientWidth / box.width * state.zoom / 100;
      paper.style.width = `${box.width * scale}px`;
      paper.style.height = `${box.height * scale}px`;
      if (textLayer) {
        textLayer.style.transform = `translate(${-box.x * scale}px, ${-(box.y + textOffsetY) * scale}px) scale(${scale})`;
      }
      Object.assign(surface.style, {
        width: `${width * scale}px`, height: `${height * scale}px`,
        maxWidth: 'none', left: `${-box.x * scale}px`, top: `${-box.y * scale}px`,
      });
      const levelEl = root.querySelector('[data-pdf-level]');
      if (levelEl) levelEl.textContent = Math.round(state.zoom) + '%';
      const resetBadge = root.querySelector('[data-pdf-zoom-reset]');
      if (resetBadge) {
        const isZoomed = Math.abs(state.zoom - 100) >= 2;
        resetBadge.hidden = !isZoomed;
        resetBadge.textContent = `${Math.round(state.zoom)}% · Reset`;
      }
      scroller.classList.toggle('is-pdf-zoomed', Math.abs(state.zoom - 100) >= 2);
      for (const button of root.querySelectorAll('[data-pdf-fit]')) {
        const selected = (button.dataset.pdfFit === 'content') === Boolean(state.trim);
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('active', selected);
      }
    }

    function setZoom(level, clientX, clientY) {
      const old = state.zoom;
      const next = Math.max(60, Math.min(400, level));
      if (next === old || !paper.offsetWidth) return;
      const box = scroller.getBoundingClientRect();
      const x = Number.isFinite(clientX) ? clientX - box.left : scroller.clientWidth / 2;
      const y = Number.isFinite(clientY) ? clientY - box.top : scroller.clientHeight / 2;
      const inset = () => Math.max(0, (scroller.clientWidth - paper.offsetWidth) / 2);
      const pageX = scroller.scrollLeft + x - inset();
      const pageY = scroller.scrollTop + y;
      state.zoom = next;
      paint();
      scroller.scrollLeft = pageX * next / old + inset() - x;
      scroller.scrollTop = pageY * next / old - y;
    }

    for (const button of root.querySelectorAll('[data-pdf-scale], [data-pdf-fit]')) {
      button.onclick = () => {
        if (button.dataset.pdfFit) {
          state.trim = button.dataset.pdfFit === 'content';
          state.zoom = 100;
          paint();
          scroller.scrollTo(0, 0);
        } else setZoom(Math.round(state.zoom) + (button.dataset.pdfScale === '+' ? 25 : -25));
      };
    }
    const resetBadgeBtn = root.querySelector('[data-pdf-zoom-reset]');
    if (resetBadgeBtn) {
      resetBadgeBtn.onclick = (ev) => {
        ev.stopPropagation();
        state.zoom = 100;
        paint();
        scroller.scrollTo(0, 0);
      };
    }
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      setZoom(state.zoom * Math.exp(-event.deltaY * unit / 140), event.clientX, event.clientY);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });

    // Safari exposes trackpad pinch as a cumulative scale instead of a wheel delta.
    let gestureZoom;
    const onGestureStart = (event) => {
      event.preventDefault();
      gestureZoom = state.zoom;
    };
    const onGestureChange = (event) => {
      if (gestureZoom == null || !Number.isFinite(event.scale)) return;
      event.preventDefault();
      setZoom(gestureZoom * event.scale, event.clientX, event.clientY);
    };
    const onGestureEnd = (event) => {
      if (gestureZoom == null) return;
      event.preventDefault();
      gestureZoom = undefined;
    };
    scroller.addEventListener('gesturestart', onGestureStart, { passive: false });
    scroller.addEventListener('gesturechange', onGestureChange, { passive: false });
    scroller.addEventListener('gestureend', onGestureEnd, { passive: false });

    // Two-finger touch pinch support on tablets/touchscreens
    let touchPinchDist = 0;
    let touchPinchZoom = 100;
    const onTouchStart = (event) => {
      if (event.touches.length === 2) {
        touchPinchDist = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY
        );
        touchPinchZoom = state.zoom;
      }
    };
    const onTouchMove = (event) => {
      if (event.touches.length === 2 && touchPinchDist > 0) {
        event.preventDefault();
        const dist = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY
        );
        const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
        const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
        setZoom(touchPinchZoom * (dist / touchPinchDist), midX, midY);
      }
    };
    const onTouchEnd = () => { touchPinchDist = 0; };
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd, { passive: true });

    const observer = new ResizeObserver(() => {
      if (root.isConnected) paint();
      else observer.disconnect();
    });
    observer.observe(scroller);
    if (surface instanceof HTMLImageElement) surface.addEventListener('load', paint);
    paint();
    return {
      paint,
      release: () => {
        observer.disconnect();
        scroller.removeEventListener('wheel', onWheel);
        scroller.removeEventListener('gesturestart', onGestureStart);
        scroller.removeEventListener('gesturechange', onGestureChange);
        scroller.removeEventListener('gestureend', onGestureEnd);
        scroller.removeEventListener('touchstart', onTouchStart);
        scroller.removeEventListener('touchmove', onTouchMove);
        scroller.removeEventListener('touchend', onTouchEnd);
      },
    };
  }

  function bindExcerpts(root, states) {
    for (const figure of root.querySelectorAll('[data-pdf-excerpt]')) {
      const source = figure.querySelector('img');
      const scroller = figure.querySelector('.pdf-zoom-scroll');
      const page = figure.querySelector('.pdf-zoom-page');
      const id = figure.dataset.pdfExcerpt;
      const state = states[id] ||= { zoom: 100, trim: false };
      bindZoom(figure, scroller, page, source, state, () => ({
        width: source.naturalWidth, height: source.naturalHeight,
      }));
    }
  }

  function disposeInline() {
    if (!inlineBatch) return;
    inlineBatch.cancelled = true;
    for (const h of inlineBatch.handles) {
      h.render?.cancel?.();
      h.text?.cancel?.();
      h.release?.();
    }
    // Keep parsed PDFDocumentProxies warm in docCache so revisiting or switching tabs is instantaneous!
    inlineBatch = null;
  }

  function dispose() {
    disposeInline();
    if (!active) return;
    active.cancelled = true;
    active.render?.cancel?.();
    active.text?.cancel?.();
    active.release?.();
    // Keep parsed PDFDocumentProxy warm in docCache!
    active = null;
  }

  function mountTextLayerAsync(pdf, page, content, viewport, range, textEl, handle, isStillValid, highlightTerm = '') {
    if (!textEl) return;
    const renderLayer = async () => {
      const resolvedContent = content || await page.getTextContent().catch(() => null);
      if (!resolvedContent || !isStillValid()) return null;
      textEl.replaceChildren();
      textEl.style.width = `${viewport.width}px`;
      textEl.style.height = `${viewport.height}px`;
      textEl.style.setProperty('--total-scale-factor', viewport.scale);
      textEl.style.setProperty('--scale-factor', viewport.scale);
      const filtered = { ...resolvedContent, items: itemsInRange(resolvedContent, viewport, range) };
      handle.text = new pdf.TextLayer({ textContentSource: filtered, container: textEl, viewport });
      await handle.text.render().catch(() => {});
      if (highlightTerm && isStillValid()) {
        highlightSearchSpans(textEl, highlightTerm);
      }
      return resolvedContent;
    };
    return renderLayer();
  }

  function highlightSearchSpans(textEl, term) {
    if (!textEl) return;
    const needle = String(term || '').trim().toLowerCase();
    for (const span of textEl.querySelectorAll('span')) {
      const hit = Boolean(needle && (span.textContent || '').toLowerCase().includes(needle));
      span.classList.toggle('pdf-search-hit', hit);
    }
  }

  // Background pre-render of a single page into bitmapCache so Next/Prev and next-question open in < 2ms
  async function preRenderPage(source, pageNum, opts = {}) {
    const dKey = docKeyFor(source);
    if (!dKey) return;
    const isInline = Boolean(opts.inline);
    const pKey = `${dKey}#p${pageNum}:${isInline ? 'inl' : 'doc'}`;
    if (prefetchQueue.has(pKey)) return;
    prefetchQueue.add(pKey);
    try {
      const pdf = await pdfEngine();
      const doc = await getCachedDoc(source);
      if (!doc || pageNum < 1 || pageNum > doc.numPages) return;
      const page = await doc.getPage(pageNum);
      let range = [0, 1];
      let content = null;
      if (isInline) {
        const res = await resolveCropRange(source, page);
        range = res.range;
        content = res.content;
      }
      const cKey = renderCacheKey(dKey, pageNum, range, isInline);
      if (getBitmap(cKey)) return;

      const original = page.getViewport({ scale: 1 });
      const scale = computeRenderScale(original, opts.targetWidth || 720, isInline ? 2.2 : 2.5);
      const viewport = page.getViewport({ scale });
      const top = Math.floor(viewport.height * range[0]);
      const bottom = Math.ceil(viewport.height * range[1]);
      const offscreen = document.createElement('canvas');
      offscreen.width = Math.ceil(viewport.width);
      offscreen.height = Math.max(1, bottom - top);
      await page.render({ canvas: offscreen, viewport, transform: [1, 0, 0, 1, 0, -top] }).promise;
      touchBitmap(cKey, {
        canvas: offscreen,
        width: offscreen.width,
        height: offscreen.height,
        viewportScale: viewport.scale,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        range,
        top,
        trimBounds: null,
        numPages: doc.numPages,
        textContent: content,
      });
    } catch {
      // Prefetch is strictly best-effort
    } finally {
      prefetchQueue.delete(pKey);
    }
  }

  function prefetch(sources = [], opts = {}) {
    if (!Array.isArray(sources) || !sources.length) return;
    warm();
    const list = sources.filter((s) => s && s.isPdf).slice(0, 3);
    if (!list.length) return;
    const run = async () => {
      for (const src of list) {
        await preRenderPage(src, Math.max(1, Number(src.page) || 1), {
          inline: opts.inline !== false,
          targetWidth: opts.targetWidth || 720,
        });
      }
    };
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));
    idle(() => { run().catch(() => {}); });
  }

  async function mountInlineFigures(container, items, states = {}) {
    disposeInline();
    if (!container || !Array.isArray(items) || !items.length) return;
    const batch = { cancelled: false, handles: [], docKeys: new Set() };
    inlineBatch = batch;

    // Frame-0 synchronous paint for cached pages — eliminates ANY flicker on Hint/Reveal/Tab/Next!
    const prepared = items.map((item) => {
      const escKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(item.key) : item.key.replace(/"/g, '\\"');
      const figure = container.querySelector(`[data-inline-pdf-key="${escKey}"]`);
      if (!figure || !figure.isConnected) return null;
      const notice = figure.querySelector('[data-pdf-status]');
      const canvas = figure.querySelector('canvas');
      const scroll = figure.querySelector('.pdf-zoom-scroll');
      const paper = figure.querySelector('.pdf-zoom-page');
      const text = figure.querySelector('.textLayer');
      const pagerWrap = figure.querySelector('[data-inline-pager]');
      const prevBtn = figure.querySelector('[data-inline-prev]');
      const nextBtn = figure.querySelector('[data-inline-next]');
      const pageLbl = figure.querySelector('[data-inline-page-lbl]');
      const cropBtn = figure.querySelector('[data-inline-crop-toggle]');
      const fullBtn = figure.querySelector('[data-open-inline-pdf]');
      const invertBtn = figure.querySelector('[data-inline-invert]');
      if (!canvas || !scroll || !paper) return null;

      const dKey = docKeyFor(item.source);
      batch.docKeys.add(dKey);
      const state = (states[item.key] ||= {
        zoom: 100,
        trim: true,
        page: Math.max(1, Number(item.page) || 1),
        showFullPage: false,
        invert: false,
      });
      if (state.invert) scroll.classList.add('pdf-ink-inverted');
      if (invertBtn) {
        invertBtn.classList.toggle('active', Boolean(state.invert));
        invertBtn.onclick = () => {
          state.invert = !state.invert;
          invertBtn.classList.toggle('active', state.invert);
          scroll.classList.toggle('pdf-ink-inverted', state.invert);
        };
      }

      const handle = { render: null, text: null, release: null };
      batch.handles.push(handle);

      // Synchronous Frame-0 cache hit check
      const basePage = Math.max(1, Number(item.page) || 1);
      const knownSaved = state.page === basePage ? savedRange(item.source, state.page) : null;
      const canFastCrop = Boolean(knownSaved && (knownSaved[0] > 0.01 || knownSaved[1] < 0.99));
      const fastRange = (canFastCrop && !state.showFullPage) ? knownSaved : [0, 1];
      const fastHit = getBitmap(renderCacheKey(dKey, state.page, fastRange, true))
        || (fastRange[0] <= 0.005 && fastRange[1] >= 0.995 ? getBitmap(renderCacheKey(dKey, state.page, [0, 1], false)) : null);

      if (fastHit) {
        canvas.width = fastHit.width;
        canvas.height = fastHit.height;
        canvas.getContext('2d').drawImage(fastHit.canvas, 0, 0);
        geometry.delete(canvas);
        figure.dataset.excerptReady = 'true';
        if (notice) notice.hidden = true;
        if (pagerWrap && fastHit.numPages > 1) {
          pagerWrap.hidden = false;
          if (pageLbl) pageLbl.textContent = `${state.page} / ${fastHit.numPages}`;
          if (prevBtn) prevBtn.disabled = state.page <= 1;
          if (nextBtn) nextBtn.disabled = state.page >= fastHit.numPages;
        }
        if (cropBtn) {
          cropBtn.hidden = !canFastCrop;
          cropBtn.textContent = state.showFullPage ? 'Crop Q' : 'Full page';
        }
        if (fullBtn) {
          fullBtn.title = `Open full multi-page PDF reader (p.${state.page})`;
          fullBtn.dataset.openInlinePage = String(state.page);
        }
        const boundsGetter = (surf, w, h) => {
          if (!fastHit.trimBounds) fastHit.trimBounds = boundsOf(surf, w, h);
          return fastHit.trimBounds;
        };
        const zoom = bindZoom(figure, scroll, paper, canvas, state, () => ({ width: fastHit.width, height: fastHit.height }), text, fastHit.top || 0, boundsGetter);
        handle.release = zoom.release;
      }

      return {
        item, figure, notice, canvas, scroll, paper, text,
        pagerWrap, prevBtn, nextBtn, pageLbl, cropBtn, fullBtn,
        dKey, state, handle, fastHit,
      };
    }).filter(Boolean);

    if (!prepared.length) return;

    let pdf;
    try {
      pdf = await pdfEngine();
    } catch {
      return;
    }
    if (batch.cancelled || inlineBatch !== batch || !container.isConnected) return;

    await Promise.all(
      prepared.map(async (ctx) => {
        const {
          item, figure, notice, canvas, scroll, paper, text,
          pagerWrap, prevBtn, nextBtn, pageLbl, cropBtn, fullBtn,
          dKey, state, handle,
        } = ctx;
        let renderSeq = 0;

        async function drawInlinePage(targetPage, forceFullPage = false) {
          const seq = ++renderSeq;
          handle.render?.cancel?.();
          handle.text?.cancel?.();
          const isValid = () => !batch.cancelled && inlineBatch === batch && figure.isConnected && seq === renderSeq;

          try {
            const doc = await getCachedDoc(item.source);
            if (!isValid()) return;
            const clamped = Math.max(1, Math.min(doc.numPages, Number(targetPage) || 1));
            state.page = clamped;

            if (pagerWrap && doc.numPages > 1) {
              pagerWrap.hidden = false;
              if (pageLbl) pageLbl.textContent = `${clamped} / ${doc.numPages}`;
              if (prevBtn) prevBtn.disabled = clamped <= 1;
              if (nextBtn) nextBtn.disabled = clamped >= doc.numPages;
            }
            if (fullBtn) {
              fullBtn.title = `Open full multi-page PDF reader (p.${clamped})`;
              fullBtn.dataset.openInlinePage = String(clamped);
            }

            const page = await doc.getPage(clamped);
            if (!isValid()) return;

            const cropInfo = clamped === (Math.max(1, Number(item.page) || 1))
              ? await resolveCropRange(item.source, page)
              : { range: [0, 1], isCropped: false, content: null };
            if (!isValid()) return;

            const canToggleCrop = Boolean(cropInfo.isCropped);
            const activeRange = (canToggleCrop && !forceFullPage) ? cropInfo.range : [0, 1];
            if (cropBtn) {
              cropBtn.hidden = !canToggleCrop;
              cropBtn.textContent = forceFullPage ? 'Crop Q' : 'Full page';
              cropBtn.title = forceFullPage ? 'Crop back to question excerpt' : 'Expand to full PDF page';
            }

            const cKey = renderCacheKey(dKey, clamped, activeRange, true);
            const cached = getBitmap(cKey)
              || (activeRange[0] <= 0.005 && activeRange[1] >= 0.995 ? getBitmap(renderCacheKey(dKey, clamped, [0, 1], false)) : null);
            let paintWidth = 0;
            let paintHeight = 0;
            let viewport;
            let top = 0;
            let cacheEntry = cached;

            if (cached) {
              if (ctx.fastHit !== cached || canvas.width !== cached.width || canvas.height !== cached.height) {
                canvas.width = cached.width;
                canvas.height = cached.height;
                canvas.getContext('2d').drawImage(cached.canvas, 0, 0);
                geometry.delete(canvas);
              }
              ctx.fastHit = null;
              paintWidth = cached.width;
              paintHeight = cached.height;
              top = cached.top || 0;
              viewport = page.getViewport({ scale: cached.viewportScale });
            } else {
              ctx.fastHit = null;
              if (notice && !figure.dataset.excerptReady) {
                notice.textContent = 'Rendering page…';
                notice.hidden = false;
              }
              const original = page.getViewport({ scale: 1 });
              const scale = computeRenderScale(original, scroll.clientWidth || figure.clientWidth || 720, 2.2);
              viewport = page.getViewport({ scale });
              top = Math.floor(viewport.height * activeRange[0]);
              const bottom = Math.ceil(viewport.height * activeRange[1]);
              canvas.width = Math.ceil(viewport.width);
              canvas.height = Math.max(1, bottom - top);
              handle.render = page.render({ canvas, viewport, transform: [1, 0, 0, 1, 0, -top] });
              await handle.render.promise;
              if (!isValid()) return;
              paintWidth = canvas.width;
              paintHeight = canvas.height;
              geometry.delete(canvas);
              cacheEntry = {
                canvas: snapshotCanvas(canvas),
                width: paintWidth,
                height: paintHeight,
                viewportScale: viewport.scale,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                range: activeRange,
                top,
                trimBounds: null,
                numPages: doc.numPages,
                textContent: cropInfo.content || null,
              };
              touchBitmap(cKey, cacheEntry);
            }

            figure.dataset.excerptReady = 'true';
            if (notice) notice.hidden = true;
            handle.release?.();
            const boundsGetter = (surf, w, h) => {
              if (!cacheEntry.trimBounds) cacheEntry.trimBounds = boundsOf(surf, w, h);
              return cacheEntry.trimBounds;
            };
            const zoom = bindZoom(figure, scroll, paper, canvas, state, () => ({ width: paintWidth, height: paintHeight }), text, top, boundsGetter);
            handle.release = zoom.release;

            // Mount selectable text layer asynchronously AFTER the page is already visible!
            mountTextLayerAsync(pdf, page, cacheEntry.textContent, viewport, activeRange, text, handle, isValid)
              ?.then((resolved) => {
                if (resolved && !cacheEntry.textContent) cacheEntry.textContent = resolved;
              })
              .catch(() => {});

            // Pre-render the next page silently for instant inline flipping
            if (clamped < doc.numPages) {
              setTimeout(() => {
                if (isValid()) preRenderPage(item.source, clamped + 1, { inline: true, targetWidth: scroll.clientWidth || 720 });
              }, 80);
            }
          } catch {
            if (notice && isValid()) {
              notice.textContent = 'Could not render this page inline. Click Full PDF above to open it.';
              notice.hidden = false;
            }
          }
        }

        if (prevBtn) prevBtn.onclick = () => drawInlinePage(state.page - 1, state.showFullPage);
        if (nextBtn) nextBtn.onclick = () => drawInlinePage(state.page + 1, state.showFullPage);
        if (cropBtn) {
          cropBtn.onclick = () => {
            state.showFullPage = !state.showFullPage;
            drawInlinePage(state.page, state.showFullPage);
          };
        }

        // Seamless click-to-fullscreen on the inline PDF canvas (with crisp 2.6x background upgrade + Full PDF jump)
        let downPt = null;
        scroll.onpointerdown = (ev) => {
          if (ev.button === 0) downPt = { x: ev.clientX, y: ev.clientY };
        };
        scroll.onclick = (ev) => {
          if (ev.target?.closest?.('button, a, input, [data-pdf-zoom-reset]')) return;
          if (downPt && Math.hypot(ev.clientX - downPt.x, ev.clientY - downPt.y) > 6) return;
          const sel = window.getSelection?.()?.toString?.()?.trim();
          if (sel) return;
          if (!canvas.width || !canvas.height || !window.StudyUI?.openLightbox) return;
          let quickUrl = '';
          try { quickUrl = canvas.toDataURL('image/png'); } catch { return; }
          const activePage = state.page || 1;
          const wantFullPage = Boolean(state.showFullPage);
          const upgradePromise = (async () => {
            const doc = await getCachedDoc(item.source);
            const pg = await doc.getPage(Math.max(1, Math.min(doc.numPages, activePage)));
            const cropInfo = activePage === (Math.max(1, Number(item.page) || 1))
              ? await resolveCropRange(item.source, pg)
              : { range: [0, 1], isCropped: false };
            const rng = (cropInfo.isCropped && !wantFullPage) ? cropInfo.range : [0, 1];
            const vp = pg.getViewport({ scale: 2.6 });
            const topPx = Math.floor(vp.height * rng[0]);
            const botPx = Math.ceil(vp.height * rng[1]);
            const hi = document.createElement('canvas');
            hi.width = Math.ceil(vp.width);
            hi.height = Math.max(1, botPx - topPx);
            await pg.render({ canvas: hi, viewport: vp, transform: [1, 0, 0, 1, 0, -topPx] }).promise;
            return hi.toDataURL('image/png');
          })();
          window.StudyUI.openLightbox(quickUrl, item.source?.label || `PDF page ${activePage}`, {
            isPdf: true,
            inverted: Boolean(state.invert),
            caption: `${item.source?.label || 'PDF preview'} · Pinch to zoom`,
            actionLabel: `Full PDF (p.${activePage})`,
            onAction: () => fullBtn?.click(),
            upgradePromise,
          });
        };

        await drawInlinePage(state.page, Boolean(state.showFullPage));
      })
    );
  }

  async function mount(root, source, state) {
    dispose();
    if (!root) return;
    const dKey = docKeyFor(source);
    const session = { docKey: dKey, cancelled: false, render: null, text: null, release: null };
    active = session;
    const notice = root.querySelector('[data-pdf-status]');
    const canvas = root.querySelector('canvas');
    const pageForm = root.querySelector('[data-pdf-page-form]');
    const pageField = pageForm?.elements?.page;
    const scroll = root.querySelector('.pdf-zoom-scroll');
    const paper = root.querySelector('.pdf-zoom-page');
    const text = root.querySelector('.textLayer');
    const searchToggle = root.querySelector('[data-pdf-search-toggle]');
    const searchBar = root.querySelector('[data-pdf-search-bar]');
    const searchInput = root.querySelector('[data-pdf-search-input]');
    const searchCount = root.querySelector('[data-pdf-search-count]');
    const searchPrev = root.querySelector('[data-pdf-search-prev]');
    const searchNext = root.querySelector('[data-pdf-search-next]');
    const searchClose = root.querySelector('[data-pdf-search-close]');

    if (!canvas || !pageForm || !scroll || !paper) return;

    const editCraftBtn = root.querySelector('[data-pdf-edit-craft]');
    if (editCraftBtn && window.StudyPdfCraft?.openSource) {
      editCraftBtn.onclick = () => {
        window.StudyPdfCraft.openSource(source, {
          onSaved: (savedRec) => {
            if (savedRec?.key && root.isConnected) {
              const updated = { ...source, localSourceKey: savedRec.key, memberAsset: null };
              mount(root, updated, state);
            }
          },
        });
      };
    }

    const initialTarget = Math.max(1, Number(state.page || source.page) || 1);
    const initialHit = getBitmap(renderCacheKey(dKey, initialTarget, [0, 1], false))
      || getBitmap(renderCacheKey(dKey, initialTarget, [0, 1], true));
    if (initialHit) {
      // Frame-0 instant paint when switching Task -> Full PDF or revisiting a page!
      canvas.width = initialHit.width;
      canvas.height = initialHit.height;
      canvas.getContext('2d').drawImage(initialHit.canvas, 0, 0);
      geometry.delete(canvas);
      if (notice) notice.hidden = true;
      if (initialHit.numPages) {
        pageField.max = initialHit.numPages;
        const cntEl = root.querySelector('[data-pdf-page-count]');
        if (cntEl) cntEl.textContent = `/ ${initialHit.numPages}`;
      }
      const fastZoom = bindZoom(root, scroll, paper, canvas, state,
        () => ({ width: initialHit.width, height: initialHit.height }), text, 0,
        (surf, w, h) => {
          if (!initialHit.trimBounds) initialHit.trimBounds = boundsOf(surf, w, h);
          return initialHit.trimBounds;
        });
      session.release = fastZoom.release;
    } else if (notice) {
      notice.textContent = 'Loading PDF…';
      notice.hidden = false;
    }

    try {
      const pdf = await pdfEngine();
      if (active !== session || !root.isConnected) return;
      const doc = await getCachedDoc(source);
      if (active !== session || !root.isConnected) return;
      const docEntry = docCache.get(dKey);
      session.release?.();

      pageField.max = doc.numPages;
      root.querySelector('[data-pdf-page-count]').textContent = `/ ${doc.numPages}`;
      let sequence = 0;
      let paintWidth = initialHit ? initialHit.width : 0;
      let paintHeight = initialHit ? initialHit.height : 0;
      let activeCacheEntry = initialHit || null;
      let currentSearchTerm = '';
      let searchMatches = []; // [{ page }]
      let searchIdx = -1;
      let searchSeq = 0;

      const boundsGetter = (surf, w, h) => {
        if (activeCacheEntry) {
          if (!activeCacheEntry.trimBounds) activeCacheEntry.trimBounds = boundsOf(surf, w, h);
          return activeCacheEntry.trimBounds;
        }
        return boundsOf(surf, w, h);
      };

      const zoom = bindZoom(root, scroll, paper, canvas, state,
        () => ({ width: paintWidth, height: paintHeight }), text, 0, boundsGetter);

      const onKeyDown = (event) => {
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(event.target.tagName)) return;
        if (event.key === '[' || event.key === 'ArrowLeft') {
          if (state.page > 1) { event.preventDefault(); showPage(state.page - 1); }
        } else if (event.key === ']' || event.key === 'ArrowRight') {
          if (state.page < doc.numPages) { event.preventDefault(); showPage(state.page + 1); }
        } else if (event.key === '/' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f')) {
          event.preventDefault();
          openSearch();
        }
      };
      scroll.addEventListener('keydown', onKeyDown);
      session.release = () => {
        zoom.release();
        scroll.removeEventListener('keydown', onKeyDown);
      };

      async function showPage(target) {
        const turn = ++sequence;
        session.render?.cancel?.();
        session.text?.cancel?.();
        text.replaceChildren();
        state.page = Math.max(1, Math.min(doc.numPages, Number(target) || 1));
        pageField.value = state.page;
        root.querySelector('[data-pdf-prev]').disabled = state.page <= 1;
        root.querySelector('[data-pdf-next]').disabled = state.page >= doc.numPages;
        const isValid = () => turn === sequence && active === session && root.isConnected;

        const cKey = renderCacheKey(dKey, state.page, [0, 1], false);
        const cached = getBitmap(cKey) || getBitmap(renderCacheKey(dKey, state.page, [0, 1], true));
        if (!cached && notice) {
          notice.textContent = 'Rendering page…';
          notice.hidden = false;
        }

        try {
          const page = await doc.getPage(state.page);
          if (!isValid()) return;
          let viewport;
          let cacheEntry = cached;

          if (cached) {
            canvas.width = cached.width;
            canvas.height = cached.height;
            canvas.getContext('2d').drawImage(cached.canvas, 0, 0);
            paintWidth = cached.width;
            paintHeight = cached.height;
            viewport = page.getViewport({ scale: cached.viewportScale });
            geometry.delete(canvas);
          } else {
            const original = page.getViewport({ scale: 1 });
            const scale = computeRenderScale(original, scroll.clientWidth || 780, 2.6);
            viewport = page.getViewport({ scale });
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            session.render = page.render({ canvas, viewport });
            await session.render.promise;
            if (!isValid()) return;
            paintWidth = canvas.width;
            paintHeight = canvas.height;
            geometry.delete(canvas);
            cacheEntry = {
              canvas: snapshotCanvas(canvas),
              width: paintWidth,
              height: paintHeight,
              viewportScale: viewport.scale,
              viewportWidth: viewport.width,
              viewportHeight: viewport.height,
              range: [0, 1],
              top: 0,
              trimBounds: null,
              numPages: doc.numPages,
              textContent: null,
            };
            touchBitmap(cKey, cacheEntry);
          }

          activeCacheEntry = cacheEntry;
          scroll.scrollTo(0, 0);
          zoom.paint();
          if (notice) notice.hidden = true;

          // Mount selectable text layer asynchronously (and apply search highlight if searching)
          mountTextLayerAsync(pdf, page, cacheEntry.textContent, viewport, [0, 1], text, session, isValid, currentSearchTerm)
            ?.then((resolved) => {
              if (resolved && !cacheEntry.textContent) cacheEntry.textContent = resolved;
            })
            .catch(() => {});

          // Pre-render adjacent pages (+1, -1) silently so flipping pages is 0ms instant!
          const cur = state.page;
          setTimeout(() => {
            if (!isValid()) return;
            const w = scroll.clientWidth || 780;
            if (cur < doc.numPages) preRenderPage(source, cur + 1, { inline: false, targetWidth: w });
            if (cur > 1) preRenderPage(source, cur - 1, { inline: false, targetWidth: w });
          }, 60);
        } catch {
          if (isValid() && notice) {
            notice.textContent = 'This page could not be rendered.';
            notice.hidden = false;
          }
        }
      }

      // Fast incremental In-PDF text search
      function updateSearchUi() {
        if (!searchCount) return;
        if (!currentSearchTerm) {
          searchCount.textContent = '';
          if (searchPrev) searchPrev.disabled = true;
          if (searchNext) searchNext.disabled = true;
          return;
        }
        if (!searchMatches.length) {
          searchCount.textContent = '0 matches';
          if (searchPrev) searchPrev.disabled = true;
          if (searchNext) searchNext.disabled = true;
        } else {
          searchCount.textContent = `${searchIdx + 1} / ${searchMatches.length} (p.${searchMatches[searchIdx].page})`;
          if (searchPrev) searchPrev.disabled = searchMatches.length <= 1;
          if (searchNext) searchNext.disabled = searchMatches.length <= 1;
        }
      }

      function jumpSearchMatch(delta) {
        if (!searchMatches.length) return;
        searchIdx = (searchIdx + delta + searchMatches.length) % searchMatches.length;
        updateSearchUi();
        showPage(searchMatches[searchIdx].page);
      }

      async function runPdfSearch(rawQuery) {
        const seq = ++searchSeq;
        const term = String(rawQuery || '').trim().toLowerCase();
        currentSearchTerm = term;
        searchMatches = [];
        searchIdx = -1;
        highlightSearchSpans(text, term);
        if (!term || term.length < 2) {
          updateSearchUi();
          return;
        }
        if (searchCount) searchCount.textContent = 'Searching…';
        const textMap = docEntry?.textByPage || new Map();
        const total = doc.numPages;
        // Start scanning from current page wrapping around so the nearest match jumps immediately
        const order = [];
        for (let offset = 0; offset < total; offset++) {
          order.push(((state.page - 1 + offset) % total) + 1);
        }
        let jumpedFirst = false;
        for (let i = 0; i < order.length; i++) {
          if (seq !== searchSeq || active !== session || !root.isConnected) return;
          const p = order[i];
          let txt = textMap.get(p);
          if (txt === undefined) {
            try {
              const pg = await doc.getPage(p);
              const tc = await pg.getTextContent();
              txt = tc.items.map((it) => it.str || '').join(' ').toLowerCase();
              textMap.set(p, txt);
            } catch {
              txt = '';
            }
          }
          if (seq !== searchSeq || active !== session || !root.isConnected) return;
          if (txt.includes(term)) {
            searchMatches.push({ page: p });
            if (!jumpedFirst) {
              jumpedFirst = true;
              searchIdx = 0;
              if (p !== state.page) showPage(p);
              else highlightSearchSpans(text, term);
            }
            updateSearchUi();
          }
          if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
        }
        if (seq === searchSeq && active === session) updateSearchUi();
      }

      function openSearch() {
        if (!searchBar) return;
        searchBar.hidden = false;
        searchToggle?.setAttribute('aria-expanded', 'true');
        searchToggle?.classList.add('active');
        searchInput?.focus();
        searchInput?.select();
      }

      function closeSearch() {
        if (!searchBar) return;
        searchBar.hidden = true;
        searchToggle?.setAttribute('aria-expanded', 'false');
        searchToggle?.classList.remove('active');
        currentSearchTerm = '';
        searchMatches = [];
        searchIdx = -1;
        highlightSearchSpans(text, '');
      }

      let searchTimer = null;
      searchToggle?.addEventListener('click', () => {
        if (searchBar?.hidden) openSearch();
        else closeSearch();
      });
      searchClose?.addEventListener('click', closeSearch);
      searchPrev?.addEventListener('click', () => jumpSearchMatch(-1));
      searchNext?.addEventListener('click', () => jumpSearchMatch(1));
      searchInput?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runPdfSearch(searchInput.value), 160);
      });
      searchInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (searchMatches.length) jumpSearchMatch(ev.shiftKey ? -1 : 1);
          else runPdfSearch(searchInput.value);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          closeSearch();
        }
      });

      pageForm.addEventListener('submit', (event) => { event.preventDefault(); showPage(pageField.value); });
      root.querySelector('[data-pdf-prev]').onclick = () => showPage(state.page - 1);
      root.querySelector('[data-pdf-next]').onclick = () => showPage(state.page + 1);
      await showPage(initialTarget);
    } catch {
      if (active === session && root.isConnected && notice) {
        notice.textContent = 'Could not render this document. Use the original PDF link or download.';
        notice.hidden = false;
      }
    }
  }

  async function extractFileText(file, maxChars = 14500, maxPages = 24) {
    if (!file) throw new Error('Choose a PDF file first.');
    const pdf = await pdfEngine();
    const data = new Uint8Array(await file.arrayBuffer());
    const task = pdf.getDocument({ data, disableAutoFetch: true });
    try {
      const doc = await task.promise;
      const totalPages = Math.max(1, Number(doc.numPages) || 1);
      const pageCount = Math.min(totalPages, maxPages);
      const chunks = [];
      let total = 0;
      for (let p = 1; p <= pageCount && total < maxChars; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const text = (content.items || []).map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
        if (text) {
          const piece = `[Page ${p}] ${text}`;
          chunks.push(piece);
          total += piece.length + 2;
        }
      }
      return {
        text: chunks.join('\n\n').slice(0, maxChars),
        pagesRead: pageCount,
        totalPages,
      };
    } finally {
      task.destroy().catch(() => {});
    }
  }

  return {
    warm,
    prefetch,
    clearCache,
    toolbar,
    viewer,
    bindExcerpts,
    mount,
    mountInlineFigures,
    dispose,
    disposeInline,
    extractFileText,
    hasSavedExcerpt: source => Boolean(savedRange(source, source.page)),
    textForPage,
    clearText: () => pageText.clear(),
  };
})();
