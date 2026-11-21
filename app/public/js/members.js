'use strict';

window.StudyMembers = (() => {
  const enabled = document.documentElement.dataset.memberLibrary === '1';
  const idPattern = /^[0-9a-f]{36}$/;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let session = null;
  const previews = new Map();

  async function savedKey(operation, value) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('study-os-member-access', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Browser storage is busy.'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', operation === 'get' ? 'readonly' : 'readwrite');
        const keys = tx.objectStore('keys');
        const request = operation === 'put' ? keys.put(value, 'library') : keys[operation]('library');
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || request.error);
      });
    } finally {
      db.close();
    }
  }

  async function decrypt(id, key) {
    if (!idPattern.test(id)) throw new Error('Invalid library reference');
    const response = await fetch(`./member-library/${id}.enc`);
    if (!response.ok) throw new Error('Library file unavailable');
    const payload = new Uint8Array(await response.arrayBuffer());
    return crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: payload.subarray(0, 12),
      additionalData: encoder.encode(id),
    }, key, payload.subarray(12));
  }

  async function importAccessKey(accessString) {
    const raw = String(accessString || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (!raw) throw new Error('Paste your Study-OS archive access string first.');
    if (/^soci1_/i.test(raw)) {
      throw new Error('Enter this Community invite when creating a Community profile. Use a key beginning with sos1_ to open the PDF archive.');
    }
    if (/^[A-Z0-9]{3}-?[A-Z0-9]{3}$/i.test(raw)) {
      throw new Error('That looks like a 6-character BI Canvas pairing code — enter it in the Study-OS Sync extension instead.');
    }
    if (!crypto.subtle) {
      throw new Error('This browser context does not support Web Crypto decryption. Open https://studyos.no over HTTPS.');
    }
    const normalized = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const match = /^(?:sos1_)?([A-Za-z0-9_-]{43})$/.exec(normalized);
    if (!match) {
      throw new Error(`Invalid archive key format (${raw.length} chars entered). Expected a 48-character key starting with sos1_.`);
    }
    const bytes = Uint8Array.from(atob(match[1].replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0));
    try {
      return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
    } finally {
      bytes.fill(0);
    }
  }

  async function unlock(accessString, remember) {
    const key = await importAccessKey(accessString);
    await unlockWithKey(key);
    try {
      if (remember) await savedKey('put', key);
      else await savedKey('delete');
      return Boolean(remember);
    } catch {
      return false;
    }
  }

  async function readManifest(key) {
    const response = await fetch('./member-library/index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('The library is unavailable. Try again online.');
    const index = await response.json();
    if (index.format !== 1 || !idPattern.test(index.manifest)) throw new Error('The library index could not be read.');
    let manifest;
    try {
      manifest = JSON.parse(decoder.decode(await decrypt(index.manifest, key)));
    } catch (error) {
      if (error.name === 'OperationError') throw new Error('That access string did not unlock this library.');
      throw error;
    }
    if (manifest.format !== 1 || !manifest.courses) throw new Error('The library could not be read.');
    return manifest;
  }

  async function unlockWithKey(key) {
    session = { key, courses: (await readManifest(key)).courses };
  }

  async function verifyAccessString(accessString) {
    await readManifest(await importAccessKey(accessString));
  }

  async function restore() {
    if (!enabled) return;
    try {
      const key = await savedKey('get');
      if (key) await unlockWithKey(key);
    } catch {}
  }

  async function forget() {
    await savedKey('delete');
    session = null;
    window.StudyPdf?.clearCache?.();
    window.StudyPdf?.clearText?.();
    for (const pending of previews.values()) {
      pending.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    }
    previews.clear();
  }

  function course(courseId) {
    return session?.courses[courseId];
  }

  function sourceDocument(courseId, ref) {
    const title = courseId === 'acct-2527' && ref.sourceId === 'textbook-12e'
      ? 'Accounting and Finance for Non-Specialists - Atrill and McLaney - 12th edition.pdf'
      : ref.filename;
    if (!title) return null;
    return course(courseId)?.documents.find(doc =>
      doc.mime === 'application/pdf' && doc.title.toLowerCase() === title.toLowerCase()) || null;
  }

  async function loadBank(courseId) {
    const entry = course(courseId);
    if (!entry) return null;
    const bank = JSON.parse(decoder.decode(await decrypt(entry.bank, session.key)));
    // This past paper was saved separately from the course archive with its original name.
    if (courseId === 'acct-2527' && !bank.sources.E23F) {
      const paper = entry.documents.find((doc) => doc.title === 'EXC 3430_Exam_2023.pdf');
      if (paper) bank.sources.E23F = paper;
    }
    if (courseId === 'acct-2527' && !bank.sources['textbook-12e']) {
      const textbook = sourceDocument(courseId, { sourceId: 'textbook-12e' });
      if (textbook) bank.sources['textbook-12e'] = textbook;
    }
    return bank;
  }

  async function fileBlob(id, mime) {
    if (!session) throw new Error('Unlock the library first.');
    return new Blob([await decrypt(id, session.key)], { type: mime });
  }

  async function pdfBytes(id) {
    const url = await previewUrl(id, 'application/pdf');
    return (await fetch(url)).arrayBuffer();
  }

  async function previewUrl(id, mime) {
    if (!previews.has(id)) {
      previews.set(id, fileBlob(id, mime).then((blob) => URL.createObjectURL(blob)).catch((error) => {
        previews.delete(id);
        throw error;
      }));
      // Limit memory held by previously viewed question figures and documents.
      if (previews.size > 28) {
        const oldest = previews.keys().next().value;
        previews.get(oldest).then((url) => URL.revokeObjectURL(url)).catch(() => {});
        previews.delete(oldest);
      }
    }
    return previews.get(id);
  }

  function fillPreviews(root) {
    for (const el of root.querySelectorAll('[data-member-preview]')) {
      const { memberPreview, memberMime, pdfPage } = el.dataset;
      previewUrl(memberPreview, memberMime).then((url) => {
        if (el.isConnected) el.src = url + (pdfPage ? `#page=${pdfPage}&view=FitH` : '');
      }).catch(() => {
        if (!el.isConnected) return;
        const note = document.createElement('p');
        note.textContent = 'Could not open this source. Check your connection.';
        el.replaceWith(note);
      });
    }
  }

  function bindDownloads(root) {
    for (const button of root.querySelectorAll('[data-member-download]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        const { memberDownload, memberMime, filename } = button.dataset;
        const originalLabel = button.textContent;
        button.textContent = 'Opening…';
        try {
          const blob = await fileBlob(memberDownload, memberMime);
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          button.textContent = originalLabel;
        } catch {
          button.textContent = 'Could not open. Retry';
        } finally {
          button.disabled = false;
        }
      });
    }
  }

  return { enabled, unlock, verifyAccessString, restore, forget, isUnlocked: () => Boolean(session), course, sourceDocument, loadBank, pdfBytes, fillPreviews, bindDownloads };
})();
