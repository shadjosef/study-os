// Lightweight bridge between Study-OS web app and the local Study-OS Sync extension.
// Never sends copyrighted files to any remote server: Canvas PDF fetches stay strictly
// inside the user's own browser between their authenticated Canvas tab and IndexedDB.
(() => {
  const EXT_VERSION = '1.6.0';
  try {
    document.documentElement.dataset.studyOsSyncExt = EXT_VERSION;
    window.postMessage({ type: 'STUDY_OS_EXT_READY', version: EXT_VERSION }, window.location.origin);
  } catch {}

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'STUDY_OS_PING_EXT') {
      window.postMessage({ type: 'STUDY_OS_EXT_READY', version: EXT_VERSION }, window.location.origin);
      return;
    }

    if (msg.type === 'STUDY_OS_FETCH_CANVAS_FILE') {
      const requestId = String(msg.requestId || '');
      const courseId = String(msg.courseId || '');
      const fileId = String(msg.fileId || '');
      const canvasOrigin = typeof msg.canvasOrigin === 'string' ? msg.canvasOrigin : '';
      chrome.runtime.sendMessage(
        { action: 'fetchCanvasFile', courseId, fileId, canvasOrigin },
        (resp) => {
          const err = chrome.runtime.lastError?.message;
          window.postMessage({
            type: 'STUDY_OS_CANVAS_FILE_RESULT',
            requestId,
            ok: Boolean(!err && resp?.ok),
            dataBase64: resp?.dataBase64 || '',
            filename: resp?.filename || '',
            error: err || resp?.error || 'Could not load PDF from Canvas.',
          }, window.location.origin);
        }
      );
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'syncComplete') {
      window.postMessage({
        type: 'STUDY_OS_SYNC_COMPLETE',
        results: Array.isArray(message.results) ? message.results : [],
      }, window.location.origin);
    }
  });
})();
