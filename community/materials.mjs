// Private Per-Profile Curriculum PDFs & Study Material Sync (Chunked D1 Storage)
// Strictly private per profile_id — never shared publicly or visible to other users.

const CHUNK_BYTES = 245_760; // 240 KB raw binary -> ~328 KB base64 JSON per chunk (well below D1 1 MB row limit)
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per cloud-synced file (larger books up to 260 MB save privately in-browser)
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB per student profile
const MAX_FILES_PER_USER = 100;
const MAX_CHUNKS_PER_FILE = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES) + 1;
const ID_RE = /^[0-9a-f-]{36}$/;
const B64_RE = /^[A-Za-z0-9+/=]+$/;

const ALLOWED_MIMES = new Map([
  ['application/pdf', { ext: '.pdf', inline: true }],
  ['text/plain', { ext: '.txt', inline: true }],
  ['text/markdown', { ext: '.md', inline: true }],
  ['text/csv', { ext: '.csv', inline: true }],
  ['image/png', { ext: '.png', inline: true }],
  ['image/jpeg', { ext: '.jpg', inline: true }],
  ['image/webp', { ext: '.webp', inline: true }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', { ext: '.docx', inline: false }],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', { ext: '.pptx', inline: false }],
]);

const EXT_TO_MIME = new Map([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f\\/]+/g, ' ')
    .trim()
    .slice(0, 140);
}

function cleanCourseCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 24);
}

function resolveMime(rawMime, filename) {
  const cleanMime = String(rawMime || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_MIMES.has(cleanMime)) return cleanMime;
  const dot = String(filename || '').toLowerCase().match(/\.[a-z0-9]{2,8}$/)?.[0] || '';
  return EXT_TO_MIME.get(dot) || '';
}

