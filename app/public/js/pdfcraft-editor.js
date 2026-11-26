/* Lazy-loaded PdfCraft (storytold/pdfcraft, Apache-2.0 / MIT) pure Rust WASM PDF Editor bridge.
 * Zero WASM/JS bytes are downloaded on initial Study-OS load — PdfCraft only loads when a user
 * clicks "Edit PDF" or launches PdfCraft from Quick Jump (⌘K).
 *
 * Uses the official same-origin `craft-web-host` (?host=parent) postMessage bridge:
 *   iframe -> parent : pdfcraft:ready, pdfcraft:save, pdfcraft:dirty, pdfcraft:failed
 *   parent -> iframe : pdfcraft:open { name, bytes }, pdfcraft:saved { id }
 */
'use strict';

window.StudyPdfCraft = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const bundledFlag = document.documentElement.dataset.pdfcraft === '1';
  let localProbeDone = false;
  let localAvailable = false;

  if (!bundledFlag && document.documentElement.dataset.studyMode !== 'web') {
    fetch('./pdfcraft/index.html', { method: 'HEAD', cache: 'no-store' })
      .then((res) => { localAvailable = Boolean(res && res.ok); })
      .catch(() => { localAvailable = false; })
      .finally(() => { localProbeDone = true; });
  }

  function isAvailable() {
    return bundledFlag || localAvailable;
  }

  function toast(msg) {
    if (window.StudyUI?.toast) window.StudyUI.toast(msg);
  }

  function ensurePdfName(raw) {
    let base = String(raw || '').trim().split('/').pop() || 'document.pdf';
    base = base.replace(/[\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    if (!base) base = 'document.pdf';
    if (!/\.pdf$/i.test(base)) base += '.pdf';
    return base.slice(0, 200);
  }

  function inferMime(filename) {
    const ext = String(filename || '').split('.').pop().toLowerCase();
    return {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      txt: 'text/plain;charset=utf-8',
      html: 'text/html;charset=utf-8',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip: 'application/zip',
    }[ext] || 'application/octet-stream';
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: inferMime(filename) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function currentAuthorName() {
    try {
      const nick = window.StudyCommunity?.profile?.()?.nickname
        || window.StudyCommunity?.getProfile?.()?.nickname
        || '';
      return String(nick || '').trim().slice(0, 80);
    } catch {
      return '';
    }
  }

  async function resolveSourceBytes(source) {
    if (!source) return null;
    if (source.localSourceKey && window.StudyLocalSources?.getBytes) {
      return window.StudyLocalSources.getBytes(source.localSourceKey);
    }
    if (source.memberAsset?.id && window.StudyMembers?.pdfBytes) {
      return window.StudyMembers.pdfBytes(source.memberAsset.id);
    }
    if (source.rawUrl) {
      const res = await fetch(source.rawUrl);
      if (!res.ok) throw new Error(`Could not load PDF (HTTP ${res.status}).`);
      return res.arrayBuffer();
    }
    throw new Error('This PDF source cannot be loaded into PdfCraft.');
  }

  let dialogEl = null;
  let session = null;

  function ensureDialog() {
    if (dialogEl) return dialogEl;
    const dlg = document.createElement('dialog');
    dlg.id = 'pdfcraft-dialog';
    dlg.className = 'pdfcraft-dialog';
    dlg.setAttribute('aria-labelledby', 'pdfcraft-dialog-title');
    dlg.innerHTML = `
      <header class="pdfcraft-bar">
        <div class="pdfcraft-bar-left">
          <span class="pdfcraft-brand" title="Powered by storytold/pdfcraft (Apache-2.0 / MIT)">PdfCraft</span>
          <strong id="pdfcraft-dialog-title" class="pdfcraft-doc-name">PDF Editor</strong>
          <span id="pdfcraft-status-pill" class="pdfcraft-pill" hidden></span>
        </div>
        <div class="pdfcraft-bar-actions">
          <button type="button" class="mini-tool-btn" id="pdfcraft-btn-download" title="Download PDF file" hidden>Download</button>
          <a class="mini-tool-btn pdfcraft-credit-link" href="./pdfcraft/NOTICE" target="_blank" rel="noopener nofollow" title="PdfCraft open-source license &amp; notices">OSS</a>
          <button type="button" class="mini-tool-btn pdfcraft-close-btn" id="pdfcraft-btn-close" title="Close PdfCraft (Esc)">Close</button>
        </div>
      </header>
      <div class="pdfcraft-stage" id="pdfcraft-stage">
        <div class="pdfcraft-overlay" id="pdfcraft-overlay">
          <div class="pdfcraft-spinner" aria-hidden="true"></div>
          <p class="pdfcraft-overlay-title" id="pdfcraft-overlay-title">Loading PdfCraft…</p>
          <p class="muted pdfcraft-overlay-sub" id="pdfcraft-overlay-sub">Pure Rust WebAssembly PDF workbench · cached in your browser after first open.</p>
          <div class="row-actions pdfcraft-fallback-actions" id="pdfcraft-fallback-actions" hidden>
            <button type="button" class="primary-btn" data-pdfcraft-retry="webgl">Retry with WebGL2</button>
            <button type="button" class="ghost-btn" data-pdfcraft-retry="cpu">Retry in CPU mode</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);

    dlg.querySelector('#pdfcraft-btn-close').addEventListener('click', () => requestClose());
    dlg.querySelector('#pdfcraft-btn-download').addEventListener('click', () => {
      if (!session) return;
      const bytes = session.lastSavedBytes || session.sourceBytesCopy;
      if (!bytes) {
        toast('Use File → Save / Export inside PdfCraft to download.');
        return;
      }
      downloadBytes(bytes, session.lastSavedName || session.filename || 'document.pdf');
      toast(`Downloaded ${session.lastSavedName || session.filename || 'document.pdf'}`);
    });
    dlg.querySelectorAll('[data-pdfcraft-retry]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!session) return;
        mountIframe(btn.dataset.pdfcraftRetry);
      });
    });

    dlg.addEventListener('cancel', (ev) => {
      if (session?.dirty) {
        ev.preventDefault();
        requestClose();
      }
    });
    dlg.addEventListener('close', () => teardownSession());

    dialogEl = dlg;
    return dlg;
  }

  function setStatusPill(text, tone = '') {
    const pill = dialogEl?.querySelector('#pdfcraft-status-pill');
    if (!pill) return;
    if (!text) {
      pill.hidden = true;
      pill.textContent = '';
      pill.className = 'pdfcraft-pill';
      return;
    }
    pill.hidden = false;
    pill.textContent = text;
    pill.className = `pdfcraft-pill${tone ? ` is-${tone}` : ''}`;
  }

  function showOverlay(title, sub, showFallbacks = false) {
    const ov = dialogEl?.querySelector('#pdfcraft-overlay');
    if (!ov) return;
    ov.hidden = false;
    ov.classList.toggle('is-error', Boolean(showFallbacks));
    const tEl = dialogEl.querySelector('#pdfcraft-overlay-title');
    const sEl = dialogEl.querySelector('#pdfcraft-overlay-sub');
    const fEl = dialogEl.querySelector('#pdfcraft-fallback-actions');
    if (tEl) tEl.textContent = title;
    if (sEl) sEl.textContent = sub;
    if (fEl) fEl.hidden = !showFallbacks;
  }

  function hideOverlay() {
    const ov = dialogEl?.querySelector('#pdfcraft-overlay');
    if (ov) ov.hidden = true;
  }

  function postOpenIfReady() {
    if (!session || !session.ready || !session.iframe?.contentWindow) return;
    if (!session.hasSource) {
      hideOverlay();
      setStatusPill('Ready');
      return;
    }
    if (session.bytesError) {
      showOverlay('Could not load PDF', session.bytesError, false);
      setStatusPill('Load error', 'error');
      return;
    }
    if (!session.sourceBytesCopy || session.dispatchedOpen) return;
    session.dispatchedOpen = true;
    // Always transfer a fresh copy so Download stays available if user downloads without saving
    const transferBuf = session.sourceBytesCopy.slice(0).buffer;
    session.iframe.contentWindow.postMessage(
      { type: 'pdfcraft:open', name: session.filename, bytes: transferBuf },
      window.location.origin,
      [transferBuf],
    );
    hideOverlay();
    setStatusPill('Cmd/Ctrl+S saves to Study-OS');
  }

  async function handleSaveMessage(msg) {
    if (!session) return;
    const rawName = String(msg.name || session.filename || 'document.pdf').trim() || 'document.pdf';
    const saveAs = Boolean(msg.saveAs);
    const bytesView = msg.bytes instanceof ArrayBuffer
      ? new Uint8Array(msg.bytes)
      : ArrayBuffer.isView(msg.bytes)
        ? new Uint8Array(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength)
        : null;

    if (!bytesView || !bytesView.byteLength) {
      toast('PdfCraft returned an empty file.');
      return;
    }

    const bytesCopy = bytesView.slice();
    const isPdfFile = /\.pdf$/i.test(rawName);
    if (isPdfFile) {
      session.lastSavedBytes = bytesCopy;
      session.lastSavedName = rawName;
      const dlBtn = dialogEl?.querySelector('#pdfcraft-btn-download');
      if (dlBtn) dlBtn.hidden = false;
    }

    const ackSaved = () => {
      if (msg.id != null && session?.iframe?.contentWindow) {
        session.iframe.contentWindow.postMessage(
          { type: 'pdfcraft:saved', id: msg.id },
          window.location.origin,
        );
      }
    };

    // Non-PDF exports (PNG, DOCX, TXT, SVG...), explicit Save As, or standalone blank sessions -> direct browser download
    if (!isPdfFile || saveAs || !session.hasSource || !window.StudyLocalSources?.save) {
      downloadBytes(bytesCopy, rawName);
      if (isPdfFile && !saveAs) {
        session.dirty = false;
        setStatusPill('Downloaded', 'saved');
      }
      ackSaved();
      toast(`Downloaded ${rawName}`);
      return;
    }

    // Save edited PDF right back into Study-OS's local browser vault so inline Study-OS readers immediately show edits!
    try {
      const existing = session.localSourceKey
        ? (window.StudyLocalSources.list?.() || []).find((f) => f.key === session.localSourceKey)
        : null;
      const courseId = existing?.courseId || session.courseId || 'general';
      const slugBase = rawName.toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(Date.now());
      const sourceId = existing?.sourceId || session.sourceId || `edited-${slugBase}`;
      const pdfFile = new File([bytesCopy], ensurePdfName(rawName), { type: 'application/pdf' });
      const rec = await window.StudyLocalSources.save(courseId, sourceId, pdfFile, {
        kind: existing?.kind || session.kind || 'canvas',
        title: existing?.title || session.title || ensurePdfName(rawName),
      });
      session.localSourceKey = rec.key;
      session.courseId = rec.courseId;
      session.sourceId = rec.sourceId;
      session.dirty = false;
      setStatusPill('Saved to Study-OS', 'saved');
      ackSaved();
      toast('Saved edited PDF back to Study-OS.');
      if (typeof session.onSaved === 'function') {
        try { session.onSaved(rec); } catch {}
      }
    } catch {
      downloadBytes(bytesCopy, ensurePdfName(rawName));
      session.dirty = false;
      setStatusPill('Downloaded (storage full)', 'saved');
      ackSaved();
      toast(`Browser storage full — downloaded ${ensurePdfName(rawName)} instead.`);
    }
  }

  function onHostMessage(ev) {
    if (!session || ev.origin !== window.location.origin) return;
    if (!session.iframe || ev.source !== session.iframe.contentWindow) return;
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('pdfcraft:')) return;

    if (msg.type === 'pdfcraft:ready') {
      session.ready = true;
      postOpenIfReady();
    } else if (msg.type === 'pdfcraft:dirty') {
      session.dirty = Boolean(msg.dirty);
      if (session.dirty) setStatusPill('Unsaved edits', 'dirty');
      else setStatusPill(session.lastSavedBytes ? 'Saved to Study-OS' : 'Cmd/Ctrl+S saves to Study-OS', session.lastSavedBytes ? 'saved' : '');
    } else if (msg.type === 'pdfcraft:save') {
      handleSaveMessage(msg);
    } else if (msg.type === 'pdfcraft:failed') {
      const reason = String(msg.error || 'WebGPU / WebGL2 renderer could not initialize.');
      showOverlay('PdfCraft could not start', reason, true);
      setStatusPill('Renderer error', 'error');
    }
  }

  function mountIframe(rendererFlag = '') {
    if (!session || !dialogEl) return;
    const stage = dialogEl.querySelector('#pdfcraft-stage');
    if (session.iframe) {
      try { session.iframe.src = 'about:blank'; } catch {}
      session.iframe.remove();
      session.iframe = null;
    }
    session.ready = false;
    session.dispatchedOpen = false;
    showOverlay(
      'Loading PdfCraft…',
      rendererFlag
        ? `Starting with ${rendererFlag.toUpperCase()} fallback renderer…`
        : 'Pure Rust WebAssembly PDF workbench · cached after first open.',
      false,
    );
    setStatusPill('Loading…');

    const params = new URLSearchParams();
    params.set('host', 'parent');
    const author = currentAuthorName();
    if (author) params.set('author', author);
    if (rendererFlag === 'webgl') params.set('webgl', '1');
    else if (rendererFlag === 'cpu') params.set('cpu', '1');

    const iframe = document.createElement('iframe');
    iframe.className = 'pdfcraft-frame';
    iframe.title = `PdfCraft — ${session.filename || 'PDF Editor'}`;
    iframe.allow = 'fullscreen; clipboard-read; clipboard-write';
    iframe.src = `./pdfcraft/?${params.toString()}`;
    stage.appendChild(iframe);
    session.iframe = iframe;
  }

  function teardownSession() {
    window.removeEventListener('message', onHostMessage);
    if (session?.iframe) {
      try { session.iframe.src = 'about:blank'; } catch {}
      session.iframe.remove();
    }
    session = null;
    setStatusPill('');
  }

  function requestClose() {
    if (!dialogEl?.open) return;
    if (session?.dirty) {
      const ok = window.confirm('You have unsaved edits in PdfCraft. Close without saving?');
      if (!ok) return;
    }
    dialogEl.close();
  }

  async function openSource(source, opts = {}) {
    if (!isAvailable()) {
      toast(localProbeDone
        ? 'PdfCraft web bundle is not installed locally (available live on studyos.no).'
        : 'PdfCraft editor is loading…');
      return;
    }
    const dlg = ensureDialog();
    if (dlg.open) teardownSession();

    const localMeta = source?.localSourceKey
      ? (window.StudyLocalSources?.list?.() || []).find((f) => f.key === source.localSourceKey)
      : null;
    const rawTitle = source?.title || localMeta?.title || source?.label || source?.pathStr || 'document.pdf';
    const filename = ensurePdfName(localMeta?.filename || source?.pathStr || rawTitle);

    session = {
      hasSource: Boolean(source),
      filename,
      title: String(rawTitle || filename),
      localSourceKey: source?.localSourceKey || '',
      courseId: source?.courseId || localMeta?.courseId || '',
      sourceId: source?.sourceId || localMeta?.sourceId || '',
      kind: source?.kind || localMeta?.kind || 'canvas',
      onSaved: opts.onSaved || null,
      sourceBytesCopy: null,
      bytesError: '',
      lastSavedBytes: null,
      lastSavedName: '',
      iframe: null,
      ready: false,
      dispatchedOpen: false,
      dirty: false,
    };

    dlg.querySelector('#pdfcraft-dialog-title').textContent = session.title;
    const dlBtn = dlg.querySelector('#pdfcraft-btn-download');
    if (dlBtn) dlBtn.hidden = !session.hasSource;

    window.addEventListener('message', onHostMessage);
    if (!dlg.open) dlg.showModal();
    mountIframe('');

    if (source) {
      try {
        const buf = await resolveSourceBytes(source);
        if (!session) return;
        session.sourceBytesCopy = new Uint8Array(buf).slice();
        postOpenIfReady();
      } catch (err) {
        if (!session) return;
        session.bytesError = err?.message || 'Could not read PDF bytes.';
        postOpenIfReady();
      }
    }
  }

  function openBlank(opts = {}) {
    return openSource(null, opts);
  }

  function close() {
    if (dialogEl?.open) dialogEl.close();
  }

  return {
    isAvailable,
    openSource,
    openBlank,
    close,
  };
})();
