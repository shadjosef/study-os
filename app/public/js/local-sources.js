'use strict';

window.StudyProvenance = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function inferLlmModel(q) {
    if (q?.provenance?.llmModel) return q.provenance.llmModel;
    if (q?.generatedBy) return String(q.generatedBy);
    if (q?.llmModel) return String(q.llmModel);
    const col = String(q?.collectionId || '');
    if (col === 'WF-MOCK-D') return 'Gemini (Antigravity)';
    if (/^WF-MOCK-[ABC]$/.test(col)) return 'AI Builder + Gemini (Antigravity format)';
    if (q?.origin === 'mock_exam' || q?.origin === 'synthetic_drill') {
      return 'LLM-generated (legacy — model unlogged)';
    }
    return null;
  }

  function describe(q, bank) {
    if (!q) {
      return {
        category: 'exercise',
        label: 'Course Exercise',
        shortLabel: 'Exercise',
        badgeClass: 'prov-exercise',
        synthetic: false,
        llmModel: null,
        sourceDetail: '',
        tooltip: 'Course exercise',
        priorityRank: 1,
      };
    }
    const existing = q.provenance && typeof q.provenance === 'object' ? q.provenance : null;
    const origin = String(q.origin || '');
    const colObj = bank?.collections?.find((c) => c.id === q.collectionId);
    const colTitle = colObj?.title || q.collectionId || '';

    let category = existing?.category || '';
    if (!category) {
      if (origin === 'original_exam') category = 'past_exam';
      else if (origin === 'tutoring') category = 'tutoring';
      else if (origin === 'lecture') category = 'lecture';
      else if (origin === 'reading_submission') category = 'reading';
      else if (origin === 'textbook') category = 'book';
      else if (origin === 'mock_exam') category = 'ai_mock';
      else if (origin === 'synthetic_drill') category = 'ai_synthetic';
      else category = 'exercise';
    }

    const synthetic = existing ? Boolean(existing.synthetic) : (category === 'ai_mock' || category === 'ai_synthetic');
    const llmModel = synthetic ? (existing?.llmModel || inferLlmModel(q)) : null;

    const map = {
      past_exam:    { label: 'Past Exam',        shortLabel: 'Past Exam',  badgeClass: 'prov-exam',     priorityRank: 0 },
      exercise:     { label: 'BI Exercise',      shortLabel: 'Exercise',   badgeClass: 'prov-exercise', priorityRank: 1 },
      tutoring:     { label: 'Tutoring Session', shortLabel: 'Tutoring',   badgeClass: 'prov-tutoring', priorityRank: 1 },
      lecture:      { label: 'Lecture Set',      shortLabel: 'Lecture',    badgeClass: 'prov-lecture',  priorityRank: 2 },
      reading:      { label: 'Reading Task',     shortLabel: 'Reading',    badgeClass: 'prov-reading',  priorityRank: 2 },
      book:         { label: 'Book Exercise',    shortLabel: 'Book',       badgeClass: 'prov-book',     priorityRank: 3 },
      ai_mock:      { label: 'AI Mock Exam',     shortLabel: 'AI Mock',    badgeClass: 'prov-ai',       priorityRank: 4 },
      ai_synthetic: { label: 'AI Synthetic',     shortLabel: 'AI Synth',   badgeClass: 'prov-ai',       priorityRank: 5 },
    };
    const meta = map[category] || map.exercise;
    const sourceDetail = existing?.sourceDetail || colTitle || meta.label;
    const tooltip = synthetic
      ? `${meta.label} · Model: ${llmModel}${sourceDetail ? ` · ${sourceDetail}` : ''}`
      : `Pulled from ${meta.label}${sourceDetail ? ` · ${sourceDetail}` : ''}`;

    return {
      category,
      label: existing?.label || meta.label,
      shortLabel: meta.shortLabel,
      badgeClass: meta.badgeClass,
      synthetic,
      llmModel,
      sourceDetail,
      tooltip,
      priorityRank: meta.priorityRank,
    };
  }

  function describeCollection(col, courseId = '') {
    const id = String(col?.id || '');
    const kind = String(col?.kind || '');
    const existing = col?.provenance && typeof col.provenance === 'object' ? col.provenance : null;

    let category = existing?.category || '';
    if (!category) {
      if (kind === 'mock_exam' || kind === 'mock' || /^(WF-MOCK|nov19-mock|wiseflow-mock|mock-exam)/i.test(id)) {
        category = 'ai_mock';
      } else if (kind === 'drill' || /^(SYN-|OBSID-BANK|foundation-|concept-mcq|math-topic-practice)/i.test(id)) {
        category = 'ai_synthetic';
      } else if (kind === 'exam' || /^(E\d|exam-|sample-exam|pandas-viz-exam2)/i.test(id)) {
        category = 'past_exam';
      } else if (kind === 'tutoring') {
        category = 'tutoring';
      } else if (kind === 'textbook') {
        category = 'book';
      } else if (kind === 'lecture') {
        category = 'lecture';
      } else if (kind === 'reading') {
        category = 'reading';
      } else {
        category = 'exercise';
      }
    }

    const synthetic = existing ? Boolean(existing.synthetic) : (category === 'ai_mock' || category === 'ai_synthetic');
    let llmModel = existing?.llmModel || null;
    if (synthetic && !llmModel) {
      if (id === 'WF-MOCK-D') llmModel = 'Gemini (Antigravity)';
      else if (/^WF-MOCK-[ABC]$/.test(id)) llmModel = 'AI Builder + Gemini (Antigravity format)';
      else llmModel = 'LLM-generated (legacy — model unlogged)';
    }

    const labels = {
      past_exam:    { text: 'Official BI Past Exam', badgeClass: 'prov-exam' },
      exercise:     { text: 'BI Course Exercise',    badgeClass: 'prov-exercise' },
      tutoring:     { text: 'BI Tutoring Session',   badgeClass: 'prov-tutoring' },
      lecture:      { text: 'BI Lecture Set',        badgeClass: 'prov-lecture' },
      reading:      { text: 'BI Reading Assignment', badgeClass: 'prov-reading' },
      book:         { text: 'Textbook (BYOB)',       badgeClass: 'prov-book' },
      ai_mock:      { text: llmModel ? `AI Mock · ${llmModel}` : 'AI Mock Exam', badgeClass: 'prov-ai' },
      ai_synthetic: { text: llmModel ? `AI Synthetic · ${llmModel}` : 'AI Synthetic', badgeClass: 'prov-ai' },
    };
    const info = labels[category] || labels.exercise;
    return {
      category,
      synthetic,
      llmModel,
      badgeText: info.text,
      badgeClass: info.badgeClass,
      tooltip: synthetic
        ? `Synthetically created (${llmModel}) — not an official BI exam paper.`
        : `Authentic BI course material (${info.text}).`,
      courseId,
    };
  }

  function badgeHtml(q, bank, opts = {}) {
    const p = describe(q, bank);
    const compactModel = p.llmModel
      ? p.llmModel.replace(/^LLM-generated\s*\(legacy\s*[—-]\s*model unlogged\)$/i, 'Legacy LLM')
      : '';
    const text = opts.showModel && p.synthetic && compactModel
      ? `${p.shortLabel} · ${compactModel}`
      : (opts.short ? p.shortLabel : p.label);
    return `<span class="prov-badge ${p.badgeClass}" title="${esc(p.tooltip)}">${esc(text)}</span>`;
  }

  return { describe, describeCollection, badgeHtml };
})();

