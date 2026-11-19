'use strict';

window.StudyPdf = (() => {
  const vendor = new URL('../vendor/pdfjs/', document.currentScript.src);
  let engine;
  let active;
  const geometry = new WeakMap();

  function pdfEngine() {
    if (!engine) {
      engine = import(new URL('pdf.min.mjs', vendor).href).then((pdf) => {
        pdf.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;
        return pdf;
      });
    }
    return engine;
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
      root.querySelector('[data-pdf-level]').textContent = state.zoom + '%';
      for (const button of root.querySelectorAll('[data-pdf-fit]')) {
        const selected = (button.dataset.pdfFit === 'content') === Boolean(state.trim);
        button.setAttribute('aria-pressed', String(selected));
        button.classList.toggle('active', selected);
      }
    }

    function zoomBy(amount) {
      const old = state.zoom;
      const x = scroller.scrollLeft + scroller.clientWidth / 2;
      const y = scroller.scrollTop + scroller.clientHeight / 2;
      state.zoom = Math.max(60, Math.min(300, old + amount));
      paint();
      scroller.scrollLeft = x * state.zoom / old - scroller.clientWidth / 2;
      scroller.scrollTop = y * state.zoom / old - scroller.clientHeight / 2;
    }

    for (const button of root.querySelectorAll('[data-pdf-scale], [data-pdf-fit]')) {
      button.addEventListener('click', () => {
        if (button.dataset.pdfFit) {
          state.trim = button.dataset.pdfFit === 'content';
          state.zoom = 100;
          paint();
          scroller.scrollTo(0, 0);
        } else zoomBy(button.dataset.pdfScale === '+' ? 25 : -25);
      });
    }
    scroller.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 10 : -10);
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

  function dispose() {
    if (!active) return;
    active.render?.cancel();
    active.text?.cancel();
    active.release?.();
    active.task?.destroy().catch(() => {});
    active = null;
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
      const input = source.memberAsset
        ? { data: new Uint8Array(await window.StudyMembers.pdfBytes(source.memberAsset.id)) }
        : { url: source.rawUrl };
      if (active !== session || !root.isConnected) return;
      session.task = pdf.getDocument({
        ...input,
        cMapUrl: new URL('cmaps/', vendor).href, cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', vendor).href,
        wasmUrl: new URL('wasm/', vendor).href,
        isEvalSupported: false,
      });
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

  return { toolbar, bindExcerpts, mount, dispose };
})();