function decodeBase64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function handleMaterials({ request, url, path, db, me, now, data, reply, corsHeaders }) {
  // Clean up any abandoned incomplete uploads older than 30 minutes for this user
  const staleCutoff = now - 1_800_000;

  if (path === '/materials' && request.method === 'GET') {
    await db.prepare('DELETE FROM user_materials WHERE profile_id = ? AND complete = 0 AND created_at < ?')
      .bind(me.id, staleCutoff).run().catch(() => {});

    const { results } = await db.prepare(`
      SELECT id, course_code AS courseCode, course_title AS courseTitle,
             title, mime_type AS mimeType, size_bytes AS sizeBytes,
             chunk_count AS chunkCount, created_at AS createdAt
      FROM user_materials
      WHERE profile_id = ? AND complete = 1
      ORDER BY created_at DESC
      LIMIT 60
    `).bind(me.id).all();
    const items = results || [];
    const usedBytes = items.reduce((sum, it) => sum + Number(it.sizeBytes || 0), 0);
    return reply({
      items,
      usedBytes,
      maxBytes: MAX_TOTAL_BYTES,
      maxFileBytes: MAX_FILE_BYTES,
      count: items.length,
      maxFiles: MAX_FILES_PER_USER,
      chunkBytes: CHUNK_BYTES,
    });
  }

  if (path === '/materials/init' && request.method === 'POST') {
    await db.prepare('DELETE FROM user_materials WHERE profile_id = ? AND complete = 0 AND created_at < ?')
      .bind(me.id, staleCutoff).run().catch(() => {});

    const title = cleanTitle(data?.title);
    const mimeType = resolveMime(data?.mimeType, title);
    const sizeBytes = Number(data?.sizeBytes || 0);
    const chunkCount = Number(data?.chunkCount || 0);
    const courseCode = cleanCourseCode(data?.courseCode);
    const courseTitle = cleanTitle(data?.courseTitle).slice(0, 120);

    if (!title) return reply({ error: 'File name is required.' }, 400);
    if (!mimeType || !ALLOWED_MIMES.has(mimeType)) {
      return reply({ error: 'Supported file types: PDF, Markdown, TXT, CSV, PNG, JPG, WebP, DOCX, PPTX.' }, 400);
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) {
      return reply({ error: `Each file must be under ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.` }, 413);
    }
    if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNKS_PER_FILE) {
      return reply({ error: 'Invalid upload chunk count.' }, 400);
    }

    const usage = await db.prepare(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS totalBytes
      FROM user_materials
      WHERE profile_id = ? AND complete = 1
    `).bind(me.id).first();

    if (Number(usage?.cnt || 0) >= MAX_FILES_PER_USER) {
      return reply({ error: `Profile material limit reached (${MAX_FILES_PER_USER} files). Remove an older file first.` }, 409);
    }
    if (Number(usage?.totalBytes || 0) + sizeBytes > MAX_TOTAL_BYTES) {
      return reply({ error: `Profile storage limit reached (${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB). Remove an older file first.` }, 413);
    }

    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO user_materials(id, profile_id, course_code, course_title, title, mime_type, size_bytes, chunk_count, complete, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).bind(id, me.id, courseCode, courseTitle, title, mimeType, sizeBytes, chunkCount, now).run();

    return reply({ ok: true, id, chunkBytes: CHUNK_BYTES }, 201);
  }

  if (path === '/materials/chunk' && request.method === 'POST') {
    const id = String(data?.id || '').trim();
    const index = Number(data?.index);
    const chunkB64 = typeof data?.data === 'string' ? data.data.trim() : '';
    if (!ID_RE.test(id) || !Number.isSafeInteger(index) || index < 0 || index >= MAX_CHUNKS_PER_FILE) {
      return reply({ error: 'Invalid material chunk.' }, 400);
    }
    if (!chunkB64 || chunkB64.length > 420_000 || !B64_RE.test(chunkB64)) {
      return reply({ error: 'Invalid base64 chunk data.' }, 400);
    }

    const row = await db.prepare(
      'SELECT chunk_count FROM user_materials WHERE id = ? AND profile_id = ? AND complete = 0'
    ).bind(id, me.id).first();
    if (!row || index >= Number(row.chunk_count)) {
      return reply({ error: 'Upload session not found or already finished.' }, 404);
    }

    await db.prepare(`
      INSERT INTO user_material_chunks(material_id, chunk_index, data_b64)
      VALUES (?, ?, ?)
      ON CONFLICT(material_id, chunk_index) DO UPDATE SET data_b64 = excluded.data_b64
    `).bind(id, index, chunkB64).run();

    return reply({ ok: true, index });
  }

  if (path === '/materials/complete' && request.method === 'POST') {
    const id = String(data?.id || '').trim();
    if (!ID_RE.test(id)) return reply({ error: 'Invalid material id.' }, 400);

    const row = await db.prepare(`
      SELECT id, course_code AS courseCode, course_title AS courseTitle,
             title, mime_type AS mimeType, size_bytes AS sizeBytes,
             chunk_count AS chunkCount, created_at AS createdAt
      FROM user_materials
      WHERE id = ? AND profile_id = ?
    `).bind(id, me.id).first();
    if (!row) return reply({ error: 'Material not found.' }, 404);

    const stored = await db.prepare(
      'SELECT COUNT(*) AS cnt FROM user_material_chunks WHERE material_id = ?'
    ).bind(id).first();
    if (Number(stored?.cnt || 0) < Number(row.chunkCount || 1)) {
      return reply({ error: 'Some file chunks are missing. Please re-upload.' }, 400);
    }

    await db.prepare('UPDATE user_materials SET complete = 1 WHERE id = ? AND profile_id = ?')
      .bind(id, me.id).run();

    return reply({ ok: true, item: row });
  }

  if (path === '/materials/delete' && request.method === 'POST') {
    const id = String(data?.id || '').trim();
    if (!ID_RE.test(id)) return reply({ error: 'Invalid material id.' }, 400);
    await db.prepare('DELETE FROM user_materials WHERE id = ? AND profile_id = ?').bind(id, me.id).run();
    return reply({ ok: true });
  }

  if (path === '/materials/download' && request.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!ID_RE.test(id)) return reply({ error: 'Invalid material id.' }, 400);

    const row = await db.prepare(`
      SELECT title, mime_type AS mimeType, size_bytes AS sizeBytes
      FROM user_materials
      WHERE id = ? AND profile_id = ? AND complete = 1
    `).bind(id, me.id).first();
    if (!row) return reply({ error: 'Material not found.' }, 404);

    const { results } = await db.prepare(`
      SELECT data_b64 FROM user_material_chunks
      WHERE material_id = ?
      ORDER BY chunk_index ASC
    `).bind(id).all();

    const parts = (results || []).map((r) => decodeBase64ToBytes(r.data_b64));
    const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }

    const meta = ALLOWED_MIMES.get(row.mimeType) || { inline: false };
    const safeFile = String(row.title || 'material').replace(/["\r\n\\]/g, '_');
    return new Response(merged, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': meta.inline ? row.mimeType : 'application/octet-stream',
        'Content-Disposition': `${meta.inline ? 'inline' : 'attachment'}; filename="${safeFile}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return reply({ error: 'Method not allowed.' }, 405);
}