window.StudyLocalSources = (() => {
  const DB_NAME = 'study-os-local-sources-v1';
  const STORE_NAME = 'files';
  const MAX_BYTES = 260 * 1024 * 1024;
  const metaMap = new Map();
  let initialized = false;
  let initPromise = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support private local storage (IndexedDB).'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open local PDF storage.'));
      req.onblocked = () => reject(new Error('Local PDF storage is busy in another tab.'));
    });
  }

  function makeKey(courseId, sourceId) {
    return `${String(courseId || 'global').trim()}:${String(sourceId || 'file').trim()}`;
  }

  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/^\d+--/, '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function init() {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const db = await openDb();
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const cursorReq = store.openCursor();
            cursorReq.onsuccess = () => {
              const cur = cursorReq.result;
              if (!cur) return;
              const rec = cur.value;
              metaMap.set(rec.key, {
                key: rec.key,
                courseId: rec.courseId,
                sourceId: rec.sourceId,
                kind: rec.kind || 'canvas',
                title: rec.title || rec.filename,
                filename: rec.filename || rec.title,
                size: rec.size || 0,
                mime: rec.mime || 'application/pdf',
                addedAt: rec.addedAt || '',
              });
              cur.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } finally {
          db.close();
        }
      } catch {
        // Private browsing or blocked IndexedDB: gracefully keep empty map
      } finally {
        initialized = true;
      }
    })();
    return initPromise;
  }

  async function save(courseId, sourceId, file, meta = {}) {
    if (!file) throw new Error('Choose a PDF file first.');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!isPdf) throw new Error('Please drop a PDF file (.pdf).');
    if (file.size > MAX_BYTES) throw new Error('PDF exceeds 260 MB browser storage limit.');

    const bytes = await file.arrayBuffer();
    const key = makeKey(courseId, sourceId || `file-${normName(file.name) || Date.now()}`);
    const record = {
      key,
      courseId: String(courseId || 'global'),
      sourceId: String(sourceId || ''),
      kind: meta.kind || 'canvas',
      title: meta.title || file.name,
      filename: file.name,
      size: file.size,
      mime: 'application/pdf',
      addedAt: new Date().toISOString(),
      bytes,
    };

    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('Could not save PDF locally.'));
      });
    } finally {
      db.close();
    }

    const summary = {
      key: record.key,
      courseId: record.courseId,
      sourceId: record.sourceId,
      kind: record.kind,
      title: record.title,
      filename: record.filename,
      size: record.size,
      mime: record.mime,
      addedAt: record.addedAt,
    };
    metaMap.set(key, summary);
    try { window.dispatchEvent(new CustomEvent('study-local-sources-changed', { detail: summary })); } catch {}
    return summary;
  }

  async function saveBatch(courseId, fileList, bankSources = {}) {
    const files = Array.from(fileList || []);
    const saved = [];
    const errors = [];
    const sourceEntries = Object.entries(bankSources || {});

    for (const file of files) {
      try {
        const fnNorm = normName(file.name);
        let matchedId = '';
        let matchedMeta = { kind: 'canvas', title: file.name };

        // Match textbook heuristically (e.g., Atrill & McLaney)
        if (/atrill|mclaney|textbook|non.?specialists/i.test(file.name)) {
          const bookEntry = sourceEntries.find(([, v]) => v?.kind === 'book');
          if (bookEntry) {
            matchedId = bookEntry[0];
            matchedMeta = { kind: 'book', title: bookEntry[1].title || file.name };
          }
        }

        // Exact Canvas file ID prefix (e.g. 172114--...) or normalized filename/title match
        if (!matchedId) {
          const idPrefix = String(file.name || '').match(/^(\d{4,9})--/)?.[1];
          for (const [sid, src] of sourceEntries) {
            if (idPrefix && (sid === idPrefix || String(src.canvasFileId || '') === idPrefix)) {
              matchedId = sid;
              matchedMeta = { kind: src.kind || 'canvas', title: src.title || file.name };
              break;
            }
            const sFile = normName(src.filename || '');
            const sTitle = normName(src.title || '');
            if (fnNorm && ((sFile && (fnNorm === sFile || fnNorm.includes(sFile) || sFile.includes(fnNorm))) ||
                (sTitle && sTitle.length >= 6 && (fnNorm.includes(sTitle) || sTitle.includes(fnNorm))))) {
              matchedId = sid;
              matchedMeta = { kind: src.kind || 'canvas', title: src.title || file.name };
              break;
            }
          }
        }

        const rec = await save(courseId, matchedId || `custom-${fnNorm || Date.now()}`, file, matchedMeta);
        saved.push(rec);
      } catch (err) {
        errors.push(`${file.name}: ${err.message || 'Could not save'}`);
      }
    }
    return { saved, errors };
  }

  async function getBytes(key) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        tx.oncomplete = () => {
          if (!req.result?.bytes) reject(new Error('Local PDF not found in browser storage.'));
          else resolve(req.result.bytes);
        };
        tx.onerror = () => reject(tx.error || new Error('Could not read local PDF.'));
      });
    } finally {
      db.close();
    }
  }

  async function remove(key) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    metaMap.delete(key);
    try { window.dispatchEvent(new CustomEvent('study-local-sources-changed', { detail: { removed: key } })); } catch {}
  }

  function list(courseId = '') {
    const all = Array.from(metaMap.values());
    const filtered = courseId ? all.filter((item) => item.courseId === courseId) : all;
    return filtered.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
  }

  function match(courseId, sourceRef) {
    if (!sourceRef) return null;
    if (sourceRef.sourceId) {
      const exact = metaMap.get(makeKey(courseId, sourceRef.sourceId));
      if (exact) return exact;
    }
    const courseItems = list(courseId);
    if (!courseItems.length) return null;
    if (sourceRef.kind === 'book') {
      const bookItem = courseItems.find((item) => item.kind === 'book' || /atrill|mclaney|textbook/i.test(item.filename));
      if (bookItem) return bookItem;
    }
    const wantFile = normName(sourceRef.filename || '');
    const wantTitle = normName(sourceRef.title || '');
    const wantId = String(sourceRef.canvasFileId || sourceRef.sourceId || '');
    for (const item of courseItems) {
      if (wantId && item.sourceId === wantId) return item;
      const got = normName(item.filename || item.title || '');
      if (!got) continue;
      if (wantFile && (got === wantFile || got.includes(wantFile) || wantFile.includes(got))) return item;
      if (wantTitle && wantTitle.length >= 6 && (got.includes(wantTitle) || wantTitle.includes(got))) return item;
    }
    return null;
  }

  function has(courseId, sourceId) {
    return metaMap.has(makeKey(courseId, sourceId));
  }

  return { init, save, saveBatch, getBytes, remove, list, match, has, makeKey, formatBytes };
})();
