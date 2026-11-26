/* Markdown + KaTeX + Obsidian Reference Drawer utilities for Study-OS */
'use strict';

window.StudyUI = (() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const examLabel = (label) => String(label ?? '')
    .replace(/,\s*(?:WISEflow\s+)?±2%\s+auto-graded/gi, '')
    .replace(/\s+FLOWmulti\s*±2%/gi, '');

  function clockSec(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function minLabel(min) {
    const v = Number(min) || 0;
    return Number.isInteger(v) ? `${v}m` : `${v.toFixed(1)}m`;
  }

  const CALLOUT_META = {
    info: { cls: 'info', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>' },
    note: { cls: 'info', icon: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
    tip: { cls: 'tip', icon: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>' },
    hint: { cls: 'tip', icon: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>' },
    important: { cls: 'important', icon: '<path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"/>' },
    warning: { cls: 'warning', icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>' },
    caution: { cls: 'warning', icon: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>' },
    danger: { cls: 'danger', icon: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' },
    example: { cls: 'example', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' },
    abstract: { cls: 'abstract', icon: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>' },
    summary: { cls: 'abstract', icon: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>' },
    question: { cls: 'question', icon: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>' },
    quote: { cls: 'quote', icon: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zM15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>' },
  };

  function headingSlug(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/\$[^$]+\$/g, (m) => m.replace(/[\$\\{}^_]/g, ''))
      .replace(/[^a-z0-9æøå]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 72) || 'section';
  }

  function cleanOutlineTitle(raw) {
    return String(raw || '')
      .replace(/\$\$([^$]+)\$\$/g, '$1')
      .replace(/\$([^$\n]+)\$/g, (_, tex) => tex.replace(/\\text\{([^}]+)\}/g, '$1').replace(/\\[a-z]+/gi, '').replace(/[{}]/g, ''))
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderMarkdownWithMath(rawMd) {
    const text = String(rawMd || '').trim();
    if (!text) return '';

    // 1. Protect fenced code blocks first so callout/math/highlight regexes never touch code
    const codeTokens = [];
    let safe = text.replace(/```[\s\S]*?```/g, (block) => {
      const idx = codeTokens.length;
      codeTokens.push(block);
      return `@@CODE_BLOCK_${idx}@@`;
    });

    // 2. Protect display $$...$$ and inline $...$ math tokens before Marked parses underscores/asterisks
    const mathTokens = [];
    const stash = (tex, displayMode) => {
      const idx = mathTokens.length;
      mathTokens.push({ tex, displayMode });
      return `@@MATH_TOKEN_${idx}@@`;
    };

    safe = safe.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(tex, true));
    safe = safe.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(tex, true));
    safe = safe.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(tex, false));
    safe = safe.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (m, pre, tex) => {
      if (/^\s|\s$/.test(tex) && !/[\\^_{}=+\-*/]/.test(tex)) return m;
      // Avoid mistaking prose between two currency amounts ($20,000 ... $8,000) for inline math
      if (/^\d[\d,.]*(?:\s|[*_:])/.test(tex) && !/[\\^_{}=+<>≤≥≠≈]/.test(tex)) return m;
      return `${pre}${stash(tex, false)}`;
    });

    // 3. Transform Obsidian callouts `> [!kind](+|-)? Title` + contiguous `>` lines into rich colored callouts
    const calloutTokens = [];
    const srcLines = safe.split('\n');
    const outLines = [];
    for (let i = 0; i < srcLines.length; i++) {
      const m = srcLines[i].match(/^>\s*\[!([a-zA-Z]+)\]([-+])?\s*(.*)$/);
      if (!m) {
        outLines.push(srcLines[i]);
        continue;
      }
      const rawKind = m[1].toLowerCase();
      const fold = m[2] || '';
      const rawTitle = (m[3] || '').trim();
      const bodyLines = [];
      while (i + 1 < srcLines.length && /^>/.test(srcLines[i + 1])) {
        i++;
        bodyLines.push(srcLines[i].replace(/^>\s?/, ''));
      }
      const meta = CALLOUT_META[rawKind] || CALLOUT_META.info;
      const label = rawTitle || (rawKind.charAt(0).toUpperCase() + rawKind.slice(1));
      const titleHtml = window.marked && typeof window.marked.parseInline === 'function'
        ? window.marked.parseInline(label)
        : esc(label);
      const bodyRaw = bodyLines.join('\n').trim();
      const bodyHtml = bodyRaw
        ? (window.marked ? window.marked.parse(bodyRaw, { breaks: false, gfm: true }) : `<p>${esc(bodyRaw)}</p>`)
        : '';
      const svg = `<svg class="obs-callout-svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${meta.icon}</svg>`;
      let blockHtml;
      if (fold === '-' || fold === '+') {
        blockHtml = `<details class="obs-callout obs-callout-${meta.cls}"${fold === '+' ? ' open' : ''}><summary class="obs-callout-title">${svg}<span>${titleHtml}</span></summary>${bodyHtml ? `<div class="obs-callout-body">${bodyHtml}</div>` : ''}</details>`;
      } else {
        blockHtml = `<div class="obs-callout obs-callout-${meta.cls}"><div class="obs-callout-title">${svg}<span>${titleHtml}</span></div>${bodyHtml ? `<div class="obs-callout-body">${bodyHtml}</div>` : ''}</div>`;
      }
      const cIdx = calloutTokens.length;
      calloutTokens.push(blockHtml);
      outLines.push(`\n@@CALLOUT_BLOCK_${cIdx}@@\n`);
    }
    safe = outLines.join('\n');

    // 4. Support Obsidian ==highlight== outside inline code spans
    const inlineCodeTokens = [];
    safe = safe.replace(/`[^`\n]+`/g, (span) => {
      const idx = inlineCodeTokens.length;
      inlineCodeTokens.push(span);
      return `@@INL_CODE_${idx}@@`;
    });
    safe = safe.replace(/==([^=\n]+?)==/g, '<mark class="md-highlight">$1</mark>');
    safe = safe.replace(/@@INL_CODE_(\d+)@@/g, (_, idx) => inlineCodeTokens[Number(idx)] || '');
    safe = safe.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)] || '');

    let html = window.marked ? window.marked.parse(safe, { breaks: false, gfm: true }) : `<p>${esc(safe)}</p>`;

    // Restore callout blocks (strip wrapping <p> if marked wrapped placeholder)
    html = html.replace(/<p>@@CALLOUT_BLOCK_(\d+)@@<\/p>|@@CALLOUT_BLOCK_(\d+)@@/g, (_, a, b) => {
      return calloutTokens[Number(a ?? b)] || '';
    });

    // 5. Render stashed math via KaTeX
    html = html.replace(/@@MATH_TOKEN_(\d+)@@/g, (_, idxStr) => {
      const item = mathTokens[Number(idxStr)];
      if (!item) return '';
      if (window.katex) {
        try {
          return window.katex.renderToString(item.tex.trim(), {
            displayMode: item.displayMode,
            throwOnError: false,
            strict: false,
          });
        } catch (err) {
          return `<code>${esc(item.tex)}</code>`;
        }
      }
      return item.displayMode ? `<pre>${esc(item.tex)}</pre>` : `<code>${esc(item.tex)}</code>`;
    });

    // 6. Post-process DOM cleanly: heading anchors, scrollable table wrappers, and zero-reload internal links
    if (html.includes('<table') || html.includes('<h') || html.includes('obsidian://')) {
      const content = document.createElement('template');
      content.innerHTML = html;

      // Tag headings with clean IDs for Outline click-to-jump and Scroll-Spy
      for (const h of content.content.querySelectorAll('h1, h2, h3, h4')) {
        const plain = (h.textContent || '').trim();
        if (plain) {
          if (!h.id) h.id = `ref-h-${headingSlug(plain)}`;
          h.dataset.headingTitle = plain;
        }
      }

      // Wrap tables in horizontal scroll wrappers & prevent 1-char column crushes (like Ch. -> C/h.)
      for (const tbl of content.content.querySelectorAll('table')) {
        if (tbl.parentElement?.classList?.contains('md-table-wrap')) continue;
        const wrap = document.createElement('div');
        wrap.className = 'md-table-wrap';
        tbl.replaceWith(wrap);
        wrap.appendChild(tbl);
        const firstTh = tbl.querySelector('thead th:first-child');
        if (firstTh && firstTh.textContent.trim().length <= 6) {
          tbl.classList.add('md-tbl-compact-first');
        }
        const lastTh = tbl.querySelector('thead th:last-child');
        if (lastTh && /link|ref|ch\.?|go/i.test(lastTh.textContent.trim())) {
          tbl.classList.add('md-tbl-compact-last');
        }
      }

      // Rewrite obsidian:// internal links so clicking "Ch. 1" or "Worked Examples" jumps smoothly in-app
      if (window.StudyApp?.isStaticMode() && html.includes('obsidian://')) {
        for (const link of content.content.querySelectorAll('a[href^="obsidian://"]')) {
          try {
            const url = new URL(link.getAttribute('href'));
            const [file, ...headingParts] = (url.searchParams.get('file') || '').split('#');
            const headingStr = headingParts.join('#');
            const target = window.StudyApp.publicReferenceUrl(file, headingStr);
            if (target) {
              link.href = target;
              link.dataset.refJumpFile = file || '';
              link.dataset.refJumpHeading = headingStr || '';
              link.classList.add('obs-internal-link');
            } else {
              const label = document.createElement('span');
              label.className = 'muted';
              label.title = 'See the original course or local archive for this source.';
              label.replaceChildren(...link.childNodes);
              link.replaceWith(label);
            }
          } catch {}
        }
      }
      return content.innerHTML;
    }

    return html;
  }

  const OUTLINE_STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'what', 'when', 'where', 'which',
    'have', 'has', 'are', 'was', 'were', 'not', 'but', 'all', 'any', 'can', 'how', 'why', 'use', 'using',
    'find', 'calculate', 'compute', 'determine', 'show', 'explain', 'part', 'question', 'exercise', 'problem',
    'task', 'exam', 'autumn', 'spring', 'mock', 'session', 'tutoring', 'pts', 'points', 'total', 'above',
    'below', 'given', 'following', 'data', 'table', 'figure', 'ltd', 'company', 'firm', 'year', 'years',
    'topic', 'chapter', 'lecture', 'unit', 'core', 'micro', 'macro', 'slides', 'summary', 'overview',
    // Generic math & structural terms that cause noisy false-positive chapter matches
    'function', 'functions', 'graph', 'graphs', 'curve', 'curves', 'value', 'values', 'point', 'points',
    'formula', 'formulas', 'equation', 'equations', 'expression', 'expressions', 'number', 'numbers',
    'standard', 'form', 'forms', 'basic', 'rule', 'rules', 'method', 'methods', 'pattern', 'patterns',
    'worked', 'example', 'examples', 'check', 'solve', 'solving', 'means', 'treat', 'whole', 'used',
    'later', 'together', 'interpret', 'interpretation', 'valid', 'separate', 'right', 'other', 'different',
    'first', 'second', 'third', 'one', 'two', 'three', 'step', 'steps', 'result', 'results', 'note', 'notes',
    'variable', 'variables', 'general', 'special', 'case', 'cases', 'kind', 'kinds', 'read', 'sketch',
    'inspect', 'without', 'inside', 'before', 'after', 'multiple', 'single', 'open', 'closed', 'word',
  ]);
  const META_HEADING_RE = /^(course index|method & formula finder|source map|verification|setup|exam strategy|coverage and sources|quick index|table of contents)/i;
  const FOUNDATIONAL_HEADING_RE = /\b(basic derivatives|differentiation rules|tangents and differentiation|derivative as a limit|combining functions|lines and simultaneous|quadratic functions|polynomials,?\s*division|factorisation|algebraic|exponential and logarithmic rules|arithmetic|powers and roots|fractions|elementary|fundamentals|prerequisites|beginner map)\b/i;

  function stemConceptToken(tok) {
    let s = String(tok || '').toLowerCase();
    if (s.length <= 4) return s;
    if (s.endsWith('ies') && s.length > 5) return `${s.slice(0, -3)}y`;
    if (s.endsWith('es') && /(ches|shes|xes|zes|ses)$/.test(s) && s.length > 5) return s.slice(0, -2);
    if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) return s.slice(0, -1);
    return s;
  }

  function tokenizeConceptText(str) {
    const raw = String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9æøå]+/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !OUTLINE_STOP_WORDS.has(w) && !/^\d+$/.test(w));
    const out = new Set();
    for (const w of raw) {
      out.add(w);
      const st = stemConceptToken(w);
      if (st.length >= 3 && !OUTLINE_STOP_WORDS.has(st)) out.add(st);
    }
    return [...out];
  }

  function findRelevantReferenceHeadings(question, courseMeta, toc = [], bank = null) {
    const empty = {
      primaryHeading: '',
      primaryChapterLine: null,
      primaryChapterTitle: '',
      coreHeadings: [],
      backgroundHeadings: [],
      relatedHeadings: new Set(),
      relatedChapterLines: new Set(),
      backgroundSet: new Set(),
    };
    if (!question || !Array.isArray(toc) || !toc.length) return empty;

    const qHeading = String(question.obsidianLink?.heading || '').trim();
    const topicObj = (bank?.topics || []).find((t) => String(t.id) === String(question.topicId));
    const topicNumMatch = String(question.topicId || '').match(/\d+/);
    const topicNum = topicNumMatch ? topicNumMatch[0] : '';

    // Map each TOC entry to its enclosing H2 chapter + count H3 children per H2
    const chapterLineFor = new Map();
    const chapterTitleFor = new Map();
    const chapterChildrenCount = new Map();
    let curH2 = null;
    for (const h of toc) {
      if (h.level <= 2) curH2 = h;
      const chLine = curH2 ? curH2.line : h.line;
      chapterLineFor.set(h.line, chLine);
      chapterTitleFor.set(h.line, curH2 ? curH2.title : h.title);
      if (h.level === 3 && curH2) {
        chapterChildrenCount.set(curH2.line, (chapterChildrenCount.get(curH2.line) || 0) + 1);
      }
    }

    // 1. Resolve Primary heading (prefer specific H3 over whole H2 when prompt matches an H3 inside that chapter)
    let primary = null;
    if (qHeading) {
      const qNorm = qHeading.toLowerCase();
      primary = toc.find((h) => h.title.toLowerCase() === qNorm)
        || toc.find((h) => h.title.toLowerCase().includes(qNorm) || (h.title.length >= 8 && qNorm.includes(h.title.toLowerCase())));
    }
    if (!primary && topicObj?.obsidianHeading) {
      const tNorm = String(topicObj.obsidianHeading).toLowerCase();
      primary = toc.find((h) => h.title.toLowerCase() === tNorm || h.title.toLowerCase().includes(tNorm));
    }
    if (!primary && topicNum) {
      const topicRe = new RegExp(`(^|\\b)(topic|ch\\.?|chapter|lesson|module|section)\\s*0?${topicNum}\\b|^${topicNum}\\.\\s`, 'i');
      primary = toc.find((h) => h.level === 2 && topicRe.test(h.title))
        || toc.find((h) => h.level === 3 && topicRe.test(h.title));
    }

    const basePrimaryChapterLine = primary ? chapterLineFor.get(primary.line) : null;
    const basePrimaryChapterTitle = primary ? chapterTitleFor.get(primary.line) : '';

    // 2. Score all candidate chapters/subchapters with stem-aware precision + foundational/mastery balancing
    const promptCoreText = [
      question.title || '',
      (question.tags || []).join(' '),
      (question.promptMarkdown || '').slice(0, 900),
      (question.wiseflowFields || []).map((f) => `${f.label || ''} ${f.group || ''}`).join(' '),
    ].join(' ');
    const hintAndTopicText = [
      (question.hints || []).join(' '),
      topicObj?.title || '',
    ].join(' ');

    const coreTokens = new Set(tokenizeConceptText(promptCoreText));
    const auxTokens = new Set(tokenizeConceptText(hintAndTopicText));
    const qLower = `${promptCoreText} ${hintAndTopicText}`.toLowerCase();

    // Catch explicit cross-references like "Ch. 8", "Topic 5"
    const explicitNums = new Set();
    for (const m of `${promptCoreText} ${hintAndTopicText}`.matchAll(/\b(?:topic|ch\.?|chapter|lesson|unit|module)\s*0?(\d{1,2})\b/gi)) {
      explicitNums.add(m[1]);
    }

    // Score candidate subchapters (prefer H3s; include H2s only if they have no H3 children)
    const candidates = [];
    for (const h of toc) {
      if (h.level < 2 || h.level > 3) continue;
      if (META_HEADING_RE.test(h.title)) continue;
      const hasH3Children = h.level === 2 && (chapterChildrenCount.get(h.line) || 0) > 0;
      const hClean = cleanOutlineTitle(h.title);
      const rawTerms = String(hClean || '')
        .toLowerCase()
        .replace(/[^a-z0-9æøå]+/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !OUTLINE_STOP_WORDS.has(w) && !/^\d+$/.test(w));
      const uniqueStems = [...new Set(rawTerms.map(stemConceptToken).filter((s) => s.length >= 3 && !OUTLINE_STOP_WORDS.has(s)))];
      if (!uniqueStems.length) continue;

      let score = 0;
      let coreHits = 0;
      let auxHits = 0;
      for (const st of uniqueStems) {
        if (coreTokens.has(st)) {
          score += st.length >= 6 ? 4.2 : 2.6;
          coreHits++;
        } else if (st.length >= 5 && promptCoreText.toLowerCase().includes(st)) {
          score += 3.0;
          coreHits++;
        } else if (auxTokens.has(st)) {
          score += st.length >= 6 ? 1.8 : 1.1;
          auxHits++;
        } else if (st.length >= 6 && qLower.includes(st)) {
          score += 1.0;
          auxHits++;
        }
      }

      const hNumMatch = hClean.match(/^(?:topic|ch\.?|chapter|lesson)?\s*0?(\d{1,2})(?:\.|\b)/i);
      const hChapterNum = hNumMatch ? hNumMatch[1] : '';
      const explicitCross = Boolean(hChapterNum && explicitNums.has(hChapterNum) && hChapterNum !== topicNum);
      if (explicitCross) {
        score += 5.5;
        coreHits++;
      }

      const chLine = chapterLineFor.get(h.line);
      const inPrimaryChapter = basePrimaryChapterLine !== null && chLine === basePrimaryChapterLine;
      if (inPrimaryChapter && h.level === 3 && (coreHits > 0 || auxHits > 0)) {
        score += 1.8;
      }

      // Check whether this section is an assumed/foundational prerequisite (or already mastered outside primary chapter)
      const isFoundationalTitle = FOUNDATIONAL_HEADING_RE.test(hClean) || FOUNDATIONAL_HEADING_RE.test(chapterTitleFor.get(h.line) || '');
      const topicReady = (!inPrimaryChapter && hChapterNum && courseMeta?.courseId)
        ? window.StudyApp?.getTopicReadiness?.(courseMeta.courseId, hChapterNum)
        : null;
      const isMasteredCrossChapter = Boolean(topicReady && (topicReady.status === 'ready' || Number(topicReady.coveragePct || 0) >= 70));
      const isAssumedBackground = !inPrimaryChapter && !explicitCross && (isFoundationalTitle || isMasteredCrossChapter);

      const minScore = inPrimaryChapter ? 2.4 : 4.2;
      if ((coreHits >= 1 && score >= minScore) || (coreHits + auxHits >= 2 && score >= minScore + 1.0)) {
        candidates.push({
          h,
          chLine,
          hChapterNum,
          hasH3Children,
          inPrimaryChapter,
          isAssumedBackground,
          score: hasH3Children ? score * 0.72 : score,
          coreHits,
        });
      }
    }

    // If primary was a broad H2 chapter with H3 children, narrow primary to its best matching H3 child!
    const primaryH3Matches = candidates
      .filter((c) => c.inPrimaryChapter && c.h.level === 3)
      .sort((a, b) => b.score - a.score || a.h.line - b.h.line);
    if (primary && primary.level === 2 && (chapterChildrenCount.get(primary.line) || 0) > 0 && primaryH3Matches.length > 0) {
      primary = primaryH3Matches[0].h;
    }

    const primaryHeading = primary?.title || '';
    const primaryChapterLine = primary ? chapterLineFor.get(primary.line) : basePrimaryChapterLine;
    const primaryChapterTitle = primary ? chapterTitleFor.get(primary.line) : basePrimaryChapterTitle;

    // Select tight Core Needed (max 3 total including primary) vs Assumed Background (max 3)
    const coreEntries = [];
    const bgEntries = [];
    const usedLines = new Set();
    if (primary) {
      coreEntries.push(primary);
      usedLines.add(primary.line);
    }

    // Prefer specific H3 candidates over parent H2s that already have H3 matches
    const matchedH3Chapters = new Set(candidates.filter((c) => c.h.level === 3).map((c) => c.chLine));
    const filtered = candidates
      .filter((c) => !usedLines.has(c.h.line))
      .filter((c) => !(c.hasH3Children && matchedH3Chapters.has(c.chLine)))
      .sort((a, b) => b.score - a.score || a.h.line - b.h.line);

    const perChapterCore = new Map();
    if (primary) perChapterCore.set(chapterLineFor.get(primary.line), 1);

    for (const item of filtered) {
      if (item.isAssumedBackground) {
        if (bgEntries.length < 3 && !bgEntries.some((x) => x.line === item.h.line)) {
          bgEntries.push(item.h);
        }
        continue;
      }
      if (coreEntries.length >= 3) {
        if (bgEntries.length < 3 && item.score >= 4.0) bgEntries.push(item.h);
        continue;
      }
      const chCount = perChapterCore.get(item.chLine) || 0;
      if (chCount >= 2) {
        if (bgEntries.length < 3 && item.score >= 4.0) bgEntries.push(item.h);
        continue;
      }
      coreEntries.push(item.h);
      usedLines.add(item.h.line);
      perChapterCore.set(item.chLine, chCount + 1);
    }

    // Keep continuous reading order (ascending line order in the book!)
    coreEntries.sort((a, b) => a.line - b.line);
    bgEntries.sort((a, b) => a.line - b.line);

    const coreHeadings = coreEntries.map((h) => h.title);
    const backgroundHeadings = bgEntries.map((h) => h.title);
    const relatedHeadings = new Set(coreHeadings.filter((t) => t !== primaryHeading));
    const relatedChapterLines = new Set(coreEntries.map((h) => chapterLineFor.get(h.line)));
    const backgroundSet = new Set(backgroundHeadings);

    return {
      primaryHeading,
      primaryChapterLine,
      primaryChapterTitle,
      coreHeadings,
      backgroundHeadings,
      relatedHeadings,
      relatedChapterLines,
      backgroundSet,
    };
  }

  function buildOutlineTreeHtml(toc = [], {
    activeHeading = '',
    primaryHeading = '',
    relatedHeadings = new Set(),
    relatedChapterLines = new Set(),
    backgroundHeadings = new Set(),
    primaryChapterLine = null,
    filter = '',
    collapsedByDefault = false,
  } = {}) {
    const items = (toc || []).filter((h) => h.level >= 2 && h.level <= 4);
    if (!items.length) return '<p class="muted" style="font-size:12px;padding:6px">No headings in this note.</p>';

    const q = String(filter || '').trim().toLowerCase();
    const activeNorm = String(activeHeading || '').trim().toLowerCase();
    const primaryNorm = String(primaryHeading || '').trim().toLowerCase();

    // Build H2 -> H3 -> H4 nested tree
    const chapters = [];
    let curH2 = null;
    let curH3 = null;
    for (const h of items) {
      const node = { ...h, label: cleanOutlineTitle(h.title), children: [] };
      if (h.level === 2) {
        curH2 = node;
        curH3 = null;
        chapters.push(node);
      } else if (h.level === 3) {
        if (!curH2) {
          curH2 = { level: 2, title: 'Overview', label: 'Overview', line: 0, children: [] };
          chapters.push(curH2);
        }
        curH3 = node;
        curH2.children.push(node);
      } else {
        if (curH3) curH3.children.push(node);
        else if (curH2) curH2.children.push(node);
        else {
          curH2 = { level: 2, title: 'Overview', label: 'Overview', line: 0, children: [node] };
          chapters.push(curH2);
        }
      }
    }

    const matchesFilter = (node) => {
      if (!q) return true;
      if (node.label.toLowerCase().includes(q) || node.title.toLowerCase().includes(q)) return true;
      return (node.children || []).some(matchesFilter);
    };

    const nodeHasHighlight = (node) => {
      const t = node.title;
      const tLow = t.toLowerCase();
      if (tLow === activeNorm || tLow === primaryNorm || relatedHeadings.has(t)) return true;
      return (node.children || []).some(nodeHasHighlight);
    };

    const renderNode = (node, depth) => {
      if (!matchesFilter(node)) return '';
      const tLow = node.title.toLowerCase();
      const isActive = Boolean(activeNorm && tLow === activeNorm);
      const isPrimary = Boolean(primaryNorm && tLow === primaryNorm);
      const isRelated = !isPrimary && relatedHeadings.has(node.title);
      const isBackground = !isPrimary && !isRelated && backgroundHeadings.has(node.title);
      const isChapterRel = depth === 0 && !isPrimary && !isRelated && relatedChapterLines.has(node.line);
      const visibleChildren = (node.children || []).filter(matchesFilter);
      const hasChildren = visibleChildren.length > 0;

      const badge = isPrimary
        ? '<span class="obs-outline-tag is-primary">Needed</span>'
        : isRelated
        ? '<span class="obs-outline-tag is-related">Needed</span>'
        : isBackground
        ? '<span class="obs-outline-tag is-bg" title="Assumed background — expandable if needed">Assumed</span>'
        : isChapterRel
        ? '<span class="obs-outline-dot" title="Contains a needed subchapter"></span>'
        : '';

      const btnCls = [
        'obs-outline-link',
        `depth-${depth}`,
        isActive ? 'is-active' : '',
        isPrimary ? 'is-primary' : '',
        isRelated ? 'is-related' : '',
        isBackground ? 'is-bg' : '',
      ].filter(Boolean).join(' ');

      const linkBtn = `<button type="button" class="${btnCls}" data-outline-heading="${esc(node.title)}" data-outline-line="${node.line}" title="${esc(node.label)}"><span class="obs-outline-text">${esc(node.label)}</span>${badge}</button>`;

      if (!hasChildren) {
        return `<div class="obs-outline-leaf depth-${depth}">${linkBtn}</div>`;
      }

      const shouldOpen = Boolean(q || nodeHasHighlight(node) || (depth === 0 && primaryChapterLine === node.line) || !collapsedByDefault);
      return `<details class="obs-outline-branch depth-${depth}"${shouldOpen ? ' open' : ''}>
        <summary class="obs-outline-row">
          <span class="obs-outline-chev" aria-hidden="true"></span>
          ${linkBtn}
        </summary>
        <div class="obs-outline-children">
          ${visibleChildren.map((child) => renderNode(child, depth + 1)).join('')}
        </div>
      </details>`;
    };

    const rendered = chapters.map((ch) => renderNode(ch, 0)).filter(Boolean).join('');
    return rendered || '<p class="muted" style="font-size:12px;padding:6px">No matching headings.</p>';
  }

  let toastTimer = null;
  function toast(msg, ms = 2800) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }

  // Theme & PDF Dark Mode (defaults to System Light/Dark)
  const THEME_KEY = 'study-os-theme-v2';
  const LEGACY_THEME_KEY = 'study-os-theme-v1';
  let systemThemeListenerBound = false;

  function getSystemTheme() {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function normalizeThemeMode(raw) {
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  }

  function getThemePrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(THEME_KEY));
      if (saved && typeof saved === 'object') return saved;
    } catch {}
    // Preserve prior PDF inversion preference while defaulting appearance to System.
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_THEME_KEY));
      if (legacy && typeof legacy === 'object' && legacy.pdfDark !== undefined) {
        return { theme: 'system', pdfDark: !!legacy.pdfDark };
      }
    } catch {}
    return { theme: 'system' };
  }

  function saveThemePrefs(prefs) {
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(prefs));
    } catch {}
  }

  function applyTheme(prefs = getThemePrefs()) {
    const mode = normalizeThemeMode(prefs.theme);
    const effective = mode === 'system' ? getSystemTheme() : mode;
    const pdfDark = prefs.pdfDark !== undefined ? !!prefs.pdfDark : true;
    document.documentElement.dataset.theme = effective;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.pdfDark = pdfDark ? '1' : '0';

    const metaTheme = document.getElementById('meta-theme-color');
    if (metaTheme) metaTheme.setAttribute('content', effective === 'dark' ? '#090d0c' : '#f3f5f7');

    document.querySelectorAll('#settings-theme-seg [data-theme-val]').forEach((btn) => {
      const active = btn.dataset.themeVal === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const themeSub = document.getElementById('settings-theme-sub');
    if (themeSub) {
      if (mode === 'system') {
        themeSub.textContent = `Following system (${effective === 'dark' ? 'Dark' : 'Light'})`;
      } else {
        themeSub.textContent = mode === 'dark' ? 'Always dark appearance' : 'Always light appearance';
      }
    }

    const pdfToggle = document.getElementById('settings-pdf-dark-toggle');
    if (pdfToggle) pdfToggle.checked = pdfDark;
    const pdfRow = document.getElementById('settings-pdf-dark-row');
    if (pdfRow) pdfRow.classList.toggle('ios-row-muted', effective !== 'dark');
    const pdfSub = document.getElementById('settings-pdf-dark-sub');
    if (pdfSub) {
      pdfSub.textContent = effective === 'dark'
        ? 'Turns white exam excerpts dark'
        : 'Applies automatically when Dark appearance is active';
    }

    const hideStudyHelp = prefs.hideStudyHelp === true;
    document.documentElement.toggleAttribute('data-hide-study-help', hideStudyHelp);
    const helpToggle = document.getElementById('settings-hide-study-help');
    if (helpToggle) helpToggle.checked = hideStudyHelp;
    document.querySelectorAll('#settings-body [data-study-help]').forEach((el) => { el.hidden = hideStudyHelp; });
  }

  function setTheme(theme) {
    const p = getThemePrefs();
    p.theme = normalizeThemeMode(theme);
    if (p.pdfDark === undefined) p.pdfDark = true;
    saveThemePrefs(p);
    applyTheme(p);
  }

  function setPdfDark(enabled) {
    const p = getThemePrefs();
    p.theme = normalizeThemeMode(p.theme);
    p.pdfDark = Boolean(enabled);
    saveThemePrefs(p);
    applyTheme(p);
  }

  function getThemeMode() {
    return normalizeThemeMode(getThemePrefs().theme);
  }

  function toggleTheme() {
    const mode = getThemeMode();
    const next = mode === 'system'
      ? (getSystemTheme() === 'dark' ? 'light' : 'dark')
      : mode === 'dark'
        ? 'light'
        : 'system';
    setTheme(next);
    return next;
  }

  function togglePdfDark() {
    setPdfDark(document.documentElement.dataset.pdfDark !== '1');
  }

  // Progressive chapter-chunked renderer (eliminates mobile iOS/Safari lag on 100KB+ KaTeX notes)
  function splitMarkdownIntoChapters(markdown) {
    const lines = String(markdown || '').split('\n');
    const chunks = [];
    let curLines = [];
    let curTitle = '';
    let curStartLine = 0;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (!inFence && /^##\s+/.test(line) && curLines.some((l) => l.trim().length > 0)) {
        chunks.push({ title: curTitle, startLine: curStartLine, markdown: curLines.join('\n') });
        curLines = [line];
        curTitle = line.replace(/^##\s+/, '').trim();
        curStartLine = i;
      } else {
        if (!inFence && /^##\s+/.test(line) && !curTitle) {
          curTitle = line.replace(/^##\s+/, '').trim();
          curStartLine = i;
        }
        curLines.push(line);
      }
    }
    if (curLines.length) {
      chunks.push({ title: curTitle, startLine: curStartLine, markdown: curLines.join('\n') });
    }
    return chunks;
  }

  function renderNoteProgressive(containerEl, markdown, {
    scrollRoot = null,
    initialHeading = '',
    onLinkJump = null,
    onActiveHeading = null,
  } = {}) {
    if (!containerEl) return { abort() {}, jumpToHeading() {} };
    // Cancel any previous progressive job attached to this container
    if (typeof containerEl._progressiveAbort === 'function') {
      containerEl._progressiveAbort();
    }

    let aborted = false;
    let idleTimer = null;
    let io = null;
    let scrollCleanup = null;

    const abort = () => {
      aborted = true;
      clearTimeout(idleTimer);
      if (io) { io.disconnect(); io = null; }
      if (scrollCleanup) { scrollCleanup(); scrollCleanup = null; }
    };
    containerEl._progressiveAbort = abort;

    const chunks = splitMarkdownIntoChapters(markdown);
    if (!chunks.length) {
      containerEl.innerHTML = '';
      return { abort, jumpToHeading() {} };
    }

    // Small sections (< 18 KB or <= 2 chunks): render synchronously immediately
    const isLarge = String(markdown || '').length > 18000 && chunks.length > 2;
    const frag = document.createDocumentFragment();
    const sections = chunks.map((ch, idx) => {
      const sec = document.createElement('section');
      sec.className = 'ref-chapter-block';
      sec.dataset.chapterIdx = String(idx);
      sec.dataset.chapterTitle = ch.title || '';
      sec.dataset.rendered = '0';
      if (isLarge && idx > 0) {
        const cleanTitle = cleanOutlineTitle(ch.title || `Section ${idx + 1}`);
        sec.innerHTML = `<div class="ref-chapter-placeholder"><span>${esc(cleanTitle)}</span></div>`;
      }
      frag.appendChild(sec);
      return sec;
    });

    containerEl.innerHTML = '';
    containerEl.appendChild(frag);

    const hydrateIdx = (idx) => {
      if (aborted || idx < 0 || idx >= chunks.length) return;
      const sec = sections[idx];
      if (!sec || sec.dataset.rendered === '1') return;
      sec.dataset.rendered = '1';
      sec.innerHTML = renderMarkdownWithMath(chunks[idx].markdown);
    };

    const findChunkIndexForHeading = (headingStr) => {
      const qNorm = String(headingStr || '').trim().toLowerCase();
      if (!qNorm) return -1;
      const qClean = cleanOutlineTitle(qNorm).toLowerCase();
      // 1. Check chapter H2 titles first
      let idx = chunks.findIndex((c) => {
        const t = c.title.toLowerCase();
        const tc = cleanOutlineTitle(t).toLowerCase();
        return t === qNorm || tc === qClean || t.includes(qNorm) || (qClean.length >= 6 && tc.includes(qClean));
      });
      if (idx >= 0) return idx;
      // 2. Check subheadings inside each chunk's raw markdown
      idx = chunks.findIndex((c) => {
        const low = c.markdown.toLowerCase();
        return low.includes(qNorm) || (qClean.length >= 6 && low.includes(qClean));
      });
      return idx;
    };

    const jumpToHeading = (headingStr, smooth = true) => {
      if (aborted) return false;
      const qStr = String(headingStr || '').trim();
      if (!qStr) {
        if (scrollRoot) scrollRoot.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
        else containerEl.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
        return true;
      }
      const cIdx = findChunkIndexForHeading(qStr);
      if (cIdx >= 0) {
        hydrateIdx(cIdx);
        if (cIdx > 0) hydrateIdx(cIdx - 1);
        if (cIdx + 1 < chunks.length) hydrateIdx(cIdx + 1);
      } else {
        // Hydrate all if heading wasn't matched directly
        for (let i = 0; i < chunks.length; i++) hydrateIdx(i);
      }
      const qSlug = headingSlug(qStr);
      const qNorm = qStr.toLowerCase();
      const qClean = cleanOutlineTitle(qNorm).toLowerCase();
      const scope = cIdx >= 0 ? sections[cIdx] : containerEl;
      let target = scope.querySelector(`#ref-h-${CSS.escape(qSlug)}`);
      if (!target) {
        const hs = [...scope.querySelectorAll('h1, h2, h3, h4')];
        target = hs.find((h) => {
          const t = (h.dataset.headingTitle || h.textContent || '').trim().toLowerCase();
          return t === qNorm || t === qClean || t.includes(qNorm) || (qClean.length >= 6 && t.includes(qClean));
        }) || scope;
      }
      if (target) {
        target.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' });
        return true;
      }
      return false;
    };

    // Intercept internal Obsidian links inside the note body cleanly (no new tab reload!)
    containerEl.onclick = (ev) => {
      const a = ev.target?.closest?.('a[data-ref-jump-file], a[data-ref-jump-heading]');
      if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (typeof onLinkJump === 'function') {
        ev.preventDefault();
        onLinkJump(a.dataset.refJumpFile || '', a.dataset.refJumpHeading || '');
      }
    };

    if (!isLarge) {
      for (let i = 0; i < chunks.length; i++) hydrateIdx(i);
      if (initialHeading) jumpToHeading(initialHeading, false);
    } else {
      // Frame 0: render intro + chapter 1 (and target chapter if deep-linked)
      hydrateIdx(0);
      if (chunks.length > 1) hydrateIdx(1);
      if (initialHeading) {
        jumpToHeading(initialHeading, false);
      }

      // Lazy hydrate approaching chapters via IntersectionObserver
      if ('IntersectionObserver' in window) {
        io = new IntersectionObserver((entries) => {
          for (const ent of entries) {
            if (ent.isIntersecting) {
              const i = Number(ent.target.dataset.chapterIdx);
              hydrateIdx(i);
              io?.unobserve(ent.target);
            }
          }
        }, { root: scrollRoot || null, rootMargin: '850px 0px' });
        sections.forEach((sec) => {
          if (sec.dataset.rendered !== '1') io.observe(sec);
        });
      }

      // Gentle idle hydration: 1 chapter per turn so scrolling on iPhone 13 Pro stays 60-120fps
      let nextIdleIdx = 0;
      const pumpIdle = () => {
        if (aborted) return;
        while (nextIdleIdx < chunks.length && sections[nextIdleIdx].dataset.rendered === '1') {
          nextIdleIdx++;
        }
        if (nextIdleIdx >= chunks.length) return;
        hydrateIdx(nextIdleIdx);
        nextIdleIdx++;
        idleTimer = setTimeout(pumpIdle, 45);
      };
      idleTimer = setTimeout(pumpIdle, 180);
    }

    // Throttled Scroll-Spy to highlight the active heading in the Outline tree
    if (typeof onActiveHeading === 'function') {
      let spyTick = 0;
      const targetWin = scrollRoot || window;
      const runSpy = () => {
        spyTick = 0;
        if (aborted) return;
        const rootTop = scrollRoot ? scrollRoot.getBoundingClientRect().top : 78;
        const headings = containerEl.querySelectorAll('h2[data-heading-title], h3[data-heading-title], h4[data-heading-title]');
        let best = '';
        for (const h of headings) {
          const rect = h.getBoundingClientRect();
          if (rect.top <= rootTop + 96) {
            best = h.dataset.headingTitle || '';
          } else {
            break;
          }
        }
        if (best) onActiveHeading(best);
      };
      const onScroll = () => {
        if (!spyTick) spyTick = requestAnimationFrame(runSpy);
      };
      targetWin.addEventListener('scroll', onScroll, { passive: true });
      scrollCleanup = () => {
        targetWin.removeEventListener('scroll', onScroll);
        if (spyTick) cancelAnimationFrame(spyTick);
      };
    }

    return { abort, jumpToHeading };
  }

  // Slide-Over Course Reference Sidebar (ChatGPT + Obsidian smart multi-chapter drawer)
  let drawerNotes = [];
  let currentNoteFile = '';
  let drawerCourseMeta = null;
  let drawerContext = { question: null, bank: null };
  let drawerToc = [];
  let drawerSelectedHeading = '';
  let drawerCloseTimer = null;
  const REF_DRAWER_WIDTH_KEY = 'study-os-ref-sidebar-w';

  function isReferenceDrawerOpen() {
    const drawer = document.getElementById('ref-drawer');
    return Boolean(drawer && !drawer.hidden && drawer.classList.contains('is-open'));
  }

  function applySavedRefDrawerWidth() {
    const drawer = document.getElementById('ref-drawer');
    if (!drawer) return;
    try {
      const saved = Number(localStorage.getItem(REF_DRAWER_WIDTH_KEY) || 0);
      if (saved >= 260 && saved <= 580) {
        drawer.style.setProperty('--ref-drawer-w', `${Math.round(saved)}px`);
      }
    } catch {}
  }

  let drawerMode = 'needed'; // 'needed' | 'section'
  let drawerShowBg = false;
  let drawerTocOpen = false;
  let drawerRel = null;

  function shortSectionChipLabel(title) {
    const clean = cleanOutlineTitle(title || '');
    const m = clean.match(/^(\d+(?:\.\d+)?)\.?\s+(.*)$/);
    if (m) {
      const rest = m[2].length > 22 ? `${m[2].slice(0, 21).trim()}…` : m[2];
      return `${m[1]} ${rest}`;
    }
    return clean.length > 26 ? `${clean.slice(0, 25).trim()}…` : clean;
  }

  function setDrawerTocOpen(open) {
    drawerTocOpen = Boolean(open);
    const panel = document.getElementById('ref-drawer-toc-panel');
    const bodyEl = document.getElementById('ref-drawer-body');
    const browseBtn = document.getElementById('ref-drawer-browse-btn');
    const soloBtn = document.getElementById('ref-drawer-browse-solo');
    const filterEl = document.getElementById('ref-drawer-outline-filter');
    if (panel) panel.hidden = !drawerTocOpen;
    if (bodyEl) bodyEl.hidden = drawerTocOpen;
    browseBtn?.classList.toggle('active', drawerTocOpen);
    browseBtn?.setAttribute('aria-expanded', String(drawerTocOpen));
    soloBtn?.classList.toggle('active', drawerTocOpen);
    soloBtn?.setAttribute('aria-expanded', String(drawerTocOpen));
    if (drawerTocOpen) {
      renderDrawerOutline();
      setTimeout(() => filterEl?.focus(), 20);
    }
  }

  function renderDrawerOutline() {
    const treeEl = document.getElementById('ref-drawer-outline-tree');
    const filterEl = document.getElementById('ref-drawer-outline-filter');
    const modeTabs = document.getElementById('ref-drawer-mode-tabs');
    const neededBtn = document.getElementById('ref-drawer-needed-btn');
    const soloBtn = document.getElementById('ref-drawer-browse-solo');
    const jumpStrip = document.getElementById('ref-drawer-jump-strip');
    if (!treeEl) return;

    const rel = drawerToc.length
      ? findRelevantReferenceHeadings(drawerContext.question, drawerCourseMeta, drawerToc, drawerContext.bank)
      : { primaryHeading: '', primaryChapterLine: null, primaryChapterTitle: '', coreHeadings: [], backgroundHeadings: [], relatedHeadings: new Set(), relatedChapterLines: new Set(), backgroundSet: new Set() };
    drawerRel = rel;
    const hasNeeded = Boolean(drawerContext.question && rel.coreHeadings.length > 0);
    if (modeTabs) modeTabs.hidden = !hasNeeded;
    if (soloBtn) soloBtn.hidden = hasNeeded || !drawerToc.length;
    if (neededBtn && hasNeeded) {
      const activeCount = rel.coreHeadings.length + (drawerShowBg ? rel.backgroundHeadings.length : 0);
      neededBtn.textContent = `Needed (${activeCount})`;
      neededBtn.classList.toggle('active', drawerMode === 'needed' && !drawerTocOpen);
    }

    if (jumpStrip) {
      if (hasNeeded && drawerMode === 'needed' && !drawerTocOpen) {
        const shownHeadings = drawerShowBg ? [...rel.coreHeadings, ...rel.backgroundHeadings] : rel.coreHeadings;
        const chipsHtml = shownHeadings
          .map((h, idx) => `<button type="button" class="ref-jump-chip${rel.backgroundSet.has(h) ? ' is-bg' : ''}" data-drawer-jump-idx="${idx}" title="${esc(cleanOutlineTitle(h))}">${esc(shortSectionChipLabel(h))}</button>`)
          .join('');
        const bgToggle = rel.backgroundHeadings.length
          ? `<button type="button" class="ref-jump-chip is-bg-toggle${drawerShowBg ? ' active' : ''}" data-drawer-toggle-bg title="Toggle assumed background sections">${drawerShowBg ? 'Hide assumed' : `+${rel.backgroundHeadings.length} assumed`}</button>`
          : '';
        jumpStrip.innerHTML = `${chipsHtml}${bgToggle}`;
        jumpStrip.hidden = false;
        jumpStrip.querySelectorAll('[data-drawer-jump-idx]').forEach((btn) => {
          btn.onclick = () => {
            const target = document.querySelector(`#ref-drawer-body [data-ref-stream-idx="${btn.dataset.drawerJumpIdx}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
        });
        jumpStrip.querySelector('[data-drawer-toggle-bg]')?.addEventListener('click', () => {
          drawerShowBg = !drawerShowBg;
          loadDrawerSection(currentNoteFile, '', { forceNeeded: true });
        });
      } else if (!drawerTocOpen && drawerSelectedHeading && hasNeeded) {
        jumpStrip.innerHTML = `<span class="ref-current-crumb" title="${esc(cleanOutlineTitle(drawerSelectedHeading))}">${esc(cleanOutlineTitle(drawerSelectedHeading))}</span>`;
        jumpStrip.hidden = false;
      } else {
        jumpStrip.hidden = true;
      }
    }

    const filterVal = filterEl?.value || '';
    const fullNoteRow = !filterVal
      ? `<div class="obs-outline-leaf depth-0"><button type="button" class="obs-outline-link depth-0${drawerMode === 'section' && !drawerSelectedHeading ? ' is-active' : ''}" data-outline-heading="" title="Full Note Overview"><span class="obs-outline-text">Full Note / All Chapters</span></button></div>`
      : '';
    treeEl.innerHTML = fullNoteRow + buildOutlineTreeHtml(drawerToc, {
      activeHeading: drawerMode === 'section' ? drawerSelectedHeading : '',
      primaryHeading: rel.primaryHeading,
      primaryChapterLine: rel.primaryChapterLine,
      relatedHeadings: rel.relatedHeadings,
      relatedChapterLines: rel.relatedChapterLines,
      backgroundHeadings: rel.backgroundSet,
      filter: filterVal,
      collapsedByDefault: true,
    });

    treeEl.querySelectorAll('[data-outline-heading]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const heading = btn.dataset.outlineHeading || '';
        drawerMode = 'section';
        setDrawerTocOpen(false);
        loadDrawerSection(currentNoteFile, heading, { forceSection: true });
      });
    });
  }

  async function openReferenceDrawer(courseMeta, targetFile = '', targetHeading = '', extraOpts = {}) {
    const drawer = document.getElementById('ref-drawer');
    const backdrop = document.getElementById('ref-backdrop');
    const courseSel = document.getElementById('ref-drawer-course-select');
    const noteSel = document.getElementById('ref-drawer-note-select');
    const bodyEl = document.getElementById('ref-drawer-body');
    const titleEl = document.getElementById('ref-drawer-title');
    const filterEl = document.getElementById('ref-drawer-outline-filter');
    const neededBtn = document.getElementById('ref-drawer-needed-btn');
    const browseBtn = document.getElementById('ref-drawer-browse-btn');
    const soloBtn = document.getElementById('ref-drawer-browse-solo');
    const tocClose = document.getElementById('ref-drawer-toc-close');

    const catalog = window.StudyApp?.getCatalog?.() || [];
    if (!courseMeta && catalog.length) courseMeta = catalog[0];
    drawerCourseMeta = courseMeta;
    drawerContext = {
      question: extraOpts?.question || null,
      bank: extraOpts?.bank || null,
    };
    drawerMode = drawerContext.question && !targetHeading ? 'needed' : 'section';
    drawerShowBg = false;
    drawerTocOpen = false;

    const obs = courseMeta?.obsidian || {};
    drawerNotes = [];
    if (obs.mainReference) drawerNotes.push({ label: 'Main Reference', file: obs.mainReference });
    if (obs.workedExamples) drawerNotes.push({ label: 'Worked Examples', file: obs.workedExamples });
    if (obs.practiceNote) drawerNotes.push({ label: 'Practice Note', file: obs.practiceNote });
    if (targetFile && !drawerNotes.some((n) => n.file === targetFile)) {
      drawerNotes.unshift({ label: targetFile.split('/').pop(), file: targetFile });
    }

    if (!drawerNotes.length) {
      toast('No reference note configured for this course.');
      return;
    }

    // Course switcher: shown whenever opened outside an active exercise
    if (courseSel) {
      const coursesWithNotes = catalog.filter((c) => c?.obsidian?.mainReference);
      const showCoursePicker = !drawerContext.question && coursesWithNotes.length > 1;
      courseSel.hidden = !showCoursePicker;
      if (showCoursePicker) {
        courseSel.innerHTML = coursesWithNotes
          .map((c) => `<option value="${esc(c.courseId)}" ${c.courseId === courseMeta?.courseId ? 'selected' : ''}>${esc(c.code)} · ${esc(c.shortTitle || c.title)}</option>`)
          .join('');
        courseSel.onchange = () => {
          const nextCourse = catalog.find((c) => c.courseId === courseSel.value);
          if (nextCourse) openReferenceDrawer(nextCourse, '', '');
        };
      }
    }

    currentNoteFile = targetFile || drawerNotes[0].file;
    noteSel.innerHTML = drawerNotes
      .map((n) => `<option value="${esc(n.file)}" ${n.file === currentNoteFile ? 'selected' : ''}>${esc(n.label)}</option>`)
      .join('');
    noteSel.hidden = drawerNotes.length <= 1;
    if (filterEl) {
      filterEl.value = '';
      filterEl.oninput = () => renderDrawerOutline();
    }
    if (neededBtn) {
      neededBtn.onclick = () => {
        drawerMode = 'needed';
        setDrawerTocOpen(false);
        loadDrawerSection(currentNoteFile, '', { forceNeeded: true });
      };
    }
    const toggleBrowse = () => setDrawerTocOpen(!drawerTocOpen);
    if (browseBtn) browseBtn.onclick = toggleBrowse;
    if (soloBtn) soloBtn.onclick = toggleBrowse;
    if (tocClose) tocClose.onclick = () => setDrawerTocOpen(false);

    clearTimeout(drawerCloseTimer);
    applySavedRefDrawerWidth();
    setDrawerTocOpen(false);
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    void drawer.offsetWidth;
    drawer.classList.add('is-open');
    backdrop.classList.add('is-open');
    document.getElementById('run-ref-btn')?.setAttribute('aria-expanded', 'true');

    titleEl.textContent = `${courseMeta?.shortTitle || 'Course'} · Notes`;
    bodyEl.innerHTML = '<p class="muted">Loading course note…</p>';

    await loadDrawerSection(currentNoteFile, targetHeading);

    noteSel.onchange = () => {
      currentNoteFile = noteSel.value;
      setDrawerTocOpen(false);
      loadDrawerSection(currentNoteFile, '', { forceNeeded: Boolean(drawerContext.question) });
    };
  }

  async function syncReferenceDrawerForQuestion(courseMeta, question, bank) {
    if (!isReferenceDrawerOpen() || !courseMeta || !question) return;
    await openReferenceDrawer(
      courseMeta,
      question.obsidianLink?.file || '',
      '',
      { question, bank }
    );
  }

  function renderContinuousNeededSectionsHtml(sections = [], { backgroundHeadings = [], showBg = false, isDrawer = false } = {}) {
    const attrExpand = isDrawer ? 'data-drawer-expand-heading' : 'data-inline-expand-heading';
    const attrShowBg = isDrawer ? 'data-drawer-show-bg' : 'data-inline-show-bg';
    const attrBrowse = isDrawer ? 'data-drawer-open-toc' : 'data-inline-open-toc';
    const blocks = sections.map((sec, idx) => {
      const chBtn = sec.chapterHeading && sec.chapterHeading !== sec.heading
        ? `<button type="button" class="ref-stream-expand-btn" ${attrExpand}="${esc(sec.chapterHeading)}" title="Expand full chapter: ${esc(cleanOutlineTitle(sec.chapterHeading))}">Expand Ch. ↗</button>`
        : '';
      const isBg = sec.isBackground;
      return `<section class="ref-stream-section${isBg ? ' is-bg-section' : ''}" data-ref-stream-idx="${idx}">
        <div class="ref-stream-divider">
          <span class="ref-stream-badge${isBg ? ' is-bg' : ''}">${isBg ? 'Assumed' : 'Needed'}</span>
          <span class="ref-stream-label">${esc(cleanOutlineTitle(sec.title || sec.heading))}</span>
          ${chBtn}
        </div>
        <div class="ref-stream-body">${renderMarkdownWithMath(sec.markdown || '')}</div>
      </section>`;
    }).join('');

    const bgFooter = backgroundHeadings.length && !showBg
      ? `<div class="ref-bg-footer">
           <div class="ref-bg-footer-copy">
             <strong>Assumed background hidden</strong>
             <small class="muted">${esc(backgroundHeadings.map((h) => cleanOutlineTitle(h)).join(' · '))}</small>
           </div>
           <button type="button" class="mini-tool-btn" ${attrShowBg}>Show inline</button>
         </div>`
      : '';
    const browseFooter = `<div class="ref-stream-footer-actions">
      <button type="button" class="mini-tool-btn" ${attrBrowse}>Expand past needed · Browse all chapters</button>
    </div>`;
    return `${blocks}${bgFooter}${browseFooter}`;
  }

  async function loadDrawerSection(relFile, heading, opts = {}) {
    const bodyEl = document.getElementById('ref-drawer-body');
    const uriEl = document.getElementById('ref-drawer-obsidian-uri');
    uriEl.hidden = true;
    try {
      let data = window.StudyApp?.fetchReferenceSection
        ? await window.StudyApp.fetchReferenceSection(relFile, heading || '')
        : await (await fetch(`/api/obsidian/section?file=${encodeURIComponent(relFile)}&heading=${encodeURIComponent(heading || '')}`)).json();
      if (data.obsidianUri) {
        uriEl.href = data.obsidianUri;
        uriEl.hidden = false;
      }
      if (!data.available) {
        bodyEl.innerHTML = `<p class="muted">${esc(data.error || 'Could not read reference note.')}</p>`;
        return;
      }

      drawerToc = data.toc || [];
      const rel = drawerContext.question && drawerToc.length
        ? findRelevantReferenceHeadings(drawerContext.question, drawerCourseMeta, drawerToc, drawerContext.bank)
        : null;
      const useNeededStream = Boolean(
        !opts.forceSection
        && (opts.forceNeeded || (!heading && drawerMode === 'needed'))
        && rel && rel.coreHeadings.length > 0
      );

      if (useNeededStream && window.StudyApp?.fetchReferenceSections) {
        drawerMode = 'needed';
        drawerSelectedHeading = '';
        const targetList = drawerShowBg ? [...rel.coreHeadings, ...rel.backgroundHeadings] : rel.coreHeadings;
        const bundle = await window.StudyApp.fetchReferenceSections(relFile, targetList);
        if (bundle?.available && bundle.sections?.length) {
          const tagged = bundle.sections.map((s) => ({ ...s, isBackground: rel.backgroundSet.has(s.heading) }));
          renderDrawerOutline();
          bodyEl.innerHTML = renderContinuousNeededSectionsHtml(tagged, {
            backgroundHeadings: rel.backgroundHeadings,
            showBg: drawerShowBg,
            isDrawer: true,
          });
          bodyEl.querySelectorAll('[data-drawer-expand-heading]').forEach((btn) => {
            btn.onclick = () => {
              drawerMode = 'section';
              loadDrawerSection(currentNoteFile, btn.dataset.drawerExpandHeading, { forceSection: true });
            };
          });
          bodyEl.querySelector('[data-drawer-show-bg]')?.addEventListener('click', () => {
            drawerShowBg = true;
            loadDrawerSection(currentNoteFile, '', { forceNeeded: true });
          });
          bodyEl.querySelector('[data-drawer-open-toc]')?.addEventListener('click', () => setDrawerTocOpen(true));
          bodyEl.scrollTop = 0;
          return;
        }
      }

      drawerMode = 'section';
      drawerSelectedHeading = data.selectedHeading || heading || '';
      renderDrawerOutline();

      renderNoteProgressive(bodyEl, data.markdown || '', {
        scrollRoot: bodyEl,
        initialHeading: '',
        onLinkJump: (jumpFile, jumpHeading) => {
          const sameNote = !jumpFile || jumpFile.toLowerCase().includes(currentNoteFile.replace(/\.md$/i, '').toLowerCase());
          if (sameNote && jumpHeading) {
            loadDrawerSection(currentNoteFile, jumpHeading, { forceSection: true });
          } else if (jumpFile) {
            currentNoteFile = jumpFile.endsWith('.md') ? jumpFile : `${jumpFile}.md`;
            loadDrawerSection(currentNoteFile, jumpHeading, { forceSection: true });
          }
        },
      });
      bodyEl.scrollTop = 0;
    } catch (err) {
      bodyEl.innerHTML = `<p class="muted">Reference section unavailable: use "Open in Obsidian" above if running locally.</p>`;
    }
  }

  function closeReferenceDrawer() {
    const drawer = document.getElementById('ref-drawer');
    const backdrop = document.getElementById('ref-backdrop');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop?.classList.remove('is-open');
    if (!document.body.classList.contains('runner-split-ref')) {
      document.getElementById('run-ref-btn')?.setAttribute('aria-expanded', 'false');
    }
    clearTimeout(drawerCloseTimer);
    drawerCloseTimer = setTimeout(() => {
      if (!drawer.classList.contains('is-open')) {
        drawer.hidden = true;
        if (backdrop) backdrop.hidden = true;
      }
    }, 210);
  }

  let lightboxState = { zoom: 1, tx: 0, ty: 0, onAction: null, token: 0 };

  function applyLightboxTransform() {
    const img = document.getElementById('img-lightbox-target');
    const stage = document.getElementById('img-lightbox-stage');
    const resetBtn = document.getElementById('img-lightbox-zoom-reset');
    if (!img) return;
    if (lightboxState.zoom <= 1.01) {
      lightboxState.zoom = 1;
      lightboxState.tx = 0;
      lightboxState.ty = 0;
    }
    img.style.transform = `translate3d(${Math.round(lightboxState.tx)}px, ${Math.round(lightboxState.ty)}px, 0) scale(${lightboxState.zoom.toFixed(4)})`;
    stage?.classList.toggle('is-zoomed', lightboxState.zoom > 1.01);
    if (resetBtn) {
      resetBtn.hidden = lightboxState.zoom <= 1.01;
      resetBtn.textContent = `${Math.round(lightboxState.zoom * 100)}% · Reset`;
    }
  }

  function setLightboxZoom(nextZoom, clientX, clientY) {
    const stage = document.getElementById('img-lightbox-stage');
    const prev = lightboxState.zoom;
    const clamped = Math.max(1, Math.min(4.5, Number(nextZoom) || 1));
    if (clamped <= 1.01) {
      lightboxState.zoom = 1;
      lightboxState.tx = 0;
      lightboxState.ty = 0;
      applyLightboxTransform();
      return;
    }
    if (stage && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const r = stage.getBoundingClientRect();
      const cx = clientX - (r.left + r.width / 2);
      const cy = clientY - (r.top + r.height / 2);
      const ratio = clamped / prev;
      lightboxState.tx = cx - (cx - lightboxState.tx) * ratio;
      lightboxState.ty = cy - (cy - lightboxState.ty) * ratio;
    }
    lightboxState.zoom = clamped;
    applyLightboxTransform();
  }

  function openLightbox(src, alt = '', opts = {}) {
    const box = document.getElementById('img-lightbox');
    const img = document.getElementById('img-lightbox-target');
    const capEl = document.getElementById('img-lightbox-caption');
    const actBtn = document.getElementById('img-lightbox-action-btn');
    if (!box || !img || !src) return;
    const tok = ++lightboxState.token;
    lightboxState.zoom = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    lightboxState.onAction = typeof opts?.onAction === 'function' ? opts.onAction : null;
    img.src = src;
    img.alt = alt || 'Fullscreen figure';
    img.classList.toggle('is-pdf-surface', Boolean(opts?.isPdf));
    img.classList.toggle('is-pdf-inverted', Boolean(opts?.inverted));
    if (capEl) capEl.textContent = opts?.caption || alt || '';
    if (actBtn) {
      if (opts?.actionLabel && lightboxState.onAction) {
        actBtn.textContent = opts.actionLabel;
        actBtn.hidden = false;
      } else {
        actBtn.hidden = true;
      }
    }
    applyLightboxTransform();
    box.hidden = false;
    if (opts?.upgradePromise && typeof opts.upgradePromise.then === 'function') {
      opts.upgradePromise.then((hiResSrc) => {
        if (hiResSrc && lightboxState.token === tok && !box.hidden) {
          img.src = hiResSrc;
        }
      }).catch(() => {});
    }
  }

  function closeLightbox() {
    const box = document.getElementById('img-lightbox');
    if (box) box.hidden = true;
    lightboxState.zoom = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    lightboxState.onAction = null;
    lightboxState.token++;
    applyLightboxTransform();
  }

  // ---------------------------------------------------------------------------
  // Universal Non-Pausable 75-Minute Working Session Clock + 1:5 Recovery Break
  // ---------------------------------------------------------------------------
  const WORK_CAP_SEC = 75 * 60; // Hard 75:00 working interval cap
  const WORK_WAVE_KEY = 'study-os-work-wave-v1';
  let workTickHandle = null;

  const osloDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });

  function localDayKey(d = new Date()) {
    try {
      return osloDayFmt.format(d);
    } catch {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }

  function snapshotDayToHistory(st) {
    if (!st || !st.dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(st.dayKey)) return;
    if (!st.dayHistory || typeof st.dayHistory !== 'object') st.dayHistory = {};
    const tel = st.dayKey === localDayKey() ? getTodayTelemetryTotals() : null;
    const activeSec = Math.round(Math.max(Number(st.backendActiveFloorSec) || 0, tel ? tel.prodSec : 0));
    const screenSec = tel && tel.trackedSec >= 60
      ? Math.round(Math.max(tel.trackedSec, activeSec + tel.driftSec))
      : Math.round(Math.max(Number(st.dayScreenSec) || 0, activeSec));
    const offScreenSec = Math.round(Math.max(Number(st.dayOffScreenSec) || 0, Number(st.backendAwayFloorSec) || 0, tel ? (tel.td.awaySec || 0) + (tel.td.breakSec || 0) : 0));
    if (screenSec > 0 || activeSec > 0 || offScreenSec > 0) {
      st.dayHistory[st.dayKey] = {
        screenSec,
        offScreenSec,
        activeSec,
        breaks: Math.max(0, Number(st.dayBreaks) || 0),
      };
    }
    const keys = Object.keys(st.dayHistory).sort();
    while (keys.length > 60) {
      delete st.dayHistory[keys.shift()];
    }
  }

  function formatDurationShort(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const totalMin = Math.floor(s / 60);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function loadWorkState() {
    const today = localDayKey();
    const fallback = {
      dayKey: today,
      mode: 'idle', // 'idle' | 'working' | 'break'
      waveStartedAtMs: null,
      wavePausedOffsetMs: 0,
      wavePausedSinceMs: null,
      wavePauseReason: '',
      breakStartedAtMs: null,
      breakEndsAtMs: null,
      devPausedAtMs: null,
      breakTotalSec: 300,
      breakBankedSec: 0,
      lastWaveSec: 0,
      dayBankedSec: 0,
      dayWaves: 0,
      dayScreenSec: 0,
      dayOffScreenSec: 0,
      dayBreaks: 0,
      dayBreakSec: 0,
      totalBreaks: 0,
      totalBreakSec: 0,
      lastBreakAtMs: 0,
      backendActiveFloorSec: 0,
      backendAwayFloorSec: 0,
      ledgerSchemaVer: 2,
      dayHistory: {},
    };
    try {
      const raw = JSON.parse(localStorage.getItem(WORK_WAVE_KEY));
      if (!raw || typeof raw !== 'object') return fallback;
      const st = { ...fallback, ...raw, dayHistory: raw.dayHistory && typeof raw.dayHistory === 'object' ? { ...raw.dayHistory } : {} };
      const now = st.devPausedAtMs || Date.now();
      // One-time v2 self-heal: clear phantom banked wave hours (old bug credited +75m on abandoned/rolled-over waves)
      if (Number(raw.ledgerSchemaVer || 0) < 2) {
        st.ledgerSchemaVer = 2;
        st.dayBankedSec = 0;
        st.backendActiveFloorSec = 0;
        if (st.dayKey === today) {
          st.dayScreenSec = 0;
          if (st.dayHistory[today]) delete st.dayHistory[today];
        }
      }
      if (st.dayKey !== today) {
        snapshotDayToHistory(st);
        st.dayKey = today;
        st.mode = 'idle';
        st.waveStartedAtMs = null;
        st.wavePausedOffsetMs = 0;
        st.wavePausedSinceMs = null;
        st.wavePauseReason = '';
        st.breakStartedAtMs = null;
        st.breakEndsAtMs = null;
        st.breakBankedSec = 0;
        st.dayBankedSec = 0;
        st.dayWaves = 0;
        st.dayScreenSec = 0;
        st.dayOffScreenSec = 0;
        st.dayBreaks = 0;
        st.dayBreakSec = 0;
        st.backendActiveFloorSec = 0;
        st.backendAwayFloorSec = 0;
      }
      // Clear stale abandoned wave if browser was closed >2.5 hours ago — NEVER fabricate fake active study hours!
      if (st.mode === 'working' && st.waveStartedAtMs && now - st.waveStartedAtMs > (WORK_CAP_SEC + 5400) * 1000) {
        st.mode = 'idle';
        st.waveStartedAtMs = null;
        st.wavePausedOffsetMs = 0;
        st.wavePausedSinceMs = null;
        st.wavePauseReason = '';
      }
      if (st.mode === 'break' && st.breakEndsAtMs && now - st.breakEndsAtMs > 3600 * 1000) {
        const cap = Math.max(0, Number(st.breakTotalSec) || 300);
        const already = Math.max(0, Number(st.breakBankedSec) || 0);
        const delta = Math.max(0, cap - already);
        st.totalBreakSec = (Number(st.totalBreakSec) || 0) + delta;
        st.mode = 'idle';
        st.breakStartedAtMs = null;
        st.breakEndsAtMs = null;
        st.breakBankedSec = 0;
      }
      // Never leave a working session stuck in a non-manual focus auto-pause
      if (!st.devPausedAtMs && st.mode === 'working' && st.wavePausedSinceMs && st.wavePauseReason !== 'manual') {
        st.wavePausedOffsetMs = (Number(st.wavePausedOffsetMs) || 0) + Math.max(0, now - st.wavePausedSinceMs);
        st.wavePausedSinceMs = null;
        st.wavePauseReason = '';
      }
      return st;
    } catch {
      return fallback;
    }
  }

  // Personal Dev Mode (Admin / Local Sandbox: freezes scores, break timer, drafts & cloud sync)
  const DEV_MODE_KEY = 'study-os-dev-mode-v1';
  let devModeActive = false;
  try {
    const devParam = new URLSearchParams(location.search).get('dev');
    if (devParam === '1') sessionStorage.setItem(DEV_MODE_KEY, '1');
    else if (devParam === '0') sessionStorage.removeItem(DEV_MODE_KEY);
    devModeActive = sessionStorage.getItem(DEV_MODE_KEY) === '1';
  } catch {}

  function isLocalHost() {
    try {
      return ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    } catch {
      return false;
    }
  }

  const devMode = {
    isActive() {
      return devModeActive;
    },
    isAllowed() {
      if (devModeActive) return true;
      if (window.StudyCommunity?.isAdmin?.()) return true;
      if (window.StudyApp?.isStaticMode?.() === false) return true;
      if (document.documentElement.dataset.studyMode !== 'web' && isLocalHost()) return true;
      return false;
    },
    syncUi() {
      document.body.classList.toggle('dev-mode-active', devModeActive);
      document.getElementById('settings-dev-mode-row').hidden = !this.isAllowed();
      document.getElementById('settings-dev-mode-toggle').checked = devModeActive;
    },
    setActive(enabled) {
      const next = Boolean(enabled);
      if (next === devModeActive) {
        this.syncUi();
        return;
      }
      if (next && !this.isAllowed()) return;
      if (window.StudyRunner?.isSaving?.()) {
        this.syncUi();
        toast('Wait for the current answer or session to finish saving.');
        return;
      }
      if (next) {
        window.StudyApp?.flushPendingDrafts?.();
        freezeDevClocks();
      }
      devModeActive = next;
      try {
        if (next) sessionStorage.setItem(DEV_MODE_KEY, '1');
        else sessionStorage.removeItem(DEV_MODE_KEY);
      } catch {}
      if (!next) {
        resumeDevClocks();
      } else {
        document.getElementById('break-modal')?.close?.();
      }
      window.StudyRunner?.onDevModeChange?.(next);
      renderWorkClockDom();
      window.StudyApp?.onDevModeChange?.(next);
      toast(
        next
          ? 'Dev Mode ON · Study timers and tracking paused.'
          : 'Dev Mode OFF · Real progress & timers restored.'
      );
    },
    toggle() {
      this.setActive(!devModeActive);
      return devModeActive;
    },
  };

  let telemetryLedger = null;
  let workState = loadWorkState();
  let expiredBreakShown = null;
  let lastEveningAccess = false;
  let lastScreenTickMs = Date.now();
  let lastScreenSaveMs = 0;

  // ---------------------------------------------------------------------------
  // TIER 1 VERIFIABLE TELEMETRY LEDGER (Multi-Tab Leader Lock + 5m Oslo Buckets + Device Rollup)
  // ---------------------------------------------------------------------------
  const DEVICE_ID_KEY = 'study-os-device-id-v1';
  const TELEMETRY_LEDGER_KEY = 'study-os-telemetry-ledger-v1';
  const LEADER_LEASE_KEY = 'study-os-leader-lease-v1';
  const TAB_ID = `tab_${Math.random().toString(36).slice(2, 10)}`;
  const AFK_IDLE_THRESHOLD_MS = 180_000; // 3 minutes without interaction when not in Paper/IDE mode
  let lastUserInteractionMs = Date.now();
  let paperModeActive = false;
  let lastTelemetrySaveMs = 0;

  const deviceId = (() => {
    try {
      let existing = localStorage.getItem(DEVICE_ID_KEY);
      if (existing && /^dev_[a-z0-9]{6,16}$/.test(existing)) return existing;
      const ua = /iphone|ipad|android/i.test(navigator.userAgent || '') ? 'm' : 'd';
      existing = `dev_${ua}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
      localStorage.setItem(DEVICE_ID_KEY, existing);
      return existing;
    } catch {
      return `dev_ephem${Math.random().toString(36).slice(2, 7)}`;
    }
  })();

  const osloBucketFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  function currentOslo5mBucketKey(now = Date.now()) {
    try {
      const parts = osloBucketFmt.formatToParts(new Date(now));
      const get = (t) => parts.find((p) => p.type === t)?.value || '00';
      const minNum = Math.floor(Number(get('minute')) / 5) * 5;
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${String(minNum).padStart(2, '0')}`;
    } catch {
      return new Date(now).toISOString().slice(0, 16);
    }
  }

  function emptyDayTelemetry() {
    return {
      solvingSec: 0,
      readingSec: 0,
      appBrowseSec: 0,
      afkIdleSec: 0,
      awaySec: 0,
      breakSec: 0,
      extStudySec: 0,
      extDistractSec: 0,
      extOtherSec: 0,
      courseSec: {},
    };
  }

  function loadTelemetryLedger() {
    try {
      const raw = JSON.parse(localStorage.getItem(TELEMETRY_LEDGER_KEY) || '{}');
      return {
        version: 1,
        byDevice: raw.byDevice && typeof raw.byDevice === 'object' ? raw.byDevice : {},
        buckets: raw.buckets && typeof raw.buckets === 'object' ? raw.buckets : {},
      };
    } catch {
      return { version: 1, byDevice: {}, buckets: {} };
    }
  }

  telemetryLedger = loadTelemetryLedger();

  function saveTelemetryLedger() {
    if (devModeActive) return;
    try {
      // Prune 5m buckets to rolling 48h (576 buckets) & daily rollups to 60 days per device
      const bKeys = Object.keys(telemetryLedger.buckets).sort();
      while (bKeys.length > 576) delete telemetryLedger.buckets[bKeys.shift()];
      for (const dev of Object.keys(telemetryLedger.byDevice)) {
        const dMap = telemetryLedger.byDevice[dev];
        if (!dMap || typeof dMap !== 'object') continue;
        const dKeys = Object.keys(dMap).sort();
        while (dKeys.length > 60) delete dMap[dKeys.shift()];
      }
      localStorage.setItem(TELEMETRY_LEDGER_KEY, JSON.stringify(telemetryLedger));
      lastTelemetrySaveMs = Date.now();
    } catch {}
  }

  // Multi-tab Leader Election (BroadcastChannel + localStorage lease) so open tabs never double-count
  let leaderChan = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      leaderChan = new BroadcastChannel('study-os-telemetry-leader-v1');
    }
  } catch {}

  function claimOrVerifyLeader(now = Date.now()) {
    try {
      const raw = JSON.parse(localStorage.getItem(LEADER_LEASE_KEY) || 'null');
      const focused = !document.hidden && document.hasFocus();
      const expired = !raw || !raw.tabId || now - Number(raw.ts || 0) > 5500;
      if (raw?.tabId === TAB_ID || expired || (focused && !raw?.focused)) {
        localStorage.setItem(LEADER_LEASE_KEY, JSON.stringify({ tabId: TAB_ID, ts: now, focused }));
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  window.addEventListener('beforeunload', () => {
    try {
      const raw = JSON.parse(localStorage.getItem(LEADER_LEASE_KEY) || 'null');
      if (raw?.tabId === TAB_ID) localStorage.removeItem(LEADER_LEASE_KEY);
      saveTelemetryLedger();
    } catch {}
  });

  // Track real human input passively (throttled) to distinguish genuine reading/solving vs AFK idle
  let lastTouchStamp = 0;
  const markUserActivity = () => {
    const now = Date.now();
    if (now - lastTouchStamp < 1000) return;
    lastTouchStamp = now;
    lastUserInteractionMs = now;
  };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((evName) => {
    window.addEventListener(evName, markUserActivity, { passive: true, capture: true });
  });

  // Ingest opt-in Tier 2 Chrome Extension category telemetry (Study / Distract / Other)
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (msg?.type !== 'STUDY_OS_EXT_TELEMETRY' || !msg.daily || typeof msg.daily !== 'object') return;
    if (devModeActive) return;
    if (!telemetryLedger.byDevice[deviceId]) telemetryLedger.byDevice[deviceId] = {};
    let updated = false;
    for (const [dayKey, vals] of Object.entries(msg.daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !vals || typeof vals !== 'object') continue;
      const cur = telemetryLedger.byDevice[deviceId][dayKey] || emptyDayTelemetry();
      const nStudy = Math.min(86400, Math.max(Number(cur.extStudySec) || 0, Math.round(Number(vals.studySec) || 0)));
      const nDist = Math.min(86400, Math.max(Number(cur.extDistractSec) || 0, Math.round(Number(vals.distractSec) || 0)));
      const nOther = Math.min(86400, Math.max(Number(cur.extOtherSec) || 0, Math.round(Number(vals.otherSec) || 0)));
      if (nStudy !== cur.extStudySec || nDist !== cur.extDistractSec || nOther !== cur.extOtherSec) {
        cur.extStudySec = nStudy;
        cur.extDistractSec = nDist;
        cur.extOtherSec = nOther;
        telemetryLedger.byDevice[deviceId][dayKey] = cur;
        updated = true;
      }
    }
    if (updated) saveTelemetryLedger();
  });

  function classifyTelemetryState(now = Date.now()) {
    if (workState.mode === 'break') return { state: 'breakSec', courseId: '' };
    const inRunner = !document.getElementById('view-runner')?.hidden;
    const activeCourseId = inRunner ? (window.StudyRunner?.getActiveCourseId?.() || '') : '';
    const ideExempt = Boolean(window.StudyRunner?.isIdeCodingFocusExempt?.());
    const docVisible = !document.hidden;
    const docFocused = docVisible && (document.hasFocus() || document.activeElement?.tagName === 'IFRAME');

    if (ideExempt || (paperModeActive && (inRunner || workState.mode === 'working'))) {
      return { state: 'solvingSec', courseId: activeCourseId };
    }
    if (!docFocused) {
      return workState.mode === 'working' ? { state: 'awaySec', courseId: '' } : { state: '', courseId: '' };
    }
    if (now - lastUserInteractionMs >= AFK_IDLE_THRESHOLD_MS) {
      return { state: 'afkIdleSec', courseId: '' };
    }
    if (inRunner) {
      return { state: 'solvingSec', courseId: activeCourseId };
    }
    const inNotes = !document.getElementById('view-references')?.hidden
      || Boolean(document.getElementById('ref-drawer') && !document.getElementById('ref-drawer').hidden);
    if (inNotes) {
      return { state: 'readingSec', courseId: '' };
    }
    return { state: 'appBrowseSec', courseId: '' };
  }

  function recordTelemetryTick(dtSec, now = Date.now()) {
    if (dtSec <= 0 || dtSec > 60 || devModeActive) return;
    const { state, courseId } = classifyTelemetryState(now);
    if (!state) return;
    const todayKey = localDayKey(now);
    if (!telemetryLedger.byDevice[deviceId]) telemetryLedger.byDevice[deviceId] = {};
    const dayEntry = telemetryLedger.byDevice[deviceId][todayKey] || emptyDayTelemetry();
    dayEntry[state] = Math.min(86400, (Number(dayEntry[state]) || 0) + dtSec);
    if (state === 'solvingSec' && courseId) {
      if (!dayEntry.courseSec || typeof dayEntry.courseSec !== 'object') dayEntry.courseSec = {};
      dayEntry.courseSec[courseId] = Math.min(86400, (Number(dayEntry.courseSec[courseId]) || 0) + dtSec);
    }
    telemetryLedger.byDevice[deviceId][todayKey] = dayEntry;

    // Immutable 5-minute Oslo bucket log
    const bKey = currentOslo5mBucketKey(now);
    const bEntry = telemetryLedger.buckets[bKey] || { s: 0, r: 0, a: 0, i: 0, w: 0, b: 0 };
    const shortMap = { solvingSec: 's', readingSec: 'r', appBrowseSec: 'a', afkIdleSec: 'i', awaySec: 'w', breakSec: 'b' };
    const bk = shortMap[state];
    if (bk) bEntry[bk] = Math.min(300, Math.round(((Number(bEntry[bk]) || 0) + dtSec) * 10) / 10);
    telemetryLedger.buckets[bKey] = bEntry;
  }

  function aggregateTelemetryByDay() {
    const out = {};
    for (const dMap of Object.values(telemetryLedger.byDevice || {})) {
      if (!dMap || typeof dMap !== 'object') continue;
      for (const [dayKey, entry] of Object.entries(dMap)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !entry || typeof entry !== 'object') continue;
        const acc = out[dayKey] || emptyDayTelemetry();
        acc.solvingSec += Math.round(Number(entry.solvingSec) || 0);
        acc.readingSec += Math.round(Number(entry.readingSec) || 0);
        acc.appBrowseSec += Math.round(Number(entry.appBrowseSec) || 0);
        acc.afkIdleSec += Math.round(Number(entry.afkIdleSec) || 0);
        acc.awaySec += Math.round(Number(entry.awaySec) || 0);
        acc.breakSec += Math.round(Number(entry.breakSec) || 0);
        acc.extStudySec += Math.round(Number(entry.extStudySec) || 0);
        acc.extDistractSec += Math.round(Number(entry.extDistractSec) || 0);
        acc.extOtherSec += Math.round(Number(entry.extOtherSec) || 0);
        if (entry.courseSec && typeof entry.courseSec === 'object') {
          for (const [cid, sec] of Object.entries(entry.courseSec)) {
            acc.courseSec[cid] = (acc.courseSec[cid] || 0) + Math.round(Number(sec) || 0);
          }
        }
        out[dayKey] = acc;
      }
    }
    return out;
  }

  function saveWorkState(allowDevPause = false) {
    if (devModeActive && !allowDevPause) return;
    try {
      snapshotDayToHistory(workState);
      localStorage.setItem(WORK_WAVE_KEY, JSON.stringify(workState));
      lastScreenSaveMs = Date.now();
    } catch {}
  }

  function freezeDevClocks(now = Date.now()) {
    if (workState.devPausedAtMs) return;
    settleActiveBreak(now);
    workState.devPausedAtMs = now;
    saveWorkState(true);
  }

  function resumeDevClocks(now = Date.now()) {
    if (!workState.devPausedAtMs) return;
    const pausedMs = Math.max(0, now - workState.devPausedAtMs);
    for (const field of ['waveStartedAtMs', 'wavePausedSinceMs', 'breakStartedAtMs', 'breakEndsAtMs']) {
      if (workState[field]) workState[field] += pausedMs;
    }
    workState.devPausedAtMs = null;
    lastScreenTickMs = now;
    saveWorkState();
  }

  function settleActiveBreak(now = Date.now()) {
    if (workState.mode !== 'break' || !workState.breakStartedAtMs) return;
    const elapsed = Math.max(0, Math.floor((now - workState.breakStartedAtMs) / 1000));
    const cap = Math.max(60, Number(workState.breakTotalSec) || 300);
    const capped = Math.min(elapsed, cap);
    const already = Math.max(0, Number(workState.breakBankedSec) || 0);
    const delta = Math.max(0, capped - already);
    if (delta > 0) {
      workState.totalBreakSec = (Number(workState.totalBreakSec) || 0) + delta;
      workState.dayBreakSec = (Number(workState.dayBreakSec) || 0) + delta;
      workState.breakBankedSec = already + delta;
    }
  }

  function computeBreakStats(now = Date.now()) {
    now = workState.devPausedAtMs || now;
    let extraSec = 0;
    if (workState.mode === 'break' && workState.breakStartedAtMs) {
      const elapsed = Math.max(0, Math.floor((now - workState.breakStartedAtMs) / 1000));
      const cap = Math.max(60, Number(workState.breakTotalSec) || 300);
      extraSec = Math.max(0, Math.min(elapsed, cap) - (Number(workState.breakBankedSec) || 0));
    }
    const totalBreaks = Math.max(0, Number(workState.totalBreaks) || 0);
    const totalBreakSec = Math.max(0, (Number(workState.totalBreakSec) || 0) + extraSec);
    const dayBreaks = Math.max(0, Number(workState.dayBreaks) || 0);
    const dayBreakSec = Math.max(0, (Number(workState.dayBreakSec) || 0) + extraSec);
    return {
      totalBreaks,
      totalBreakMinutes: Math.round(totalBreakSec / 60),
      dayBreaks,
      dayBreakMinutes: Math.round(dayBreakSec / 60),
      avgBreakMinutes: totalBreaks ? Math.round((totalBreakSec / 60 / totalBreaks) * 10) / 10 : 0,
      lastBreakAtMs: Math.max(0, Number(workState.lastBreakAtMs) || 0),
    };
  }

  function getTodayTelemetryTotals() {
    if (!telemetryLedger) {
      const empty = emptyDayTelemetry();
      return { td: empty, prodSec: 0, driftSec: 0, trackedSec: 0 };
    }
    const byDay = aggregateTelemetryByDay();
    const td = byDay[localDayKey()] || emptyDayTelemetry();
    const prodSec = (td.solvingSec || 0) + (td.readingSec || 0) + (td.extStudySec || 0);
    const driftSec = (td.appBrowseSec || 0) + (td.afkIdleSec || 0) + (td.extDistractSec || 0);
    return { td, prodSec, driftSec, trackedSec: prodSec + driftSec };
  }

  function getVerifiedTodayActiveSec() {
    const { prodSec } = getTodayTelemetryTotals();
    return Math.round(Math.max(Number(workState.backendActiveFloorSec) || 0, prodSec));
  }

  function computeScreenStats(now = Date.now()) {
    const { td, prodSec, driftSec, trackedSec } = getTodayTelemetryTotals();
    const activeFloor = Math.max(Number(workState.backendActiveFloorSec) || 0, prodSec);
    const awayFloor = Math.max(Number(workState.backendAwayFloorSec) || 0, (td.awaySec || 0) + (td.breakSec || 0));
    const screenSec = trackedSec >= 60
      ? Math.round(Math.max(trackedSec, activeFloor + driftSec))
      : Math.round(Math.max(Number(workState.dayScreenSec) || 0, activeFloor));
    const offScreenSec = Math.round(Math.max(Number(workState.dayOffScreenSec) || 0, awayFloor));
    return {
      screenSec,
      offScreenSec,
      screenLabel: formatDurationShort(screenSec),
      offScreenLabel: formatDurationShort(offScreenSec),
    };
  }

  function currentWaveElapsedSec(now = Date.now()) {
    now = workState.devPausedAtMs || now;
    if (workState.mode !== 'working' || !workState.waveStartedAtMs) return 0;
    const pausedMs =
      (Number(workState.wavePausedOffsetMs) || 0) +
      (workState.wavePausedSinceMs ? Math.max(0, now - workState.wavePausedSinceMs) : 0);
    return Math.min(WORK_CAP_SEC, Math.max(0, Math.floor((now - workState.waveStartedAtMs - pausedMs) / 1000)));
  }

  function recommendedWaveBreakMin(elapsedSec = currentWaveElapsedSec()) {
    return Math.max(3, Math.min(15, Math.round(elapsedSec / 300)));
  }

  const osloClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  function eveningBreakAccess(now = Date.now()) {
    const parts = osloClock.formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const mins = h * 60 + m;
    return mins >= 18 * 60 && mins < 22 * 60 + 30;
  }

  function showBreakModalUi() {
    const dialog = document.getElementById('break-modal');
    if (!dialog.open) dialog.showModal();
  }

  const workClock = {
    MAX_SEC: WORK_CAP_SEC,
    canUseBreakTools(now = Date.now()) {
      if (devModeActive) return true;
      return eveningBreakAccess(now) || (!workState.devPausedAtMs && workState.mode === 'break' && workState.breakEndsAtMs > now);
    },
    getState() {
      return {
        ...workState,
        elapsedSec: currentWaveElapsedSec(),
        recommendedBreakMin: recommendedWaveBreakMin(),
      };
    },
    ensureWorking() {
      if (devModeActive) {
        renderWorkClockDom();
        return;
      }
      resumeDevClocks();
      if (workState.mode === 'working' && workState.waveStartedAtMs) {
        if (workState.wavePausedSinceMs && workState.wavePauseReason !== 'manual') {
          this.setPaused(false);
        }
        renderWorkClockDom();
        return;
      }
      workState.dayKey = localDayKey();
      workState.mode = 'working';
      workState.waveStartedAtMs = Date.now();
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakEndsAtMs = null;
      saveWorkState();
      document.getElementById('break-modal').close();
      soundMasker.syncWithWorkMode('working');
      renderWorkClockDom();
    },
    setPaused(paused, reason = 'auto') {
      if (devModeActive || workState.devPausedAtMs) return;
      if (workState.mode !== 'working' || !workState.waveStartedAtMs) return;
      const now = Date.now();
      if (paused) {
        if (!workState.wavePausedSinceMs) {
          workState.wavePausedSinceMs = now;
          workState.wavePauseReason = reason;
          saveWorkState();
          renderWorkClockDom();
        }
      } else if (workState.wavePausedSinceMs) {
        workState.wavePausedOffsetMs =
          (Number(workState.wavePausedOffsetMs) || 0) + Math.max(0, now - workState.wavePausedSinceMs);
        workState.wavePausedSinceMs = null;
        workState.wavePauseReason = '';
        saveWorkState();
        renderWorkClockDom();
      }
    },
    triggerBreak(isAutoCap = false) {
      if (devModeActive) {
        toast('Dev Mode ON — break timer & break score are frozen.');
        return;
      }
      resumeDevClocks();
      const now = Date.now();
      if (workState.mode === 'break') settleActiveBreak(now);
      const elapsed = workState.mode === 'working' ? (isAutoCap ? WORK_CAP_SEC : currentWaveElapsedSec(now)) : 0;
      const breakMin = isAutoCap ? 15 : recommendedWaveBreakMin(elapsed);
      if (workState.mode === 'working') {
        workState.dayBankedSec = (workState.dayBankedSec || 0) + elapsed;
        workState.dayWaves = (workState.dayWaves || 0) + 1;
        workState.lastWaveSec = elapsed;
      }
      workState.mode = 'break';
      workState.waveStartedAtMs = null;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = now;
      workState.breakBankedSec = 0;
      workState.breakTotalSec = breakMin * 60;
      workState.breakEndsAtMs = now + breakMin * 60 * 1000;
      workState.totalBreaks = (Number(workState.totalBreaks) || 0) + 1;
      workState.dayBreaks = (Number(workState.dayBreaks) || 0) + 1;
      workState.lastBreakAtMs = now;
      saveWorkState();
      window.StudyRunner?.onBreakStateChange?.(true);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('break');
      renderWorkClockDom();
      showBreakModalUi();
    },
    startNextInterval() {
      if (devModeActive) {
        document.getElementById('break-modal')?.close?.();
        return;
      }
      resumeDevClocks();
      const now = Date.now();
      settleActiveBreak(now);
      workState.dayKey = localDayKey();
      workState.mode = 'working';
      workState.waveStartedAtMs = now;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = null;
      workState.breakEndsAtMs = null;
      workState.breakBankedSec = 0;
      saveWorkState();
      document.getElementById('break-modal').close();
      window.StudyRunner?.onBreakStateChange?.(false);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('working');
      renderWorkClockDom();
    },
    endSession() {
      if (devModeActive) {
        document.getElementById('break-modal')?.close?.();
        return;
      }
      resumeDevClocks();
      const now = Date.now();
      settleActiveBreak(now);
      if (workState.mode === 'working' && workState.waveStartedAtMs) {
        const elapsed = currentWaveElapsedSec(now);
        if (elapsed >= 60) {
          workState.dayBankedSec = (workState.dayBankedSec || 0) + elapsed;
          workState.dayWaves = (workState.dayWaves || 0) + 1;
        }
      }
      workState.mode = 'idle';
      workState.waveStartedAtMs = null;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = null;
      workState.breakEndsAtMs = null;
      workState.breakBankedSec = 0;
      saveWorkState();
      document.getElementById('break-modal').close();
      window.StudyRunner?.onBreakStateChange?.(false, true);
      window.StudyCommunity?.queueStatsSync?.();
      soundMasker.syncWithWorkMode('idle');
      renderWorkClockDom();
    },
    addBreakSeconds(sec = 60) {
      if (devModeActive || workState.devPausedAtMs || workState.mode !== 'break') return;
      const now = Date.now();
      const base = Math.max(now, workState.breakEndsAtMs || now);
      workState.breakEndsAtMs = base + sec * 1000;
      workState.breakTotalSec = (workState.breakTotalSec || 300) + sec;
      if (!workState.breakStartedAtMs) workState.breakStartedAtMs = now;
      saveWorkState();
      window.StudyCommunity?.queueStatsSync?.();
      renderWorkClockDom();
    },
    syncBackendToday(todayActiveMin = 0, todayAwayMin = 0) {
      if (devModeActive || workState.devPausedAtMs) return;
      workState.backendActiveFloorSec = Math.round(Math.max(0, Number(todayActiveMin) || 0) * 60);
      workState.backendAwayFloorSec = Math.max(
        Number(workState.backendAwayFloorSec) || 0,
        Math.round(Math.max(0, Number(todayAwayMin) || 0) * 60)
      );
      const scr = computeScreenStats();
      workState.dayScreenSec = scr.screenSec;
      workState.dayOffScreenSec = scr.offScreenSec;
      saveWorkState();
      renderWorkClockDom();
    },
    getScreenStats() {
      return computeScreenStats();
    },
    getScreenHistory() {
      const hist = workState.dayHistory && typeof workState.dayHistory === 'object'
        ? { ...workState.dayHistory }
        : {};
      const todayKey = localDayKey();
      const live = computeScreenStats();
      const liveActiveSec = getVerifiedTodayActiveSec();
      hist[todayKey] = {
        screenSec: live.screenSec,
        offScreenSec: live.offScreenSec,
        activeSec: liveActiveSec,
        breaks: Math.max(0, Number(workState.dayBreaks) || 0),
      };
      return hist;
    },
    mergeScreenHistory(incoming) {
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return 0;
      if (!workState.dayHistory || typeof workState.dayHistory !== 'object') workState.dayHistory = {};
      const todayKey = localDayKey();
      let changed = 0;
      for (const [dayKey, entry] of Object.entries(incoming)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !entry || typeof entry !== 'object') continue;
        const incScreen = Math.min(86400, Math.max(0, Math.round(Number(entry.screenSec) || 0)));
        const incOff = Math.min(86400, Math.max(0, Math.round(Number(entry.offScreenSec) || 0)));
        const incAct = Math.min(86400, Math.max(0, Math.round(Number(entry.activeSec) || 0)));
        const incBreaks = Math.min(200, Math.max(0, Math.round(Number(entry.breaks) || 0)));
        if (incScreen === 0 && incOff === 0 && incAct === 0 && incBreaks === 0) continue;

        const cur = workState.dayHistory[dayKey] || { screenSec: 0, offScreenSec: 0, activeSec: 0, breaks: 0 };
        const next = {
          screenSec: Math.max(Number(cur.screenSec) || 0, incScreen),
          offScreenSec: Math.max(Number(cur.offScreenSec) || 0, incOff),
          activeSec: Math.max(Number(cur.activeSec) || 0, incAct),
          breaks: Math.max(Number(cur.breaks) || 0, incBreaks),
        };
        if (
          next.screenSec !== (Number(cur.screenSec) || 0) ||
          next.offScreenSec !== (Number(cur.offScreenSec) || 0) ||
          next.activeSec !== (Number(cur.activeSec) || 0) ||
          next.breaks !== (Number(cur.breaks) || 0)
        ) {
          workState.dayHistory[dayKey] = next;
          changed++;
        }

        if (dayKey === todayKey && workState.dayKey === todayKey && !devModeActive && !workState.devPausedAtMs) {
          // Never adopt legacy cloud screenHistory.activeSec into backendActiveFloorSec (verified attempts & telemetry ledger are authoritative)
          if (incOff > (Number(workState.dayOffScreenSec) || 0)) {
            workState.dayOffScreenSec = incOff;
            changed++;
          }
          if (incBreaks > (Number(workState.dayBreaks) || 0)) {
            workState.dayBreaks = incBreaks;
            changed++;
          }
        }
      }
      const keys = Object.keys(workState.dayHistory).sort();
      while (keys.length > 60) delete workState.dayHistory[keys.shift()];
      if (changed > 0) {
        saveWorkState();
        renderWorkClockDom();
      }
      return changed;
    },
    getBreakStats() {
      return computeBreakStats();
    },
    getDeviceId() {
      return deviceId;
    },
    isPaperMode() {
      return paperModeActive;
    },
    setPaperMode(enabled) {
      paperModeActive = Boolean(enabled);
      lastUserInteractionMs = Date.now();
      toast(paperModeActive ? 'Paper / IDE Mode ON — off-screen solving counts as active study.' : 'Paper / IDE Mode OFF.');
      return paperModeActive;
    },
    getTelemetryByDevice() {
      return telemetryLedger.byDevice || {};
    },
    getTelemetrySummary() {
      const byDay = aggregateTelemetryByDay();
      const todayKey = localDayKey();
      const today = byDay[todayKey] || emptyDayTelemetry();
      const productiveSec = today.solvingSec + today.readingSec + today.extStudySec;
      const trackedSec = today.solvingSec + today.readingSec + today.appBrowseSec + today.afkIdleSec + today.extStudySec + today.extDistractSec;
      const honestEfficiencyPct = trackedSec >= 60 ? Math.min(100, Math.round((productiveSec / trackedSec) * 100)) : null;
      return {
        deviceId,
        deviceCount: Object.keys(telemetryLedger.byDevice || {}).length || 1,
        paperMode: paperModeActive,
        todayKey,
        today,
        honestEfficiencyPct,
        byDay,
        bucketCount: Object.keys(telemetryLedger.buckets || {}).length,
      };
    },
    mergeTelemetryByDevice(incoming) {
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return 0;
      let changed = 0;
      for (const [dev, dMap] of Object.entries(incoming)) {
        if (typeof dev !== 'string' || !/^dev_[a-z0-9_-]{4,24}$/i.test(dev) || !dMap || typeof dMap !== 'object') continue;
        if (!telemetryLedger.byDevice[dev]) telemetryLedger.byDevice[dev] = {};
        for (const [dayKey, inc] of Object.entries(dMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !inc || typeof inc !== 'object') continue;
          const cur = telemetryLedger.byDevice[dev][dayKey] || emptyDayTelemetry();
          const fields = ['solvingSec', 'readingSec', 'appBrowseSec', 'afkIdleSec', 'awaySec', 'breakSec', 'extStudySec', 'extDistractSec', 'extOtherSec'];
          let rowChanged = false;
          for (const f of fields) {
            const val = Math.min(86400, Math.max(0, Math.round(Number(inc[f]) || 0)));
            if (val > (Number(cur[f]) || 0)) {
              cur[f] = val;
              rowChanged = true;
            }
          }
          if (inc.courseSec && typeof inc.courseSec === 'object') {
            if (!cur.courseSec || typeof cur.courseSec !== 'object') cur.courseSec = {};
            for (const [cid, sec] of Object.entries(inc.courseSec)) {
              const v = Math.min(86400, Math.max(0, Math.round(Number(sec) || 0)));
              if (v > (Number(cur.courseSec[cid]) || 0)) {
                cur.courseSec[cid] = v;
                rowChanged = true;
              }
            }
          }
          if (rowChanged) {
            telemetryLedger.byDevice[dev][dayKey] = cur;
            changed++;
          }
        }
      }
      if (changed > 0) saveTelemetryLedger();
      return changed;
    },
    exportTelemetryJson() {
      return {
        format: 'study-os-telemetry-v1',
        exportedAt: new Date().toISOString(),
        timezone: 'Europe/Oslo',
        deviceId,
        byDevice: telemetryLedger.byDevice || {},
        aggregatedByDay: aggregateTelemetryByDay(),
        buckets5m: telemetryLedger.buckets || {},
        screenHistory: this.getScreenHistory(),
      };
    },
  };

  function renderWorkClockDom() {
    const now = Date.now();
    devMode.syncUi();
    if (devModeActive || workState.devPausedAtMs) {
      lastScreenTickMs = now;
      const gPill = document.getElementById('global-work-pill');
      const rPill = document.getElementById('run-work-pill');
      const pausedAt = workState.devPausedAtMs || now;
      const timerSec = workState.mode === 'break'
        ? Math.max(0, Math.ceil((workState.breakEndsAtMs - pausedAt) / 1000))
        : currentWaveElapsedSec(pausedAt);
      const frozenTip = 'Study timers are paused for Dev Mode.';
      [gPill, rPill].forEach((p) => {
        if (!p) return;
        p.className = 'live-clock-pill non-interactive flow-pill-warn';
        p.textContent = `Dev paused · ${clockSec(timerSec)}`;
        p.title = frozenTip;
      });
      ['global-work-action-btn', 'run-break-btn'].forEach((id) => {
        const button = document.getElementById(id);
        button.textContent = devModeActive ? 'Timers paused' : 'Resume timers';
        button.title = frozenTip;
      });
      document.querySelector('main').inert = false;
      document.getElementById('global-header').inert = false;
      document.getElementById('runner-header').inert = false;
      return;
    }
    const todayKey = localDayKey();
    if (workState.dayKey !== todayKey) {
      snapshotDayToHistory(workState);
      workState.dayKey = todayKey;
      workState.mode = 'idle';
      workState.waveStartedAtMs = null;
      workState.wavePausedOffsetMs = 0;
      workState.wavePausedSinceMs = null;
      workState.wavePauseReason = '';
      workState.breakStartedAtMs = null;
      workState.breakEndsAtMs = null;
      workState.breakBankedSec = 0;
      workState.dayBankedSec = 0;
      workState.dayWaves = 0;
      workState.dayScreenSec = 0;
      workState.dayOffScreenSec = 0;
      workState.dayBreaks = 0;
      workState.dayBreakSec = 0;
      workState.backendActiveFloorSec = 0;
      workState.backendAwayFloorSec = 0;
    }
    if (workState.mode === 'break') settleActiveBreak(now);

    const dtMs = Math.max(0, now - lastScreenTickMs);
    lastScreenTickMs = now;
    const isLeader = claimOrVerifyLeader(now);
    if (isLeader && dtMs > 0 && dtMs <= 60000) {
      const dtSec = dtMs / 1000;
      const docFocused =
        !document.hidden && (document.hasFocus() || document.activeElement?.tagName === 'IFRAME');
      const inBreak = workState.mode === 'break';
      const isWavePaused = Boolean(workState.wavePausedSinceMs);
      if ((docFocused && !inBreak && !isWavePaused) || (paperModeActive && workState.mode === 'working' && !isWavePaused)) {
        workState.dayScreenSec = (Number(workState.dayScreenSec) || 0) + dtSec;
      } else if (inBreak || (workState.mode === 'working' && isWavePaused)) {
        workState.dayOffScreenSec = (Number(workState.dayOffScreenSec) || 0) + dtSec;
      }
      recordTelemetryTick(dtSec, now);
      if (now - lastScreenSaveMs >= 10000) {
        saveWorkState();
      }
      if (now - lastTelemetrySaveMs >= 15000) {
        saveTelemetryLedger();
      }
    }

    // Auto-enforce 75:00 hard cap on active working time across the entire app
    if (workState.mode === 'working' && workState.waveStartedAtMs && !workState.wavePausedSinceMs) {
      if (currentWaveElapsedSec(now) >= WORK_CAP_SEC) {
        workClock.triggerBreak(true);
        return;
      }
    }

    const gPill = document.getElementById('global-work-pill');
    const gBtn = document.getElementById('global-work-action-btn');
    const rPill = document.getElementById('run-work-pill');
    const rBtn = document.getElementById('run-break-btn');
    const cdEl = document.getElementById('break-countdown-lbl');

    const scr = computeScreenStats(now);
    const homeScrEl = document.getElementById('home-screen-today-val');
    if (homeScrEl) homeScrEl.textContent = scr.screenLabel;
    const homeOffEl = document.getElementById('home-offscreen-today-val');
    if (homeOffEl) homeOffEl.textContent = scr.offScreenLabel;
    const setScrEl = document.getElementById('settings-screen-val');
    if (setScrEl) setScrEl.textContent = scr.screenLabel;
    const analyticsView = document.getElementById('view-analytics');
    if (analyticsView && !analyticsView.hidden && window.StudyMetrics?.updateLiveTiles) {
      window.StudyMetrics.updateLiveTiles(scr, getVerifiedTodayActiveSec());
    }

    if (workState.mode === 'working') {
      const elSec = currentWaveElapsedSec(now);
      const bMin = recommendedWaveBreakMin(elSec);
      const isPaused = Boolean(workState.wavePausedSinceMs);
      const cls = isPaused
        ? 'live-clock-pill non-interactive flow-pill-warn'
        : 'live-clock-pill non-interactive' +
          (elSec >= 65 * 60 ? ' flow-pill-warn' : elSec >= 45 * 60 ? ' flow-pill-prime' : '');
      const txt = isPaused ? `Paused ${clockSec(elSec)}` : `${clockSec(elSec)} / 75m`;
      const tip = isPaused
        ? `Session paused (${workState.wavePauseReason || 'focus away'}) — resumes on focus · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`
        : `75m working interval (15m break at 75:00) · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`;
      if (gPill) {
        gPill.className = cls;
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = cls;
        rPill.textContent = txt;
        rPill.title = tip;
      }
      if (gBtn) {
        gBtn.textContent = `Break (${bMin}m)`;
        gBtn.title = `Take scaled 1:5 off-screen break (${bMin}m)`;
      }
      if (rBtn) {
        rBtn.textContent = `Break (${bMin}m)`;
        rBtn.title = `Take scaled 1:5 off-screen break (${bMin}m)`;
      }
    } else if (workState.mode === 'break') {
      const remSec = Math.max(0, Math.ceil(((workState.breakEndsAtMs || now) - now) / 1000));
      const txt = remSec > 0 ? `Break ${clockSec(remSec)}` : 'Break ended';
      const tip = `Off-screen recovery break · Screen today: ${scr.screenLabel} · Off-screen: ${scr.offScreenLabel}`;
      if (gPill) {
        gPill.className = 'live-clock-pill non-interactive flow-pill-warn';
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = 'live-clock-pill non-interactive flow-pill-warn';
        rPill.textContent = txt;
        rPill.title = tip;
      }
      for (const button of [gBtn, rBtn]) {
        if (!button) continue;
        button.textContent = remSec > 0 ? 'In Break' : 'Break ended';
        button.title = 'Open break controls';
      }
      if (cdEl) cdEl.textContent = remSec ? clockSec(remSec) : '00:00';
    } else {
      const cls = 'live-clock-pill non-interactive idle-work-pill';
      const txt = '0:00 / 75m';
      const tip = `Accumulated screen time today: ${scr.screenLabel} · Off-screen (breaks/away): ${scr.offScreenLabel}. Auto-starts 75m interval when you begin any run.`;
      if (gPill) {
        gPill.className = cls;
        gPill.textContent = txt;
        gPill.title = tip;
      }
      if (rPill) {
        rPill.className = cls;
        rPill.textContent = txt;
        rPill.title = tip;
      }
      if (gBtn) {
        gBtn.textContent = 'Start 75m';
        gBtn.title = tip;
      }
      if (rBtn) {
        rBtn.textContent = 'Start 75m';
        rBtn.title = tip;
      }
    }
    const evening = eveningBreakAccess(now);
    const breakDialog = document.getElementById('break-modal');
    if (!evening && lastEveningAccess && workState.mode !== 'break') {
      breakDialog.close();
    }
    if (lastEveningAccess !== evening) breakDialog.setAttribute('closedby', evening ? 'closerequest' : 'none');
    lastEveningAccess = evening;
    const canUseBreakTools = workClock.canUseBreakTools(now);
    const breakEnded = workState.mode === 'break' && !canUseBreakTools;
    const isWorking = workState.mode === 'working';
    const inExamBreak = Boolean(window.StudyRunner?.isInExam?.());
    const endSession = canUseBreakTools && workState.mode !== 'idle';
    const community = document.getElementById('break-community-btn');
    document.getElementById('evening-break-tools-btn').hidden = !evening;
    document.getElementById('break-tool-list').hidden = !canUseBreakTools;
    document.getElementById('break-footer').hidden = !(endSession || evening);
    document.getElementById('break-close-btn').hidden = !evening;
    document.getElementById('break-add-1m').hidden = evening;
    const add5Btn = document.getElementById('break-add-5m');
    if (add5Btn) add5Btn.hidden = evening;
    document.getElementById('break-end-session-btn').hidden = !endSession;
    document.getElementById('break-resume-btn').textContent = isWorking
      ? (inExamBreak ? 'Resume exam' : 'Continue studying')
      : (inExamBreak ? 'Resume exam' : 'Start next 75 min');
    community.hidden = !canUseBreakTools || !window.StudyCommunity?.enabled || Boolean(window.StudyRooms?.running());
    community.textContent = document.getElementById('view-community').hidden ? 'Community' : 'Back to Community';
    cdEl.hidden = evening;
    document.getElementById('break-modal-title').textContent = evening ? 'Evening break tools'
      : breakEnded ? (inExamBreak ? 'Exam break ended' : 'Break ended')
      : (inExamBreak ? 'Exam break' : 'Study break');
    const workedMin = Math.round((workState.lastWaveSec || 0) / 60);
    document.getElementById('break-ratio-note').textContent = evening ? 'Available 18:00–22:30 Oslo time.'
      : breakEnded
        ? (inExamBreak
            ? 'Exam countdown is paused. Add more time or resume your exam.'
            : 'Add a minute to reopen break tools, or start your next session.')
      : inExamBreak
        ? `Exam countdown & question timer are paused.${workedMin ? ` After ${workedMin} ${workedMin === 1 ? 'minute' : 'minutes'} of study.` : ''}`
      : workedMin ? `After ${workedMin} ${workedMin === 1 ? 'minute' : 'minutes'} of study.`
      : 'Take a moment before your next session.';
    document.querySelector('main').inert = breakEnded;
    document.getElementById('global-header').inert = breakEnded;
    document.getElementById('runner-header').inert = breakEnded;
    if (breakEnded && expiredBreakShown !== workState.breakEndsAtMs) {
      expiredBreakShown = workState.breakEndsAtMs;
      closeSettings();
      showBreakModalUi();
      document.getElementById('break-add-1m').focus();
    }
    window.StudyCommunity?.clockTick?.();
    window.StudyLayout?.clockTick?.();
    window.StudySets?.clockTick?.();
    window.StudyRooms?.clockTick?.();
  }

  // ---------------------------------------------------------------------------
  // Low-Fatigue Procedural Background Sound Masking (Web Audio API)
  // ---------------------------------------------------------------------------
  const SOUND_PREFS_KEY = 'study-os-sound-v1';
  const SOUND_PRESETS = {
    brown: {
      id: 'brown',
      name: 'Deep Brown',
      short: 'Brown',
      rms: 0.185,
      desc: 'Deep -6 dB/oct rumble · masks room noise with minimal ear fatigue over 75m blocks.',
    },
    speech: {
      id: 'speech',
      name: 'Speech Blocker',
      short: 'Speech',
      rms: 0.112,
      desc: 'Vocal-band contour (180 Hz–3 kHz) · blocks nearby library chatter at lower volume.',
    },
    pink: {
      id: 'pink',
      name: 'Warm Pink',
      short: 'Pink',
      rms: 0.125,
      desc: 'Balanced -3 dB/oct spectrum with smoothed highs · even full-room acoustic cover.',
    },
    rain: {
      id: 'rain',
      name: 'Soft Rain',
      short: 'Rain',
      rms: 0.122,
      desc: 'Steady filtered rainfall with slow organic breeze modulation · prevents static fatigue.',
    },
    cabin: {
      id: 'cabin',
      name: 'Cabin Hum',
      short: 'Cabin',
      rms: 0.19,
      desc: 'Low-frequency airframe cocoon · masks footsteps, doors, HVAC & desk thuds.',
    },
    gamma40: {
      id: 'gamma40',
      name: 'Brown + 40Hz',
      short: '40Hz',
      rms: 0.175,
      desc: 'Deep brown noise bed + subtle stereo 40 Hz binaural offset (best with headphones).',
    },
  };

  function loadSoundPrefs() {
    const defaults = {
      preset: 'brown',
      volume: 38,
      tone: 52,
      muteOnBreak: true,
      enabled: false,
    };
    try {
      const raw = JSON.parse(localStorage.getItem(SOUND_PREFS_KEY));
      if (!raw || typeof raw !== 'object') return defaults;
      return {
        preset: SOUND_PRESETS[raw.preset] ? raw.preset : 'brown',
        volume: Math.max(0, Math.min(100, Number(raw.volume ?? 38))),
        tone: Math.max(0, Math.min(100, Number(raw.tone ?? 52))),
        muteOnBreak: raw.muteOnBreak !== undefined ? Boolean(raw.muteOnBreak) : true,
        enabled: Boolean(raw.enabled),
      };
    } catch {
      return defaults;
    }
  }

  function makeBiquadFilterFn(type, fc, Q, gainDb, sr) {
    const safeFc = Math.max(20, Math.min(sr * 0.44, fc));
    const w0 = (2 * Math.PI * safeFc) / sr;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * Math.max(0.1, Q));
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

    if (type === 'lowpass') {
      b0 = (1 - cosw) * 0.5;
      b1 = 1 - cosw;
      b2 = (1 - cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cosw) * 0.5;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'bandpass') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'peaking') {
      const A = Math.pow(10, (gainDb || 0) / 40);
      b0 = 1 + alpha * A;
      b1 = -2 * cosw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw;
      a2 = 1 - alpha / A;
    }

    const b0n = b0 / a0;
    const b1n = b1 / a0;
    const b2n = b2 / a0;
    const a1n = a1 / a0;
    const a2n = a2 / a0;
    let z1 = 0;
    let z2 = 0;
    return (x) => {
      const y = b0n * x + z1;
      z1 = b1n * x - a1n * y + z2;
      z2 = b2n * x - a2n * y;
      return y;
    };
  }

  function toneSliderToHz(toneVal) {
    const t = Math.max(0, Math.min(100, Number(toneVal) || 0)) / 100;
    return Math.round(360 * Math.pow(8200 / 360, t));
  }

  function toneDescriptor(toneVal) {
    const hz = toneSliderToHz(toneVal);
    const khz = hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`;
    const feel = toneVal < 30 ? 'Deep' : toneVal < 68 ? 'Warm' : 'Open';
    return `${feel} · ${khz}`;
  }

  function volumeToLinearGain(volPct) {
    const v = Math.max(0, Math.min(100, Number(volPct) || 0)) / 100;
    return 0.58 * Math.pow(v, 1.75);
  }

  const soundMasker = (() => {
    let prefs = loadSoundPrefs();
    let audioCtx = null;
    let hpBus = null;
    let lpTone = null;
    let masterGain = null;
    let activeVoice = null;
    let isPlaying = false;
    let suspendedForBreak = false;
    let waitingForGesture = false;
    let gestureUnlockBound = false;
    const bufferCache = new Map();

    function armGestureUnlock() {
      if (gestureUnlockBound) return;
      gestureUnlockBound = true;
      const unlock = () => {
        if (!isPlaying) {
          disarm();
          return;
        }
        if (!ensureContext()) {
          disarm();
          return;
        }
        const finishStart = () => {
          waitingForGesture = false;
          if (isPlaying && !suspendedForBreak) {
            if (!activeVoice || activeVoice.presetId !== prefs.preset) mountPresetVoice(prefs.preset);
            rampMasterGain(volumeToLinearGain(prefs.volume), 0.25);
          }
          updateDom();
          disarm();
        };
        if (audioCtx.state === 'running') {
          finishStart();
          return;
        }
        audioCtx.resume().then(() => {
          if (audioCtx && audioCtx.state === 'running') finishStart();
        }).catch(() => {});
      };
      const disarm = () => {
        if (!gestureUnlockBound) return;
        gestureUnlockBound = false;
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
        window.removeEventListener('touchstart', unlock, true);
      };
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
      window.addEventListener('touchstart', unlock, true);
    }

    function savePrefs() {
      try {
        localStorage.setItem(SOUND_PREFS_KEY, JSON.stringify(prefs));
      } catch {}
    }

    function ensureContext() {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        hpBus = audioCtx.createBiquadFilter();
        hpBus.type = 'highpass';
        hpBus.frequency.value = 38;
        hpBus.Q.value = 0.707;

        lpTone = audioCtx.createBiquadFilter();
        lpTone.type = 'lowpass';
        lpTone.frequency.value = toneSliderToHz(prefs.tone);
        lpTone.Q.value = 0.65;

        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0;

        hpBus.connect(lpTone);
        lpTone.connect(masterGain);
        masterGain.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    function synthesizeChannelRaw(kind, totalSamples, sr) {
      const out = new Float32Array(totalSamples);
      const warmup = 4096;
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      let brown = 0;
      let dropEnv = 0;
      const dropDecay = Math.exp(-1 / (0.014 * sr));

      const nextPink = (w) => {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        return p * 0.11;
      };

      let chain = [];
      if (kind === 'brown') {
        chain = [
          makeBiquadFilterFn('highpass', 42, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 1150, 0.65, 0, sr),
        ];
      } else if (kind === 'speech') {
        chain = [
          makeBiquadFilterFn('highpass', 165, 0.707, 0, sr),
          makeBiquadFilterFn('peaking', 520, 0.85, 4.5, sr),
          makeBiquadFilterFn('peaking', 1380, 0.95, 5.0, sr),
          makeBiquadFilterFn('lowpass', 2950, 0.8, 0, sr),
          makeBiquadFilterFn('lowpass', 3600, 0.7, 0, sr),
        ];
      } else if (kind === 'pink') {
        chain = [
          makeBiquadFilterFn('highpass', 45, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 3800, 0.65, 0, sr),
        ];
      } else if (kind === 'rain') {
        chain = [
          makeBiquadFilterFn('highpass', 85, 0.707, 0, sr),
          makeBiquadFilterFn('lowpass', 4300, 0.65, 0, sr),
        ];
      } else if (kind === 'cabin') {
        chain = [
          makeBiquadFilterFn('highpass', 36, 0.707, 0, sr),
          makeBiquadFilterFn('peaking', 68, 2.6, 4.2, sr),
          makeBiquadFilterFn('peaking', 136, 2.2, 2.8, sr),
          makeBiquadFilterFn('lowpass', 480, 0.75, 0, sr),
        ];
      }
      const dropBand = kind === 'rain' ? makeBiquadFilterFn('bandpass', 1750, 0.8, 0, sr) : null;

      for (let i = -warmup; i < totalSamples; i++) {
        const w = Math.random() * 2 - 1;
        let x = 0;
        if (kind === 'brown' || kind === 'cabin') {
          brown = (brown + 0.022 * w) / 1.022;
          x = brown * 3.2;
        } else if (kind === 'rain') {
          const p = nextPink(w);
          if (Math.random() < 0.0022) {
            dropEnv = Math.min(1, dropEnv + 0.28 + Math.random() * 0.35);
          } else {
            dropEnv *= dropDecay;
          }
          const pat = dropBand(w) * dropEnv * 0.55;
          x = p * 0.82 + pat;
        } else {
          x = nextPink(w);
        }

        for (let f = 0; f < chain.length; f++) {
          x = chain[f](x);
        }
        if (i >= 0) out[i] = x;
      }
      return out;
    }

    function getBufferForPreset(presetId) {
      const baseKind = presetId === 'gamma40' ? 'brown' : presetId;
      const cacheKey = `${baseKind}:${audioCtx.sampleRate}`;
      if (bufferCache.has(cacheKey)) return bufferCache.get(cacheKey);

      const sr = audioCtx.sampleRate;
      const loopSec = 18;
      const fadeSec = 2;
      const loopSamples = Math.floor(loopSec * sr);
      const fadeSamples = Math.floor(fadeSec * sr);
      const totalSamples = loopSamples + fadeSamples;

      const rawL = synthesizeChannelRaw(baseKind, totalSamples, sr);
      const rawR = synthesizeChannelRaw(baseKind, totalSamples, sr);

      const buf = audioCtx.createBuffer(2, loopSamples, sr);
      const chL = buf.getChannelData(0);
      const chR = buf.getChannelData(1);

      // Equal-power seamless loop crossfade + natural cushioned stereo width (74%)
      const sideScale = 0.74;
      let sumSq = 0;
      let sumL = 0;
      let sumR = 0;

      for (let i = 0; i < loopSamples; i++) {
        let l = rawL[i];
        let r = rawR[i];
        if (i < fadeSamples) {
          const theta = (i / fadeSamples) * Math.PI * 0.5;
          const c = Math.cos(theta);
          const s = Math.sin(theta);
          l = c * rawL[loopSamples + i] + s * rawL[i];
          r = c * rawR[loopSamples + i] + s * rawR[i];
        }
        const mid = 0.5 * (l + r);
        const side = 0.5 * (l - r) * sideScale;
        const outL = mid + side;
        const outR = mid - side;
        chL[i] = outL;
        chR[i] = outR;
        sumL += outL;
        sumR += outR;
      }

      const meanL = sumL / loopSamples;
      const meanR = sumR / loopSamples;
      for (let i = 0; i < loopSamples; i++) {
        chL[i] -= meanL;
        chR[i] -= meanR;
        sumSq += chL[i] * chL[i] + chR[i] * chR[i];
      }

      const curRms = Math.sqrt(sumSq / (2 * loopSamples)) || 1e-6;
      const targetRms = SOUND_PRESETS[presetId]?.rms || 0.15;
      const scale = targetRms / curRms;

      for (let i = 0; i < loopSamples; i++) {
        chL[i] = Math.tanh(chL[i] * scale * 1.1) / 1.1;
        chR[i] = Math.tanh(chR[i] * scale * 1.1) / 1.1;
      }

      bufferCache.set(cacheKey, buf);
      return buf;
    }

    function stopVoiceHandle(voice, fadeSec = 0.26) {
      if (!voice || !audioCtx) return;
      const now = audioCtx.currentTime;
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
        voice.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      } catch {}
      setTimeout(() => {
        voice.nodes.forEach((n) => {
          try {
            if (typeof n.stop === 'function') n.stop();
          } catch {}
          try {
            n.disconnect();
          } catch {}
        });
      }, Math.ceil((fadeSec + 0.06) * 1000));
    }

    function mountPresetVoice(presetId) {
      if (!ensureContext()) return;
      const prev = activeVoice;
      const now = audioCtx.currentTime;

      const vGain = audioCtx.createGain();
      vGain.gain.setValueAtTime(0, now);
      vGain.gain.linearRampToValueAtTime(1, now + 0.28);
      vGain.connect(hpBus);

      const src = audioCtx.createBufferSource();
      src.buffer = getBufferForPreset(presetId);
      src.loop = true;
      const nodes = [src, vGain];

      if (presetId === 'rain') {
        // Ultra-slow organic breeze modulation so steady rain never feels static
        const breezeFilter = audioCtx.createBiquadFilter();
        breezeFilter.type = 'peaking';
        breezeFilter.frequency.value = 1100;
        breezeFilter.Q.value = 0.7;
        breezeFilter.gain.value = 0;

        const lfo = audioCtx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.072;
        const lfoDepth = audioCtx.createGain();
        lfoDepth.gain.value = 2.2;
        lfo.connect(lfoDepth);
        lfoDepth.connect(breezeFilter.gain);

        src.connect(breezeFilter);
        breezeFilter.connect(vGain);
        lfo.start(now);
        nodes.push(breezeFilter, lfo, lfoDepth);
      } else {
        src.connect(vGain);
      }

      if (presetId === 'gamma40') {
        // Subtle 40 Hz stereo gamma binaural offset (200 Hz L / 240 Hz R) tucked under brown noise
        const makeTone = (freq, panVal) => {
          const osc = audioCtx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const g = audioCtx.createGain();
          g.gain.value = 0.02;
          osc.connect(g);
          if (typeof audioCtx.createStereoPanner === 'function') {
            const pan = audioCtx.createStereoPanner();
            pan.pan.value = panVal;
            g.connect(pan);
            pan.connect(vGain);
            nodes.push(osc, g, pan);
          } else {
            g.connect(vGain);
            nodes.push(osc, g);
          }
          osc.start(now);
        };
        makeTone(200, -0.75);
        makeTone(240, 0.75);
      }

      src.start(now);
      activeVoice = { presetId, gain: vGain, nodes };
      if (prev) stopVoiceHandle(prev, 0.28);
    }

    function rampMasterGain(targetVal, rampSec = 0.28) {
      if (!audioCtx || !masterGain) return;
      const now = audioCtx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(targetVal, now + rampSec);
    }

    function updateDom() {
      const presetMeta = SOUND_PRESETS[prefs.preset] || SOUND_PRESETS.brown;
      const toggleEl = document.getElementById('settings-sound-toggle');
      if (toggleEl) toggleEl.checked = Boolean(isPlaying && !suspendedForBreak);

      const statusEl = document.getElementById('sound-status-lbl');
      if (statusEl) {
        statusEl.textContent = !isPlaying
          ? `Off · ${presetMeta.name}`
          : suspendedForBreak
          ? `Auto-muted for 1:5 break · ${presetMeta.name}`
          : waitingForGesture
          ? `Resuming on first tap · ${presetMeta.name} · ${prefs.volume}%`
          : `Playing · ${presetMeta.name} · ${prefs.volume}%`;
      }
      const presetValEl = document.getElementById('settings-sound-preset-val');
      if (presetValEl) presetValEl.textContent = presetMeta.name;

      const descEl = document.getElementById('sound-preset-desc');
      if (descEl) descEl.textContent = presetMeta.desc;

      document.querySelectorAll('[data-sound-preset]').forEach((el) => {
        el.classList.toggle('active', el.dataset.soundPreset === prefs.preset);
      });

      const volSlider = document.getElementById('sound-vol-slider');
      const volLbl = document.getElementById('sound-vol-lbl');
      if (volSlider && Number(volSlider.value) !== prefs.volume) volSlider.value = String(prefs.volume);
      if (volLbl) volLbl.textContent = `${prefs.volume}%`;

      const toneSlider = document.getElementById('sound-tone-slider');
      const toneLbl = document.getElementById('sound-tone-lbl');
      if (toneSlider && Number(toneSlider.value) !== prefs.tone) toneSlider.value = String(prefs.tone);
      if (toneLbl) toneLbl.textContent = toneDescriptor(prefs.tone);

      const breakChk = document.getElementById('sound-break-mute');
      if (breakChk) breakChk.checked = Boolean(prefs.muteOnBreak);

      updateSettingsIndicators();
    }

    return {
      play(presetId = prefs.preset, opts = {}) {
        const persist = opts.persist !== false;
        const silentFail = Boolean(opts.silentFail);
        if (SOUND_PRESETS[presetId]) prefs.preset = presetId;
        if (persist) prefs.enabled = true;
        savePrefs();
        if (!ensureContext()) {
          if (!silentFail) toast('Web Audio is not supported in this browser.');
          return;
        }
        suspendedForBreak = Boolean(!persist && prefs.muteOnBreak && workState.mode === 'break');
        if (!isPlaying || !activeVoice || activeVoice.presetId !== prefs.preset) {
          mountPresetVoice(prefs.preset);
        }
        isPlaying = true;
        waitingForGesture = audioCtx.state === 'suspended';
        if (waitingForGesture) {
          armGestureUnlock();
          audioCtx.resume().then(() => {
            if (audioCtx && audioCtx.state === 'running') {
              waitingForGesture = false;
              if (isPlaying && !suspendedForBreak) {
                rampMasterGain(volumeToLinearGain(prefs.volume), 0.28);
              }
              updateDom();
            }
          }).catch(() => {});
        }
        if (!suspendedForBreak) {
          rampMasterGain(volumeToLinearGain(prefs.volume), 0.3);
        } else {
          rampMasterGain(0, 0.05);
        }
        updateDom();
      },
      restoreFromPrefs() {
        if (!prefs.enabled) return false;
        // Defer AudioContext creation until first user gesture when browser autoplay policy blocks boot audio
        // so Chrome emits zero autoplay warnings while keeping the switch ON and resuming seamlessly on first tap.
        const hasGesture = Boolean(navigator.userActivation?.hasBeenActive);
        if (!hasGesture && !audioCtx) {
          isPlaying = true;
          suspendedForBreak = Boolean(prefs.muteOnBreak && workState.mode === 'break');
          waitingForGesture = true;
          armGestureUnlock();
          updateDom();
          return true;
        }
        this.play(prefs.preset, { persist: false, silentFail: true });
        return true;
      },
      stop(opts = {}) {
        isPlaying = false;
        suspendedForBreak = false;
        waitingForGesture = false;
        if (!opts.keepPref) {
          prefs.enabled = false;
          savePrefs();
        }
        rampMasterGain(0, 0.25);
        if (activeVoice) {
          stopVoiceHandle(activeVoice, 0.25);
          activeVoice = null;
        }
        updateDom();
      },
      toggle() {
        if (isPlaying && !suspendedForBreak) {
          this.stop();
          return false;
        }
        this.play(prefs.preset);
        return true;
      },
      isActive() {
        return Boolean(isPlaying && !suspendedForBreak);
      },
      setPreset(presetId) {
        if (!SOUND_PRESETS[presetId]) return;
        prefs.preset = presetId;
        savePrefs();
        this.play(presetId);
      },
      setVolume(volPct) {
        prefs.volume = Math.max(0, Math.min(100, Math.round(Number(volPct) || 0)));
        savePrefs();
        if (isPlaying && !suspendedForBreak) {
          rampMasterGain(volumeToLinearGain(prefs.volume), 0.08);
        }
        updateDom();
      },
      setTone(toneVal) {
        prefs.tone = Math.max(0, Math.min(100, Math.round(Number(toneVal) || 0)));
        savePrefs();
        if (audioCtx && lpTone) {
          lpTone.frequency.setTargetAtTime(toneSliderToHz(prefs.tone), audioCtx.currentTime, 0.04);
        }
        updateDom();
      },
      setMuteOnBreak(flag) {
        prefs.muteOnBreak = Boolean(flag);
        savePrefs();
        if (isPlaying) {
          if (prefs.muteOnBreak && workState.mode === 'break') {
            suspendedForBreak = true;
            rampMasterGain(0, 0.4);
          } else if (!prefs.muteOnBreak && suspendedForBreak) {
            suspendedForBreak = false;
            rampMasterGain(volumeToLinearGain(prefs.volume), 0.35);
          }
        }
        updateDom();
      },
      syncWithWorkMode(mode) {
        if (!isPlaying) return;
        if (mode === 'idle') {
          this.stop();
          return;
        }
        if (mode === 'break' && prefs.muteOnBreak) {
          suspendedForBreak = true;
          rampMasterGain(0, 0.55);
          updateDom();
        } else if (mode === 'working' && suspendedForBreak) {
          suspendedForBreak = false;
          if (!activeVoice) mountPresetVoice(prefs.preset);
          rampMasterGain(volumeToLinearGain(prefs.volume), 0.45);
          updateDom();
        }
      },
      getSummaryLabel() {
        const p = SOUND_PRESETS[prefs.preset] || SOUND_PRESETS.brown;
        return `${p.name} (${prefs.volume}%)`;
      },
      renderUi: updateDom,
    };
  })();

  // ---------------------------------------------------------------------------
  // iOS-Style Settings Sheet
  // ---------------------------------------------------------------------------
  let soundDrawerExpanded = false;

  function setSoundDrawerExpanded(expanded) {
    const panel = document.getElementById('settings-sound-panel');
    const btn = document.getElementById('settings-sound-expand-btn');
    if (!panel || !btn) return;
    panel.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.classList.toggle('is-expanded', Boolean(expanded));
  }

  function filterSettingsRows(rawQuery) {
    const body = document.getElementById('settings-body');
    if (!body) return;
    const q = String(rawQuery || '').trim().toLowerCase();
    const soundPanel = document.getElementById('settings-sound-panel');
    const items = body.querySelectorAll('[data-settings-item]');
    let visibleCount = 0;

    items.forEach((el) => {
      if (!q) {
        el.classList.remove('ios-search-hidden');
        if (!el.hidden) visibleCount += 1;
        return;
      }
      const hay = `${el.dataset.settingsItem || ''} ${el.textContent || ''}`.toLowerCase();
      const matched = hay.includes(q);
      el.classList.toggle('ios-search-hidden', !matched);
      if (el === soundPanel) {
        setSoundDrawerExpanded(matched);
      }
      if (matched && !el.hidden) visibleCount += 1;
    });

    if (!q) {
      setSoundDrawerExpanded(soundDrawerExpanded);
    }

    body.querySelectorAll('[data-settings-group]').forEach((group) => {
      const hasVisible = [...group.querySelectorAll('[data-settings-item]')].some(
        (el) => !el.hidden && !el.classList.contains('ios-search-hidden')
      );
      group.classList.toggle('ios-search-hidden', !hasVisible);
    });

    const empty = document.getElementById('settings-search-empty');
    if (empty) empty.hidden = !q || visibleCount > 0;
  }

  function updateSettingsIndicators() {
    const soundOn = soundMasker.isActive();
    const tutorOn = Boolean(window.StudyTutor?.isSharing?.());
    const anyLive = soundOn || tutorOn;
    document.querySelectorAll('.settings-active-dot').forEach((dot) => {
      dot.hidden = !anyLive;
    });
    const tutorVal = document.getElementById('settings-tutor-value');
    if (tutorVal) {
      tutorVal.textContent = tutorOn ? 'Live' : 'Off';
      tutorVal.classList.toggle('ios-val-live', tutorOn);
    }
    const layoutVal = document.getElementById('settings-layout-value');
    if (layoutVal && window.StudyLayout?.getActiveTitle) {
      layoutVal.textContent = window.StudyLayout.getActiveTitle();
    }
    const layoutSub = document.getElementById('settings-layout-sub');
    if (layoutSub) {
      layoutSub.textContent = workClock.canUseBreakTools()
        ? 'Customize visible metrics & difficulty labels'
        : 'Opens during breaks or 18:00–22:30 Oslo';
    }
  }

  function openSettings() {
    const dialog = document.getElementById('settings-dialog');
    if (!dialog) return;
    const search = document.getElementById('settings-search');
    if (search) search.value = '';
    filterSettingsRows('');
    applyTheme();
    soundMasker.renderUi();
    updateSettingsIndicators();
    const mathAutoEl = document.getElementById('settings-math-par-answers');
    if (mathAutoEl && window.StudyRunner?.isMathParAutoRevealEnabled) {
      mathAutoEl.checked = Boolean(window.StudyRunner.isMathParAutoRevealEnabled());
    }
    window.StudyApp?.syncSettingsRows?.();
    window.StudyCommunity?.renderSettingsSchoolMajor?.();
    if (!dialog.open) {
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    const body = document.getElementById('settings-body');
    if (body) body.scrollTop = 0;
  }

  function closeSettings() {
    const dialog = document.getElementById('settings-dialog');
    if (dialog?.open) dialog.close();
  }

  function bindGlobalChrome() {
    applyTheme();
    document.querySelectorAll('#settings-theme-seg [data-theme-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.themeVal || 'system';
        setTheme(next);
        toast(
          next === 'system'
            ? `Appearance: System (${getSystemTheme() === 'dark' ? 'Dark' : 'Light'})`
            : `Appearance: ${next === 'dark' ? 'Dark' : 'Light'}`
        );
      });
    });
    if (!systemThemeListenerBound && window.matchMedia) {
      systemThemeListenerBound = true;
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const onSystemThemeChange = () => {
        const p = getThemePrefs();
        if (normalizeThemeMode(p.theme) === 'system') applyTheme(p);
      };
      if (mql.addEventListener) mql.addEventListener('change', onSystemThemeChange);
      else if (mql.addListener) mql.addListener(onSystemThemeChange);
    }
    document.getElementById('settings-pdf-dark-toggle')?.addEventListener('change', (ev) => {
      setPdfDark(ev.target.checked);
    });
    document.getElementById('settings-hide-study-help')?.addEventListener('change', (ev) => {
      const prefs = { ...getThemePrefs(), hideStudyHelp: ev.target.checked };
      saveThemePrefs(prefs);
      applyTheme(prefs);
      filterSettingsRows(document.getElementById('settings-search').value);
    });
    document.getElementById('ref-drawer-close')?.addEventListener('click', closeReferenceDrawer);
    document.getElementById('ref-backdrop')?.addEventListener('click', closeReferenceDrawer);
    const refResizer = document.getElementById('ref-drawer-resizer');
    if (refResizer) {
      refResizer.addEventListener('pointerdown', (ev) => {
        const drawer = document.getElementById('ref-drawer');
        if (!drawer) return;
        ev.preventDefault();
        refResizer.setPointerCapture(ev.pointerId);
        drawer.classList.add('is-resizing');
        const onMove = (mEv) => {
          const maxW = Math.min(580, Math.round(window.innerWidth * 0.88));
          const clamped = Math.max(260, Math.min(maxW, Math.round(mEv.clientX)));
          drawer.style.setProperty('--ref-drawer-w', `${clamped}px`);
        };
        const onUp = () => {
          drawer.classList.remove('is-resizing');
          refResizer.removeEventListener('pointermove', onMove);
          refResizer.removeEventListener('pointerup', onUp);
          refResizer.removeEventListener('pointercancel', onUp);
          const cur = parseInt(drawer.style.getPropertyValue('--ref-drawer-w'), 10);
          if (cur >= 260) {
            try { localStorage.setItem(REF_DRAWER_WIDTH_KEY, String(cur)); } catch {}
          }
        };
        refResizer.addEventListener('pointermove', onMove);
        refResizer.addEventListener('pointerup', onUp);
        refResizer.addEventListener('pointercancel', onUp);
      });
    }
    const lbBox = document.getElementById('img-lightbox');
    const lbStage = document.getElementById('img-lightbox-stage');
    const lbImg = document.getElementById('img-lightbox-target');
    document.getElementById('img-lightbox-close')?.addEventListener('click', closeLightbox);
    document.getElementById('img-lightbox-zoom-reset')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setLightboxZoom(1);
    });
    document.getElementById('img-lightbox-action-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const fn = lightboxState.onAction;
      closeLightbox();
      fn?.();
    });
    if (lbBox && lbStage && lbImg) {
      let lbPanMoved = false;
      lbStage.addEventListener('click', (ev) => {
        if (lbPanMoved) { lbPanMoved = false; return; }
        if (ev.target === lbStage || ev.target === lbBox) closeLightbox();
      });
      lbImg.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setLightboxZoom(lightboxState.zoom > 1.15 ? 1 : 2.1, ev.clientX, ev.clientY);
      });
      // Trackpad pinch-to-zoom (ctrlKey/metaKey wheel on macOS/Windows/Linux) + pan wheel
      lbStage.addEventListener('wheel', (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? lbStage.clientHeight : 1;
          setLightboxZoom(lightboxState.zoom * Math.exp(-ev.deltaY * unit / 140), ev.clientX, ev.clientY);
        } else if (lightboxState.zoom > 1.01) {
          ev.preventDefault();
          lightboxState.tx -= ev.deltaX;
          lightboxState.ty -= ev.deltaY;
          applyLightboxTransform();
        }
      }, { passive: false });
      // Safari trackpad pinch gesture events
      let lbGestureStart = null;
      lbStage.addEventListener('gesturestart', (ev) => {
        ev.preventDefault();
        lbGestureStart = lightboxState.zoom;
      }, { passive: false });
      lbStage.addEventListener('gesturechange', (ev) => {
        if (lbGestureStart == null || !Number.isFinite(ev.scale)) return;
        ev.preventDefault();
        setLightboxZoom(lbGestureStart * ev.scale, ev.clientX, ev.clientY);
      }, { passive: false });
      lbStage.addEventListener('gestureend', (ev) => {
        if (lbGestureStart == null) return;
        ev.preventDefault();
        lbGestureStart = null;
      }, { passive: false });
      // Two-finger touch pinch in fullscreen lightbox
      let lbTouchDist = 0;
      let lbTouchZoom = 1;
      lbStage.addEventListener('touchstart', (ev) => {
        if (ev.touches.length === 2) {
          lbTouchDist = Math.hypot(
            ev.touches[0].clientX - ev.touches[1].clientX,
            ev.touches[0].clientY - ev.touches[1].clientY
          );
          lbTouchZoom = lightboxState.zoom;
        }
      }, { passive: true });
      lbStage.addEventListener('touchmove', (ev) => {
        if (ev.touches.length === 2 && lbTouchDist > 0) {
          ev.preventDefault();
          const d = Math.hypot(
            ev.touches[0].clientX - ev.touches[1].clientX,
            ev.touches[0].clientY - ev.touches[1].clientY
          );
          const midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
          const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
          setLightboxZoom(lbTouchZoom * (d / lbTouchDist), midX, midY);
        }
      }, { passive: false });
      // Smooth 2D pointer drag-to-pan when zoomed in
      lbStage.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || lightboxState.zoom <= 1.01) return;
        if (ev.target !== lbImg) return;
        const startX = ev.clientX;
        const startY = ev.clientY;
        const baseTx = lightboxState.tx;
        const baseTy = lightboxState.ty;
        lbPanMoved = false;
        lbStage.classList.add('is-panning');
        const onMove = (mEv) => {
          const dx = mEv.clientX - startX;
          const dy = mEv.clientY - startY;
          if (!lbPanMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) lbPanMoved = true;
          lightboxState.tx = baseTx + dx;
          lightboxState.ty = baseTy + dy;
          applyLightboxTransform();
        };
        const onUp = () => {
          lbStage.classList.remove('is-panning');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    }

    // iOS Settings Sheet Triggers & Controls
    ['hdr-settings-btn', 'run-settings-btn'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', openSettings);
    });
    document.getElementById('settings-close-btn')?.addEventListener('click', closeSettings);
    const settingsDialog = document.getElementById('settings-dialog');
    // Universal click-outside backdrop dismissal for all non-lockout <dialog> modals
    // Verifies BOTH pointerdown and click occurred outside the dialog box so text-selection drags never dismiss.
    let backdropDownDialog = null;
    const isPointOutsideDialog = (dlg, ev) => {
      if (!dlg || ev.target !== dlg) return false;
      const r = dlg.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return false;
      return ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom;
    };
    document.addEventListener('pointerdown', (ev) => {
      const dlg = ev.target instanceof HTMLDialogElement && ev.target.open ? ev.target : null;
      backdropDownDialog = dlg && isPointOutsideDialog(dlg, ev) ? dlg : null;
    }, true);
    document.addEventListener('click', (ev) => {
      const dlg = backdropDownDialog;
      backdropDownDialog = null;
      if (!dlg || !dlg.open || ev.target !== dlg) return;
      if (!isPointOutsideDialog(dlg, ev)) return;
      if (dlg.hasAttribute('data-no-backdrop-close')) return;
      if (dlg.id === 'break-modal' && !eveningBreakAccess()) return;
      if (dlg === settingsDialog) {
        closeSettings();
        return;
      }
      dlg.close();
    });
    document.getElementById('settings-search')?.addEventListener('input', (ev) => {
      filterSettingsRows(ev.target.value);
    });
    document.getElementById('settings-sound-expand-btn')?.addEventListener('click', () => {
      soundDrawerExpanded = !soundDrawerExpanded;
      setSoundDrawerExpanded(soundDrawerExpanded);
    });
    document.getElementById('settings-playbook-btn')?.addEventListener('click', () => {
      closeSettings();
      window.StudyPlaybook?.open?.();
    });
    document.getElementById('settings-feedback-btn')?.addEventListener('click', () => {
      closeSettings();
      window.StudyCommunity?.openFeedbackDialog?.();
    });
    document.getElementById('settings-layout-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools()) {
        toast('Layout presets open during breaks or 18:00–22:30 Oslo.');
        return;
      }
      closeSettings();
      window.StudyLayout.open(false);
    });
    document.getElementById('settings-fullscreen-toggle')?.addEventListener('change', () => {
      window.StudyRunner?.toggleFullscreen?.();
    });
    document.getElementById('settings-math-par-answers')?.addEventListener('change', (ev) => {
      window.StudyRunner?.setMathParAutoRevealEnabled?.(ev.target.checked);
    });
    document.querySelectorAll('#settings-autopause-seg [data-autopause-val]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.StudyRunner?.setAutoPauseMode?.(btn.dataset.autopauseVal);
      });
    });

    // Background Sound Masking Controls (inside Settings)
    soundMasker.renderUi();
    soundMasker.restoreFromPrefs();
    document.getElementById('settings-sound-toggle')?.addEventListener('change', (ev) => {
      if (ev.target.checked) {
        soundMasker.play();
      } else {
        soundMasker.stop();
      }
    });
    document.querySelectorAll('[data-sound-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        soundMasker.setPreset(btn.dataset.soundPreset);
      });
    });
    document.getElementById('sound-vol-slider')?.addEventListener('input', (ev) => {
      soundMasker.setVolume(ev.target.value);
    });
    document.getElementById('sound-tone-slider')?.addEventListener('input', (ev) => {
      soundMasker.setTone(ev.target.value);
    });
    document.getElementById('sound-break-mute')?.addEventListener('change', (ev) => {
      soundMasker.setMuteOnBreak(ev.target.checked);
    });

    // Personal Dev Mode toggle (Admin / Local Sandbox)
    document.getElementById('settings-dev-mode-toggle').addEventListener('change', (event) => {
      devMode.setActive(event.currentTarget.checked);
    });
    devMode.syncUi();

    // Universal 75m Session + 1:5 Break controls
    const onWorkActionClick = (ev) => {
      if (devModeActive) {
        toast('Dev Mode ON — real work & break timers are frozen.');
        return;
      }
      if (workState.devPausedAtMs) {
        resumeDevClocks();
        renderWorkClockDom();
        if (workState.mode === 'break') showBreakModalUi();
        return;
      }
      const fromRunnerBreakBtn = ev?.currentTarget?.id === 'run-break-btn';
      if (workState.mode === 'working' || (fromRunnerBreakBtn && workState.mode === 'idle')) {
        workClock.triggerBreak(false);
      } else if (workState.mode === 'break') {
        showBreakModalUi();
      } else {
        workClock.ensureWorking();
        toast('75m working interval started (1:5 recovery break at cap).');
      }
    };
    document.getElementById('global-work-action-btn')?.addEventListener('click', onWorkActionClick);
    document.getElementById('run-break-btn')?.addEventListener('click', onWorkActionClick);
    document.getElementById('break-add-1m')?.addEventListener('click', () => {
      workClock.addBreakSeconds(60);
    });
    document.getElementById('break-add-5m')?.addEventListener('click', () => {
      workClock.addBreakSeconds(300);
    });
    const breakDialog = document.getElementById('break-modal');
    breakDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !eveningBreakAccess()) event.preventDefault();
    });
    breakDialog.addEventListener('cancel', (event) => {
      if (!eveningBreakAccess()) event.preventDefault();
    });
    document.getElementById('evening-break-tools-btn')?.addEventListener('click', showBreakModalUi);
    document.getElementById('break-close-btn')?.addEventListener('click', () => {
      breakDialog.close();
    });
    document.getElementById('break-layout-btn')?.addEventListener('click', () => window.StudyLayout.open(true));
    document.getElementById('break-sets-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools()) return;
      breakDialog.close();
      if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
      window.StudyApp.navigate('home');
      const sets = document.getElementById('my-study-sets');
      sets.open = true;
      sets.scrollIntoView({ block: 'start' });
    });
    document.getElementById('break-community-btn')?.addEventListener('click', () => {
      if (!workClock.canUseBreakTools() || window.StudyRooms?.running()) return;
      breakDialog.close();
      if (!document.getElementById('view-community').hidden) return;
      if (!document.getElementById('view-runner').hidden) document.getElementById('run-exit-btn').click();
      window.StudyApp.navigate('community');
    });
    document.getElementById('break-resume-btn')?.addEventListener('click', () => {
      if (workState.mode === 'working') breakDialog.close();
      else workClock.startNextInterval();
    });
    document.getElementById('break-end-session-btn')?.addEventListener('click', () => {
      workClock.endSession();
      toast('Working session ended.');
    });

    // Sync across tabs & persist screen time on blur/hide
    window.addEventListener('storage', (ev) => {
      if (ev.key === WORK_WAVE_KEY) {
        workState = loadWorkState();
        renderWorkClockDom();
      }
    });
    document.addEventListener('visibilitychange', () => {
      renderWorkClockDom();
      saveWorkState();
    });
    window.addEventListener('pagehide', () => {
      renderWorkClockDom();
      saveWorkState();
    });

    if (devModeActive) freezeDevClocks();
    renderWorkClockDom();
    if (!workState.devPausedAtMs && workState.mode === 'break' && (workState.breakEndsAtMs || 0) > Date.now()) {
      showBreakModalUi();
    }
    clearInterval(workTickHandle);
    workTickHandle = setInterval(renderWorkClockDom, 1000);

    // Seamless trackpad pinch-to-zoom on inline markdown images + 1-click fullscreen lightbox
    function ensurePinchImgWrap(img) {
      const existing = img.closest('.md-img-zoom-frame');
      if (existing) return existing;
      const frame = document.createElement('span');
      frame.className = 'md-img-zoom-frame';
      frame.dataset.zoomScale = '1';
      const scroll = document.createElement('span');
      scroll.className = 'md-img-zoom-scroll';
      img.replaceWith(frame);
      img.draggable = false;
      scroll.appendChild(img);
      frame.append(scroll);
      return frame;
    }

    function applyPinchImgScale(frame, nextScale, clientX) {
      if (!frame) return;
      const scroll = frame.querySelector('.md-img-zoom-scroll');
      const img = scroll?.querySelector('img');
      if (!scroll || !img) return;
      const clamped = Math.max(1, Math.min(3.5, Number(nextScale) || 1));
      const prev = Number(frame.dataset.zoomScale || 1) || 1;
      frame.dataset.zoomScale = clamped.toFixed(3);
      frame.classList.toggle('is-zoomed', clamped > 1.02);
      if (clamped <= 1.02) {
        frame.dataset.zoomScale = '1';
        img.style.width = '';
        img.style.maxWidth = '';
        scroll.scrollLeft = 0;
        return;
      }
      const box = scroll.getBoundingClientRect();
      const x = Number.isFinite(clientX) ? clientX - box.left : scroll.clientWidth / 2;
      const pageX = scroll.scrollLeft + x;
      img.style.width = `${Math.round(clamped * 100)}%`;
      img.style.maxWidth = 'none';
      scroll.scrollLeft = Math.max(0, pageX * (clamped / prev) - x);
    }

    document.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      const img = ev.target?.closest?.('.markdown-body img');
      if (!img || !img.src || img.closest('.pdf-figure') || (img.clientWidth > 0 && img.clientWidth < 48)) return;
      ev.preventDefault();
      const frame = ensurePinchImgWrap(img);
      const cur = Number(frame.dataset.zoomScale || 1) || 1;
      const unit = ev.deltaMode === 1 ? 16 : 1;
      applyPinchImgScale(frame, cur * Math.exp(-ev.deltaY * unit / 140), ev.clientX);
    }, { passive: false });

    let mdGestureFrame = null;
    let mdGestureBase = 1;
    document.addEventListener('gesturestart', (ev) => {
      const img = ev.target?.closest?.('.markdown-body img');
      if (!img || !img.src || img.closest('.pdf-figure') || (img.clientWidth > 0 && img.clientWidth < 48)) return;
      ev.preventDefault();
      mdGestureFrame = ensurePinchImgWrap(img);
      mdGestureBase = Number(mdGestureFrame.dataset.zoomScale || 1) || 1;
    }, { passive: false });
    document.addEventListener('gesturechange', (ev) => {
      if (!mdGestureFrame || !Number.isFinite(ev.scale)) return;
      ev.preventDefault();
      applyPinchImgScale(mdGestureFrame, mdGestureBase * ev.scale, ev.clientX);
    }, { passive: false });
    document.addEventListener('gestureend', () => {
      mdGestureFrame = null;
    }, { passive: true });

    // Click directly on any figure or markdown image -> seamless fullscreen lightbox!
    document.addEventListener('click', (e) => {
      const figImg = e.target?.closest?.('.pdf-figure:not([data-pdf-excerpt]) img');
      if (figImg && figImg.src) {
        openLightbox(figImg.src, figImg.alt, { isPdf: true });
        return;
      }

      const mdImg = e.target?.closest?.('.markdown-body img');
      if (mdImg && mdImg.src && !mdImg.closest('.pdf-figure') && !mdImg.closest('a[href]')) {
        if (mdImg.clientWidth > 0 && mdImg.clientWidth < 48) return;
        openLightbox(mdImg.src, mdImg.alt);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!document.getElementById('img-lightbox')?.hidden) {
          closeLightbox();
          e.preventDefault();
          return;
        }
        const zoomedFrames = document.querySelectorAll('.md-img-zoom-frame.is-zoomed');
        if (zoomedFrames.length) {
          zoomedFrames.forEach((f) => applyPinchImgScale(f, 1));
          e.preventDefault();
          return;
        }
        if (isReferenceDrawerOpen()) {
          closeReferenceDrawer();
          e.preventDefault();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.key.toLowerCase() === 'm') {
        const on = soundMasker.toggle();
        toast(on ? `Sound: ${soundMasker.getSummaryLabel()}` : 'Sound off');
        e.preventDefault();
      } else if (e.key === ',' && !document.querySelector('dialog[open]')) {
        openSettings();
        e.preventDefault();
      }
    });
  }

  return {
    esc,
    examLabel,
    clockSec,
    minLabel,
    headingSlug,
    cleanOutlineTitle,
    renderMarkdownWithMath,
    renderNoteProgressive,
    findRelevantReferenceHeadings,
    buildOutlineTreeHtml,
    renderContinuousNeededSectionsHtml,
    shortSectionChipLabel,
    toast,
    applyTheme,
    setTheme,
    getThemeMode,
    toggleTheme,
    togglePdfDark,
    openSettings,
    closeSettings,
    updateSettingsIndicators,
    openReferenceDrawer,
    closeReferenceDrawer,
    isReferenceDrawerOpen,
    syncReferenceDrawerForQuestion,
    openLightbox,
    closeLightbox,
    bindGlobalChrome,
    workClock,
    devMode,
    soundMasker,
  };
})();
