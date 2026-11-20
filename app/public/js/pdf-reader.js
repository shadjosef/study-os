'use strict';

window.StudyPdf = (() => {
  const vendor = new URL('../vendor/pdfjs/', document.currentScript.src);
  let engine;
  let active;
  let inlineBatch = null;
  const geometry = new WeakMap();
  const pageText = new Map();

  function pdfEngine() {
    if (!engine) {
      engine = import(new URL('pdf.min.mjs', vendor).href).then((pdf) => {
        pdf.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;
        return pdf;
      });
    }
    return engine;
  }

  async function documentOptions(source) {
    const input = source.memberAsset
      ? { data: new Uint8Array(await window.StudyMembers.pdfBytes(source.memberAsset.id)) }
      : source.localSourceKey
      ? { data: new Uint8Array(await window.StudyLocalSources.getBytes(source.localSourceKey)) }
      : { url: source.rawUrl };
    return {
      ...input,
      cMapUrl: new URL('cmaps/', vendor).href, cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', vendor).href,
      wasmUrl: new URL('wasm/', vendor).href,
      isEvalSupported: false,
    };
  }

  async function readPageText(source) {
    const pdf = await pdfEngine();
    const task = pdf.getDocument(await documentOptions(source));
    try {
      const doc = await task.promise;
      const page = await doc.getPage(source.page);
      const { items } = await page.getTextContent();
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
    } finally {
      await task.destroy().catch(() => {});
    }
  }

  function textForPage(source) {
    if (!pageText.has(source.key)) {
      const pending = readPageText(source).catch((error) => {
        if (pageText.get(source.key) === pending) pageText.delete(source.key);
        throw error;
      });
      pageText.set(source.key, pending);
      if (pageText.size > 20) pageText.delete(pageText.keys().next().value);
    }
    return pageText.get(source.key);
  }

  function boundsOf(surface, width, height) {
    if (geometry.has(surface)) return geometry.get(surface);
    const sampling = Math.min(1, 640 / Math.max(width, height));
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

  function toolbar() {
    return `<div class="pdf-zoom-tools" aria-label="Document zoom">
      <button type="button" class="mini-tool-btn" data-pdf-scale="-" aria-label="Zoom out">−</button>
      <span data-pdf-level>100%</span>
      <button type="button" class="mini-tool-btn" data-pdf-scale="+" aria-label="Zoom in">+</button>
      <button type="button" class="mini-tool-btn" data-pdf-fit="page">Fit width</button>
      <button type="button" class="mini-tool-btn" data-pdf-fit="content">Trim margins</button>
    </div>`;
  }

  function viewer(page = 1, invert = false) {
    return `<div class="pdf-page-tools">
      <button type="button" class="mini-tool-btn" data-pdf-prev aria-label="Previous PDF page">‹</button>
      <form data-pdf-page-form><label>Page <input name="page" type="number" min="1" value="${Number(page) || 1}"></label>
        <button type="submit" class="mini-tool-btn">Go</button></form>
      <span data-pdf-page-count></span>
      <button type="button" class="mini-tool-btn" data-pdf-next aria-label="Next PDF page">›</button>
    </div>
    ${toolbar()}
    <p class="muted pdf-status" data-pdf-status role="status">Loading PDF…</p>
    <div class="pdf-zoom-scroll pdf-document-scroll ${invert ? 'pdf-ink-inverted' : ''}" tabindex="0" aria-label="Scrollable source PDF">
      <div class="pdf-zoom-page"><canvas aria-hidden="true"></canvas><div class="textLayer"></div></div>
    </div>`;
  }

  function bindZoom(root, scroller, paper, surface, state, sourceSize, textLayer) {
    function paint() {
      const { width, height } = sourceSize();
      if (!width || !height || !scroller.clientWidth) return;
      const full = { x: 0, y: 0, width, height };
      let box = full;
      if (state.trim) {
        try { box = boundsOf(surface, width, height); } catch {}
      }
      const scale = scroller.clientWidth / box.width * state.zoom / 100;
      paper.style.width = `${box.width * scale}px`;
      paper.style.height = `${box.height * scale}px`;
      if (textLayer) {
        textLayer.style.transform = `translate(${-box.x * scale}px, ${-box.y * scale}px) scale(${scale})`;
      }
      Object.assign(surface.style, {
        width: `${width * scale}px`, height: `${height * scale}px`,
        maxWidth: 'none', left: `${-box.x * scale}px`, top: `${-box.y * scale}px`,
      });
      root.querySelector('[data-pdf-level]').textContent = Math.round(state.zoom) + '%';
      for (const button of root.querySelectorAll('[data-pdf-fit]')) {
        const selected = (button.dataset.pdfFit === 'content') === Boolean(state.trim);
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('active', selected);
      }
    }

    function setZoom(level, clientX, clientY) {
      const old = state.zoom;
      const next = Math.max(60, Math.min(300, level));
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
      button.addEventListener('click', () => {
        if (button.dataset.pdfFit) {
          state.trim = button.dataset.pdfFit === 'content';
          state.zoom = 100;
          paint();
          scroller.scrollTo(0, 0);
        } else setZoom(Math.round(state.zoom) + (button.dataset.pdfScale === '+' ? 25 : -25));
      });
    }
    scroller.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
      setZoom(state.zoom * Math.exp(-event.deltaY * unit / 100), event.clientX, event.clientY);
    }, { passive: false });

    // Safari exposes trackpad pinch as a cumulative scale instead of a wheel delta.
    let gestureZoom;
    scroller.addEventListener('gesturestart', (event) => {
      event.preventDefault();
      gestureZoom = state.zoom;
    }, { passive: false });
    scroller.addEventListener('gesturechange', (event) => {
      if (gestureZoom == null || !Number.isFinite(event.scale)) return;
      event.preventDefault();
      setZoom(gestureZoom * event.scale, event.clientX, event.clientY);
    }, { passive: false });
    scroller.addEventListener('gestureend', (event) => {
      if (gestureZoom == null) return;
      event.preventDefault();
      gestureZoom = undefined;
    }, { passive: false });

    const observer = new ResizeObserver(() => {
      if (root.isConnected) paint();
      else observer.disconnect();
    });
    observer.observe(scroller);
    if (surface instanceof HTMLImageElement) surface.addEventListener('load', paint);
    paint();
    return { paint, release: () => observer.disconnect() };
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
    for (const task of inlineBatch.tasks) {
      task.destroy().catch(() => {});
    }
    inlineBatch = null;
  }

  function dispose() {
    disposeInline();
    if (!active) return;
    active.render?.cancel();
    active.text?.cancel();
    active.release?.();
    active.task?.destroy().catch(() => {});
    active = null;
  }

  async function mountInlineFigures(container, items, states = {}) {
    disposeInline();
    if (!container || !Array.isArray(items) || !items.length) return;
    const batch = { cancelled: false, handles: [], tasks: [] };
    inlineBatch = batch;

    let pdf;
    try {
      pdf = await pdfEngine();
    } catch {
      return;
    }
    if (batch.cancelled || inlineBatch !== batch || !container.isConnected) return;

    // Group by underlying document so multi-page prompts (e.g. p.1 + p.2) parse the PDF only once
    const docsBySrc = new Map();
    const getDoc = async (source) => {
      const docKey = source.localSourceKey
        ? `local:${source.localSourceKey}`
        : source.memberAsset?.id
        ? `member:${source.memberAsset.id}`
        : `url:${source.rawUrl || ''}`;
      if (!docsBySrc.has(docKey)) {
        const pending = (async () => {
          const options = await documentOptions(source);
          if (batch.cancelled || inlineBatch !== batch) return null;
          const task = pdf.getDocument(options);
          batch.tasks.push(task);
          return task.promise;
        })();
        docsBySrc.set(docKey, pending);
      }
      return docsBySrc.get(docKey);
    };

    await Promise.all(
      items.map(async (item) => {
        const escKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(item.key) : item.key.replace(/"/g, '\\"');
        const figure = container.querySelector(`[data-inline-pdf-key="${escKey}"]`);
        if (!figure || !figure.isConnected) return;
        const notice = figure.querySelector('[data-pdf-status]');
        const canvas = figure.querySelector('canvas');
        const scroll = figure.querySelector('.pdf-zoom-scroll');
        const paper = figure.querySelector('.pdf-zoom-page');
        const text = figure.querySelector('.textLayer');
        if (!canvas || !scroll || !paper) return;

        try {
          const doc = await getDoc(item.source);
          if (!doc || batch.cancelled || inlineBatch !== batch || !figure.isConnected) return;
          const targetPage = Math.max(1, Math.min(doc.numPages, Number(item.page) || 1));
          const page = await doc.getPage(targetPage);
          if (batch.cancelled || inlineBatch !== batch || !figure.isConnected) return;
          const original = page.getViewport({ scale: 1 });
          const scale = Math.min(2.6, 2200 / Math.max(original.width, original.height));
          const viewport = page.getViewport({ scale });
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const renderTask = page.render({ canvas, viewport });
          const handle = { render: renderTask, text: null, release: null };
          batch.handles.push(handle);
          await renderTask.promise;
          if (batch.cancelled || inlineBatch !== batch || !figure.isConnected) return;

          const state = (states[item.key] ||= { zoom: 100, trim: true });
          const paintWidth = canvas.width;
          const paintHeight = canvas.height;
          geometry.delete(canvas);
          if (text) {
            text.replaceChildren();
            text.style.width = `${viewport.width}px`;
            text.style.height = `${viewport.height}px`;
            text.style.setProperty('--total-scale-factor', viewport.scale);
            text.style.setProperty('--scale-factor', viewport.scale);
            handle.text = new pdf.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
            handle.text.render().catch(() => {});
          }
          const zoom = bindZoom(figure, scroll, paper, canvas, state, () => ({ width: paintWidth, height: paintHeight }), text);
          handle.release = zoom.release;
          if (notice) notice.hidden = true;
        } catch {
          if (notice && !batch.cancelled && figure.isConnected) {
            notice.textContent = 'Could not render this page. Click In-App PDF to view.';
          }
        }
      })
    );
  }

  async function mount(root, source, state) {
    dispose();
    const session = {};
    active = session;
    const notice = root.querySelector('[data-pdf-status]');
    const canvas = root.querySelector('canvas');
    const pageForm = root.querySelector('[data-pdf-page-form]');
    const pageField = pageForm.elements.page;

    try {
      const pdf = await pdfEngine();
      if (active !== session || !root.isConnected) return;
      const options = await documentOptions(source);
      if (active !== session || !root.isConnected) return;
      session.task = pdf.getDocument(options);
      const doc = await session.task.promise;
      if (active !== session || !root.isConnected) return;
      pageField.max = doc.numPages;
      root.querySelector('[data-pdf-page-count]').textContent = `of ${doc.numPages}`;
      const scroll = root.querySelector('.pdf-zoom-scroll');
      const paper = root.querySelector('.pdf-zoom-page');
      const text = root.querySelector('.textLayer');
      let sequence = 0;
      let paintWidth = 0;
      let paintHeight = 0;
      const zoom = bindZoom(root, scroll, paper, canvas, state,
        () => ({ width: paintWidth, height: paintHeight }), text);
      session.release = zoom.release;

      async function showPage(target) {
        const turn = ++sequence;
        session.render?.cancel();
        session.text?.cancel();
        text.replaceChildren();
        state.page = Math.max(1, Math.min(doc.numPages, Number(target) || 1));
        pageField.value = state.page;
        root.querySelector('[data-pdf-prev]').disabled = state.page <= 1;
        root.querySelector('[data-pdf-next]').disabled = state.page >= doc.numPages;
        notice.textContent = 'Loading page…';
        try {
          const page = await doc.getPage(state.page);
          if (turn !== sequence || active !== session) return;
          const original = page.getViewport({ scale: 1 });
          const scale = Math.min(3, 2800 / Math.max(original.width, original.height));
          const viewport = page.getViewport({ scale });
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          session.render = page.render({ canvas, viewport });
          await session.render.promise;
          if (turn !== sequence || active !== session) return;
          paintWidth = canvas.width;
          paintHeight = canvas.height;
          geometry.delete(canvas);
          scroll.scrollTo(0, 0);
          text.style.width = `${viewport.width}px`;
          text.style.height = `${viewport.height}px`;
          text.style.setProperty('--total-scale-factor', viewport.scale);
          text.style.setProperty('--scale-factor', viewport.scale);
          session.text = new pdf.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
          session.text.render().catch(() => {});
          zoom.paint();
          notice.textContent = '';
        } catch (error) {
          if (turn === sequence && active === session) notice.textContent = 'This page could not be rendered.';
        }
      }
      pageForm.addEventListener('submit', (event) => { event.preventDefault(); showPage(pageField.value); });
      root.querySelector('[data-pdf-prev]').onclick = () => showPage(state.page - 1);
      root.querySelector('[data-pdf-next]').onclick = () => showPage(state.page + 1);
      await showPage(state.page || source.page);
    } catch (error) {
      if (active === session && root.isConnected) notice.textContent = 'Could not render this document. Use the original PDF link or download.';
    }
  }

  return { toolbar, viewer, bindExcerpts, mount, mountInlineFigures, dispose, disposeInline, textForPage, clearText: () => pageText.clear() };
})();
