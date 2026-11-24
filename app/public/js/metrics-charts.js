/* Interactive Institutional-Grade Metrics & Productivity Charts (Europe/Oslo)
 * Zero-dependency responsive SVG charts with live crosshair tooltips,
 * Daily/Weekly/Monthly granularity, Screen-Time Efficiency (slacking monitor),
 * DLPFC & AI-Par Adjusted Output, Pace-vs-Optimal benchmarks, and Topic Hours vs AI Par.
 */
'use strict';

window.StudyMetrics = (() => {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const uiState = {
    heroMetric: 'study_vs_efficiency', // 'study_vs_efficiency' | 'dlpfc_vs_pace' | 'hours_vs_upi'
    heroGranularity: 'daily', // 'daily' | 'weekly' | 'monthly'
    heroRange: 14, // 14 | 30 | 90
    screenGranularity: 'daily', // 'daily' | 'weekly'
    stackMode: 'course', // 'course' | 'dlpfc'
    stackGranularity: 'daily', // 'daily' | 'weekly'
    topicCourseId: '',
    topicSort: 'lacking', // 'lacking' | 'syllabus' | 'worked'
  };

  let lastCtx = null;
  let liveChartRepainters = null;
  let lastLiveChartState = { activeMin: -1, screenMin: -1, refreshedAtMs: 0 };

  const fmtHours = (min) => {
    const m = Math.max(0, Number(min) || 0);
    if (m < 1) return '0.0h';
    if (m < 60) return `${Math.round(m)}m`;
    const h = m / 60;
    return `${h >= 10 ? h.toFixed(1) : h.toFixed(1)}h`;
  };

  const fmtHrsShort = (hours) => {
    const h = Math.max(0, Number(hours) || 0);
    if (h === 0) return '0h';
    return h >= 10 ? `${h.toFixed(1)}h` : `${h.toFixed(1)}h`;
  };

  const fmtAxisVal = (val, unit) => {
    const v = Number(val) || 0;
    if (unit === 'h') return v === 0 ? '0h' : v < 1 ? `${Math.round(v * 60)}m` : `${v >= 10 ? Math.round(v) : v.toFixed(1)}h`;
    if (unit === '%') return `${Math.round(v)}%`;
    if (unit === 'x') return `${v.toFixed(2)}×`;
    if (unit === 'pts') return v >= 10 ? `${Math.round(v)}` : v.toFixed(1);
    return `${Math.round(v)}`;
  };

  const fmtDateShort = (isoDay) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return String(isoDay || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  const fmtDateFull = (isoDay) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return String(isoDay || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
  };

  function isoWeekKey(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return isoDay;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }

  function aggregateBuckets(dailySeries, granularity, rangeDays) {
    const sorted = [...(dailySeries || [])].sort((a, b) => a.day.localeCompare(b.day));
    if (!sorted.length) return [];

    if (granularity === 'daily') {
      const slice = rangeDays >= 90 ? sorted.slice(-60) : sorted.slice(-rangeDays);
      return slice.map((d) => ({
        key: d.day,
        label: fmtDateShort(d.day),
        tooltipTitle: d.isToday ? `${fmtDateFull(d.day)} · TODAY` : fmtDateFull(d.day),
        isCurrent: Boolean(d.isToday),
        activeMin: d.activeMin || 0,
        screenMin: d.screenMin || 0,
        offScreenMin: d.offScreenMin || 0,
        highMin: d.highMin || 0,
        medMin: d.medMin || 0,
        lowMin: d.lowMin || 0,
        attempts: d.attempts || 0,
        adjustedUnits: d.adjustedUnits || 0,
        paceRatio: d.avgPaceRatio,
        upi: d.upi,
        accuracyPct: d.accuracyPct,
        efficiencyPct: d.efficiencyPct,
        byCourseMin: d.byCourseMin || {},
      }));
    }

    const map = new Map();
    for (const d of sorted) {
      const key = granularity === 'monthly' ? d.day.slice(0, 7) : isoWeekKey(d.day);
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          isCurrent: false,
          activeMin: 0,
          screenMin: 0,
          offScreenMin: 0,
          highMin: 0,
          medMin: 0,
          lowMin: 0,
          attempts: 0,
          adjustedUnits: 0,
          paceSum: 0,
          paceCount: 0,
          upiSum: 0,
          upiCount: 0,
          accSum: 0,
          accCount: 0,
          byCourseMin: {},
        };
        map.set(key, g);
      }
      if (d.isToday) g.isCurrent = true;
      g.activeMin += d.activeMin || 0;
      g.screenMin += d.screenMin || 0;
      g.offScreenMin += d.offScreenMin || 0;
      g.highMin += d.highMin || 0;
      g.medMin += d.medMin || 0;
      g.lowMin += d.lowMin || 0;
      g.attempts += d.attempts || 0;
      g.adjustedUnits += d.adjustedUnits || 0;
      if (d.avgPaceRatio != null && d.attempts > 0) {
        g.paceSum += d.avgPaceRatio * d.attempts;
        g.paceCount += d.attempts;
      }
      if (d.upi != null && d.attempts > 0) {
        g.upiSum += d.upi * d.attempts;
        g.upiCount += d.attempts;
      }
      if (d.accuracyPct != null && d.attempts > 0) {
        g.accSum += d.accuracyPct * d.attempts;
        g.accCount += d.attempts;
      }
      for (const [cid, mins] of Object.entries(d.byCourseMin || {})) {
        g.byCourseMin[cid] = (g.byCourseMin[cid] || 0) + mins;
      }
    }

    return [...map.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(granularity === 'monthly' ? -12 : -16)
      .map((g) => {
        const eff = g.screenMin > 0 ? Math.min(100, Math.round((g.activeMin / g.screenMin) * 100)) : null;
        const label = granularity === 'monthly'
          ? new Date(`${g.key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
          : `Wk ${fmtDateShort(g.key)}`;
        const tooltipTitle = granularity === 'monthly'
          ? `${label.toUpperCase()}${g.isCurrent ? ' · CURRENT' : ''}`
          : `WEEK OF ${fmtDateShort(g.key).toUpperCase()}${g.isCurrent ? ' · THIS WEEK' : ''}`;
        return {
          key: g.key,
          label,
          tooltipTitle,
          isCurrent: g.isCurrent,
          activeMin: Math.round(g.activeMin * 10) / 10,
          screenMin: Math.round(g.screenMin * 10) / 10,
          offScreenMin: Math.round(g.offScreenMin * 10) / 10,
          highMin: Math.round(g.highMin * 10) / 10,
          medMin: Math.round(g.medMin * 10) / 10,
          lowMin: Math.round(g.lowMin * 10) / 10,
          attempts: g.attempts,
          adjustedUnits: Math.round(g.adjustedUnits * 10) / 10,
          paceRatio: g.paceCount > 0 ? Math.round((g.paceSum / g.paceCount) * 100) / 100 : null,
          upi: g.upiCount > 0 ? Math.round(g.upiSum / g.upiCount) : null,
          accuracyPct: g.accCount > 0 ? Math.round(g.accSum / g.accCount) : null,
          efficiencyPct: eff,
          byCourseMin: g.byCourseMin,
        };
      });
  }

  function niceMax(rawMax, minFloor = 1) {
    const v = Math.max(minFloor, Number(rawMax) || 0);
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / pow;
    const step = norm <= 1.2 ? 1.2 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : norm <= 7.5 ? 7.5 : 10;
    return step * pow;
  }

  // Interactive SVG Dual-Axis Combo Chart (Blockworks Research aesthetic)
  function mountComboChart(host, buckets, cfg) {
    if (!host) return;
    if (!buckets.length) {
      host.innerHTML = '<div class="mc-empty">Complete a timed exercise to unlock your interactive productivity timeline.</div>';
      return;
    }

    const W = 760;
    const H = 250;
    const pad = { top: 14, right: 48, bottom: 30, left: 46 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const n = buckets.length;
    const slotW = plotW / Math.max(1, n);
    const barW = Math.max(4, Math.min(28, slotW * 0.62));

    const barVals = buckets.map((b) => Math.max(0, Number(cfg.getBar(b)) || 0));
    const bgVals = cfg.getBgBar ? buckets.map((b) => Math.max(0, Number(cfg.getBgBar(b)) || 0)) : null;
    const lineVals = buckets.map((b) => {
      const v = cfg.getLine(b);
      return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    });

    const maxBarRaw = Math.max(...barVals, ...(bgVals || [0]), cfg.barMinMax || 1);
    const maxBar = niceMax(maxBarRaw * 1.12, cfg.barMinMax || 1);

    const validLines = lineVals.filter((v) => v != null);
    const maxLine = cfg.lineFixedMax || niceMax(Math.max(...validLines, cfg.targetLine || 1, cfg.lineMinMax || 1) * 1.12, cfg.lineMinMax || 1);
    const minLine = cfg.lineFixedMin ?? 0;

    const xOf = (i) => pad.left + (i + 0.5) * slotW;
    const yBar = (v) => pad.top + plotH - (Math.max(0, Math.min(maxBar, v)) / maxBar) * plotH;
    const yLine = (v) => pad.top + plotH - ((Math.max(minLine, Math.min(maxLine, v)) - minLine) / Math.max(0.0001, maxLine - minLine)) * plotH;

    const gridTicks = [0, 0.25, 0.5, 0.75, 1];
    const gridSvg = gridTicks.map((t) => {
      const y = pad.top + plotH * (1 - t);
      const lVal = maxBar * t;
      const rVal = minLine + (maxLine - minLine) * t;
      return `
        <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" class="mc-grid-line" />
        <text x="${pad.left - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="mc-axis-lbl">${esc(fmtAxisVal(lVal, cfg.barUnit))}</text>
        <text x="${W - pad.right + 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="start" class="mc-axis-lbl">${esc(fmtAxisVal(rVal, cfg.lineUnit))}</text>
      `;
    }).join('');

    const targetSvg = cfg.targetLine != null && cfg.targetLine >= minLine && cfg.targetLine <= maxLine
      ? (() => {
          const ty = yLine(cfg.targetLine);
          return `
            <line x1="${pad.left}" y1="${ty.toFixed(1)}" x2="${W - pad.right}" y2="${ty.toFixed(1)}" class="mc-target-line" />
            <text x="${W - pad.right - 4}" y="${(ty - 4).toFixed(1)}" text-anchor="end" class="mc-target-lbl">${esc(cfg.targetLabel || 'Optimal')}</text>
          `;
        })()
      : '';

    const barsSvg = buckets.map((b, i) => {
      const cx = xOf(i);
      const bx = cx - barW / 2;
      const parts = [];
      if (bgVals && bgVals[i] > 0) {
        const yBg = yBar(bgVals[i]);
        const hBg = Math.max(1.5, pad.top + plotH - yBg);
        parts.push(`<rect x="${bx.toFixed(1)}" y="${yBg.toFixed(1)}" width="${barW.toFixed(1)}" height="${hBg.toFixed(1)}" rx="2.5" class="mc-bar-bg" data-idx="${i}" />`);
      }
      if (barVals[i] > 0) {
        const yFg = yBar(barVals[i]);
        const hFg = Math.max(2, pad.top + plotH - yFg);
        const cls = `mc-bar-fg ${b.isCurrent ? 'is-today' : ''}`;
        parts.push(`<rect x="${bx.toFixed(1)}" y="${yFg.toFixed(1)}" width="${barW.toFixed(1)}" height="${hFg.toFixed(1)}" rx="2.5" fill="${cfg.barColor}" class="${cls}" data-idx="${i}" />`);
      }
      return parts.join('');
    }).join('');

    let linePath = '';
    let prevValid = false;
    const dotsSvg = [];
    lineVals.forEach((v, i) => {
      if (v == null) {
        prevValid = false;
        return;
      }
      const x = xOf(i);
      const y = yLine(v);
      linePath += `${prevValid ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      prevValid = true;
      dotsSvg.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${buckets[i].isCurrent ? 3.5 : 2.2}" fill="${cfg.lineColor}" class="mc-line-dot" data-dot="${i}" />`);
    });

    const labelStep = n <= 8 ? 1 : n <= 16 ? 2 : n <= 32 ? 4 : Math.ceil(n / 8);
    const xLabelsSvg = buckets.map((b, i) => {
      if (i !== 0 && i !== n - 1 && i % labelStep !== 0) return '';
      if (i !== n - 1 && n - 1 - i <= Math.max(1, Math.floor(labelStep * 0.7))) return '';
      return `<text x="${xOf(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="mc-axis-lbl ${b.isCurrent ? 'is-today' : ''}">${esc(b.isCurrent && uiState.heroGranularity === 'daily' ? 'Today' : b.label)}</text>`;
    }).join('');

    const hitColsSvg = buckets.map((b, i) => {
      const x0 = pad.left + i * slotW;
      return `<rect x="${x0.toFixed(1)}" y="${pad.top}" width="${slotW.toFixed(1)}" height="${plotH}" fill="transparent" class="mc-hit" data-hit="${i}" />`;
    }).join('');

    host.innerHTML = `
      <div class="mc-svg-stage">
        <svg viewBox="0 0 ${W} ${H}" class="mc-svg" role="img" aria-label="${esc(cfg.ariaLabel || 'Productivity chart')}">
          ${gridSvg}
          ${targetSvg}
          <g class="mc-bars">${barsSvg}</g>
          ${linePath ? `<path d="${linePath.trim()}" fill="none" stroke="${cfg.lineColor}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round" class="mc-line-path" />` : ''}
          <g class="mc-dots">${dotsSvg.join('')}</g>
          <line x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}" class="mc-crosshair" hidden />
          <g class="mc-x-labels">${xLabelsSvg}</g>
          <g class="mc-hits">${hitColsSvg}</g>
        </svg>
        <div class="mc-tooltip" hidden></div>
      </div>
    `;

    bindChartHover(host, buckets, {
      xOf,
      W,
      renderTooltip: cfg.renderTooltip,
    });
  }

  // Interactive Stacked Bar Chart (By Course or By DLPFC Difficulty)
  function mountStackedChart(host, buckets, seriesDefs, opts = {}) {
    if (!host) return;
    if (!buckets.length) {
      host.innerHTML = '<div class="mc-empty">No study blocks logged yet.</div>';
      return;
    }

    const W = 520;
    const H = 215;
    const pad = { top: 14, right: 20, bottom: 28, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    const n = buckets.length;
    const slotW = plotW / Math.max(1, n);
    const barW = Math.max(5, Math.min(26, slotW * 0.64));

    const totals = buckets.map((b) => {
      if (opts.overlayBg) {
        return Math.max(
          seriesDefs.reduce((s, d) => s + Math.max(0, Number(d.getValue(b)) || 0), 0),
          Number(opts.overlayBg(b)) || 0
        );
      }
      return seriesDefs.reduce((s, d) => s + Math.max(0, Number(d.getValue(b)) || 0), 0);
    });
    const maxVal = niceMax(Math.max(...totals, 0.8) * 1.12, 1);
    const avgVal = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;

    const xOf = (i) => pad.left + (i + 0.5) * slotW;
    const yOf = (v) => pad.top + plotH - (Math.max(0, Math.min(maxVal, v)) / maxVal) * plotH;

    const gridSvg = [0, 0.33, 0.67, 1].map((t) => {
      const y = pad.top + plotH * (1 - t);
      return `
        <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" class="mc-grid-line" />
        <text x="${pad.left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="mc-axis-lbl">${esc(fmtAxisVal(maxVal * t, 'h'))}</text>
      `;
    }).join('');

    const avgSvg = avgVal > 0.05 && !opts.overlayBg
      ? (() => {
          const ay = Math.max(pad.top + 12, yOf(avgVal));
          return `<line x1="${pad.left}" y1="${ay.toFixed(1)}" x2="${W - pad.right}" y2="${ay.toFixed(1)}" class="mc-target-line" />
                  <text x="${W - pad.right - 6}" y="${(ay - 4).toFixed(1)}" text-anchor="end" class="mc-target-lbl" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round">Avg ${esc(fmtHrsShort(avgVal))}</text>`;
        })()
      : '';

    const barsSvg = buckets.map((b, i) => {
      const cx = xOf(i);
      const bx = cx - barW / 2;
      const parts = [];
      if (opts.overlayBg) {
        const bgV = Math.max(0, Number(opts.overlayBg(b)) || 0);
        if (bgV > 0) {
          const yBg = yOf(bgV);
          const hBg = Math.max(2, pad.top + plotH - yBg);
          parts.push(`<rect x="${bx.toFixed(1)}" y="${yBg.toFixed(1)}" width="${barW.toFixed(1)}" height="${hBg.toFixed(1)}" rx="2.5" class="mc-bar-bg" data-idx="${i}" />`);
        }
        const fgV = Math.max(0, Number(seriesDefs[0].getValue(b)) || 0);
        if (fgV > 0) {
          const yFg = yOf(fgV);
          const hFg = Math.max(2, pad.top + plotH - yFg);
          const eff = b.efficiencyPct;
          const color = eff != null && eff < 45 ? '#ef4444' : eff != null && eff < 68 ? '#f59e0b' : seriesDefs[0].color;
          parts.push(`<rect x="${bx.toFixed(1)}" y="${yFg.toFixed(1)}" width="${barW.toFixed(1)}" height="${hFg.toFixed(1)}" rx="2.5" fill="${color}" class="mc-bar-fg ${b.isCurrent ? 'is-today' : ''}" data-idx="${i}" />`);
        }
        return parts.join('');
      }
      let acc = 0;
      for (const s of seriesDefs) {
        const v = Math.max(0, Number(s.getValue(b)) || 0);
        if (v <= 0) continue;
        const yTop = yOf(acc + v);
        const yBot = yOf(acc);
        const h = Math.max(1.5, yBot - yTop);
        parts.push(`<rect x="${bx.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${s.color}" class="mc-bar-fg" data-idx="${i}" />`);
        acc += v;
      }
      return parts.join('');
    }).join('');

    const step = n <= 7 ? 1 : n <= 16 ? 3 : Math.ceil(n / 6);
    const xLabelsSvg = buckets.map((b, i) => {
      if (i !== 0 && i !== n - 1 && i % step !== 0) return '';
      if (i !== n - 1 && n - 1 - i <= Math.max(1, Math.floor(step * 0.7))) return '';
      return `<text x="${xOf(i).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="mc-axis-lbl ${b.isCurrent ? 'is-today' : ''}">${esc(b.isCurrent && opts.granularity === 'daily' ? 'Today' : b.label)}</text>`;
    }).join('');

    const hitColsSvg = buckets.map((b, i) => {
      const x0 = pad.left + i * slotW;
      return `<rect x="${x0.toFixed(1)}" y="${pad.top}" width="${slotW.toFixed(1)}" height="${plotH}" fill="transparent" class="mc-hit" data-hit="${i}" />`;
    }).join('');

    host.innerHTML = `
      <div class="mc-svg-stage">
        <svg viewBox="0 0 ${W} ${H}" class="mc-svg" role="img" aria-label="${esc(opts.ariaLabel || 'Breakdown chart')}">
          ${gridSvg}
          ${avgSvg}
          <g class="mc-bars">${barsSvg}</g>
          <line x1="0" y1="${pad.top}" x2="0" y2="${pad.top + plotH}" class="mc-crosshair" hidden />
          <g class="mc-x-labels">${xLabelsSvg}</g>
          <g class="mc-hits">${hitColsSvg}</g>
        </svg>
        <div class="mc-tooltip" hidden></div>
      </div>
    `;

    bindChartHover(host, buckets, {
      xOf,
      W,
      renderTooltip: (b) => opts.renderTooltip(b, avgVal),
    });
  }

  function bindChartHover(host, buckets, { xOf, W, renderTooltip }) {
    const stage = host.querySelector('.mc-svg-stage');
    const crosshair = host.querySelector('.mc-crosshair');
    const tip = host.querySelector('.mc-tooltip');
    if (!stage || !tip) return;

    const showIdx = (idx) => {
      const b = buckets[idx];
      if (!b) return;
      const cx = xOf(idx);
      if (crosshair) {
        crosshair.setAttribute('x1', cx.toFixed(1));
        crosshair.setAttribute('x2', cx.toFixed(1));
        crosshair.hidden = false;
      }
      host.querySelectorAll('.mc-bar-fg, .mc-bar-bg').forEach((el) => {
        el.classList.toggle('is-dim', Number(el.dataset.idx) !== idx);
      });
      host.querySelectorAll('.mc-line-dot').forEach((el) => {
        el.classList.toggle('is-active', Number(el.dataset.dot) === idx);
      });
      tip.innerHTML = renderTooltip(b);
      tip.hidden = false;
      const pctX = (cx / W) * 100;
      if (pctX > 58) {
        tip.style.left = 'auto';
        tip.style.right = `${Math.max(4, 100 - pctX + 3)}%`;
      } else {
        tip.style.right = 'auto';
        tip.style.left = `${Math.max(4, pctX + 3)}%`;
      }
    };

    const hideAll = () => {
      if (crosshair) crosshair.hidden = true;
      tip.hidden = true;
      host.querySelectorAll('.is-dim').forEach((el) => el.classList.remove('is-dim'));
      host.querySelectorAll('.is-active').forEach((el) => el.classList.remove('is-active'));
    };

    host.querySelectorAll('.mc-hit').forEach((rect) => {
      const idx = Number(rect.dataset.hit);
      rect.addEventListener('pointerenter', () => showIdx(idx));
      rect.addEventListener('click', () => showIdx(idx));
    });
    stage.addEventListener('pointerleave', hideAll);
  }

  function renderTopicMatrix(container, ctx) {
    if (!container) return;
    const matrix = ctx.analytics?.topicMatrix || {};
    const catalog = ctx.catalog || [];
    const availableCourses = catalog.filter((c) => Array.isArray(matrix[c.courseId]) && matrix[c.courseId].length > 0);
    if (!availableCourses.length) {
      container.innerHTML = '<p class="muted" style="margin:6px 0">Topic coverage benchmarks will appear once course topics load.</p>';
      return;
    }

    if (!uiState.topicCourseId || !matrix[uiState.topicCourseId]?.length) {
      // Pick the course with the most attempts, or first available
      const byCourse = ctx.analytics?.subgroups?.byCourse || {};
      const best = [...availableCourses].sort((a, b) => (byCourse[b.courseId]?.count || 0) - (byCourse[a.courseId]?.count || 0))[0];
      uiState.topicCourseId = best.courseId;
    }

    const course = availableCourses.find((c) => c.courseId === uiState.topicCourseId) || availableCourses[0];
    const rawTopics = [...(matrix[course.courseId] || [])];
    const sorted = rawTopics.sort((a, b) => {
      if (uiState.topicSort === 'worked') return (b.workedMin - a.workedMin) || (b.coveragePct - a.coveragePct);
      if (uiState.topicSort === 'lacking') {
        const score = (t) => (t.revisitCount > 0 ? -20 : 0) + t.ratioToPar * 100 + (t.doneCount / Math.max(1, t.totalCount)) * 40;
        return score(a) - score(b);
      }
      return (a.order ?? 0) - (b.order ?? 0);
    });

    const totalWorkedMin = rawTopics.reduce((s, t) => s + t.workedMin, 0);
    const totalParMin = rawTopics.reduce((s, t) => s + t.recommendedMin, 0);
    const readyCount = rawTopics.filter((t) => t.status === 'ready').length;
    const lackingCount = rawTopics.filter((t) => t.status === 'lacking').length;
    const maxParMin = Math.max(...rawTopics.map((t) => Math.max(t.recommendedMin, t.workedMin)), 20);
    const overallPct = totalParMin > 0 ? Math.min(100, Math.round((totalWorkedMin / totalParMin) * 100)) : 0;

    container.innerHTML = `
      <div class="mc-card-head">
        <div>
          <h3 class="mc-card-title">Topic Hours Worked vs AI-Par Exam Target</h3>
          <p class="mc-card-sub">Filled bar = hours worked · underlined track = recommended AI-Par hours before exam (${esc(course.examInfo?.date || 'exam prep')})</p>
        </div>
        <div class="mc-controls">
          <select class="mc-select" id="mc-topic-course" aria-label="Select course">
            ${availableCourses.map((c) => `<option value="${esc(c.courseId)}" ${c.courseId === course.courseId ? 'selected' : ''}>${esc(c.code)} · ${esc(c.shortTitle)}</option>`).join('')}
          </select>
          <div class="mc-seg" role="group" aria-label="Sort topics">
            <button type="button" class="mc-seg-btn ${uiState.topicSort === 'lacking' ? 'active' : ''}" data-topic-sort="lacking">Lacking</button>
            <button type="button" class="mc-seg-btn ${uiState.topicSort === 'syllabus' ? 'active' : ''}" data-topic-sort="syllabus">Syllabus</button>
            <button type="button" class="mc-seg-btn ${uiState.topicSort === 'worked' ? 'active' : ''}" data-topic-sort="worked">Most worked</button>
          </div>
        </div>
      </div>

      <div class="mc-topic-summary">
        <span><strong>${esc(fmtHours(totalWorkedMin))}</strong> / ${esc(fmtHours(totalParMin))} AI-Par target (${overallPct}%)</span>
        <span class="badge good">${readyCount}/${rawTopics.length} exam-ready</span>
        ${lackingCount ? `<span class="badge debt">${lackingCount} lacking</span>` : '<span class="badge good">0 lacking</span>'}
        ${course.examInfo?.date ? `<span class="badge">Exam: ${esc(course.examInfo.date)}</span>` : ''}
      </div>

      <div class="mc-topic-list">
        ${sorted.map((t) => {
          const trackPct = Math.max(12, Math.min(100, Math.round((t.recommendedMin / maxParMin) * 100)));
          const fillPctOfTrack = t.recommendedMin > 0 ? Math.min(100, Math.round((t.workedMin / t.recommendedMin) * 100)) : 0;
          const overPar = t.recommendedMin > 0 && t.workedMin > t.recommendedMin * 1.05;
          const remainingMin = Math.max(0, t.recommendedMin - t.workedMin);
          const barTone = t.status === 'ready' ? 'is-good' : t.status === 'building' ? 'is-mid' : 'is-lack';
          const statusBadge = t.status === 'ready'
            ? '<span class="mc-tbadge is-good">Ready</span>'
            : t.status === 'building'
            ? '<span class="mc-tbadge is-mid">Building</span>'
            : '<span class="mc-tbadge is-lack">Lacking</span>';
          const paceStr = t.avgPaceRatio != null
            ? `${t.avgPaceRatio.toFixed(2)}× par`
            : '';
          const tipText = `${t.title} — Worked ${fmtHours(t.workedMin)} of ${fmtHours(t.recommendedMin)} AI-Par target (${remainingMin > 0 ? `${fmtHours(remainingMin)} left` : 'target reached'}). ${t.doneCount}/${t.totalCount} Qs done${t.revisitCount ? `, ${t.revisitCount} flagged` : ''}${t.avgAccuracy != null ? `, ${Math.round(t.avgAccuracy * 100)}% acc` : ''}.`;
          return `
            <div class="mc-topic-row" title="${esc(tipText)}">
              <div class="mc-topic-top">
                <div class="mc-topic-name-wrap">
                  <span class="mc-topic-id">T${esc(t.id)}</span>
                  <span class="mc-topic-name">${esc(t.title)}</span>
                  ${statusBadge}
                  ${t.revisitCount ? `<span class="mc-tbadge is-warn">${t.revisitCount} revisit</span>` : ''}
                </div>
                <div class="mc-topic-stats">
                  <span class="mc-topic-hrs"><b>${esc(fmtHours(t.workedMin))}</b> / ${esc(fmtHours(t.recommendedMin))} par</span>
                  <span class="muted">${t.doneCount}/${t.totalCount} Qs${paceStr ? ` · ${esc(paceStr)}` : ''}</span>
                  <button type="button" class="ghost-btn mc-topic-go" data-topic-practice="${esc(course.courseId)}" data-topic-id="${esc(t.id)}">Practice</button>
                </div>
              </div>
              <div class="mc-topic-bar-canvas">
                <div class="mc-topic-par-track" style="width:${trackPct}%">
                  <div class="mc-topic-fill ${barTone} ${overPar ? 'is-over' : ''}" style="width:${fillPctOfTrack}%"></div>
                  <span class="mc-topic-par-tick" aria-hidden="true"></span>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
    `;

    container.querySelector('#mc-topic-course')?.addEventListener('change', (ev) => {
      uiState.topicCourseId = ev.target.value;
      renderTopicMatrix(container, ctx);
    });
    container.querySelectorAll('[data-topic-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.topicSort = btn.dataset.topicSort || 'lacking';
        renderTopicMatrix(container, ctx);
      });
    });
    container.querySelectorAll('[data-topic-practice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.topicPractice;
        const tid = btn.dataset.topicId;
        if (typeof ctx.onPracticeTopic === 'function') {
          ctx.onPracticeTopic(cid, tid);
        } else {
          window.StudyApp?.navigate?.('course', { courseId: cid });
        }
      });
    });
  }

  function renderDashboard(root, ctx) {
    if (!root) return;
    lastCtx = ctx;
    const a = ctx.analytics || {};
    const ov = a.overall || {};
    const sub = a.subgroups || {};
    const db = a.dlpfcBudget || {};
    const l7 = a.last7Days || {};
    const dailySeries = Array.isArray(a.dailySeries) ? a.dailySeries : [];
    const catalog = ctx.catalog || [];
    const scr = window.StudyUI?.workClock?.getScreenStats?.() || {};

    const todayActiveMin = Number(a.today?.totalActiveMinutes || 0);
    const screenSec = Number(scr.screenSec || 0);
    const liveActiveMin = Math.max(todayActiveMin, Math.round((Number(a.today?.liveActiveSec || 0)) / 60));
    const screenMin = Math.max(liveActiveMin, Math.round(screenSec / 60));
    const effToday = screenMin > 0 ? Math.min(100, Math.round((liveActiveMin / screenMin) * 100)) : null;
    const effTone = effToday == null ? '' : effToday >= 70 ? 'good' : effToday >= 45 ? 'gold' : 'debt';
    const effVerdict = effToday == null
      ? 'Start a run to measure'
      : effToday >= 72
      ? `${effToday}% focused`
      : effToday >= 48
      ? `${effToday}% active · moderate drift`
      : `${effToday}% active · high idle screen time`;

    const pace = ov.avgPaceRatio;
    const paceDeltaPct = pace != null ? Math.round((pace - 1) * 100) : null;
    const pacePill = paceDeltaPct == null
      ? ''
      : paceDeltaPct >= 0
      ? `<span class="mc-delta is-up">+${paceDeltaPct}% vs par</span>`
      : `<span class="mc-delta is-down">${paceDeltaPct}% vs par</span>`;

    const upiDelta = l7.upi != null && l7.prev7Upi != null ? l7.upi - l7.prev7Upi : null;
    const upiDeltaPill = upiDelta == null
      ? ''
      : `<span class="mc-delta ${upiDelta >= 0 ? 'is-up' : 'is-down'}">${upiDelta >= 0 ? '+' : ''}${upiDelta} vs prev 7d</span>`;

    const outDelta = l7.adjustedUnits != null && l7.prevAdjustedUnits > 0
      ? Math.round(((l7.adjustedUnits - l7.prevAdjustedUnits) / l7.prevAdjustedUnits) * 100)
      : null;
    const outDeltaPill = outDelta == null
      ? ''
      : `<span class="mc-delta ${outDelta >= 0 ? 'is-up' : 'is-down'}">${outDelta >= 0 ? '+' : ''}${outDelta}% vs prev wk</span>`;

    const courseNameMap = Object.fromEntries(catalog.map((c) => [c.courseId, `${c.code} · ${c.shortTitle}`]));
    const slotNames = {
      morning_06_12: 'Morning (06–12 Oslo)',
      afternoon_12_17: 'Afternoon (12–17 Oslo)',
      evening_17_23: 'Evening (17–23 Oslo)',
      night_23_06: 'Night (23–06 Oslo)',
    };
    const dlpfcNames = {
      high_3: 'Hard (High DLPFC)',
      med_2: 'Medium (Med DLPFC)',
      low_1: 'Easy (Low DLPFC)',
    };

    const subgroupRows = (obj, labelFn) => {
      const entries = Object.entries(obj || {}).filter(([, v]) => v && v.count > 0);
      if (!entries.length) return '';
      return entries
        .sort((aEntry, bEntry) => (bEntry[1].count || 0) - (aEntry[1].count || 0))
        .map(([k, v]) => {
          const pr = v.avgPaceRatio != null ? `${v.avgPaceRatio.toFixed(2)}×` : '—';
          return `<tr>
            <td><strong>${esc(labelFn(k))}</strong></td>
            <td class="mc-num">${v.count}</td>
            <td class="mc-num"><b>${v.upi ?? '—'}</b></td>
            <td class="mc-num">${v.avgAccuracy != null ? `${Math.round(v.avgAccuracy * 100)}%` : '—'}</td>
            <td class="mc-num">${pr}</td>
            <td class="mc-num">${v.beatAiRate != null ? `${Math.round(v.beatAiRate * 100)}%` : '—'}</td>
            <td class="mc-num">${esc(fmtHours(v.totalActiveMinutes || 0))}</td>
          </tr>`;
        })
        .join('');
    };

    const courseRowsHtml = subgroupRows(sub.byCourse, (k) => courseNameMap[k] || k)
      || '<tr><td colspan="7" class="muted">No timed attempts recorded yet.</td></tr>';
    const subParts = [
      subgroupRows(sub.byDlpfcTier, (k) => dlpfcNames[k] || k),
      subgroupRows(sub.byKind, (k) => `Format: ${k.toUpperCase()}`),
      subgroupRows(sub.byTimeSlot, (k) => slotNames[k] || k),
    ].filter(Boolean);
    const subRowsHtml = subParts.length
      ? subParts.join('')
      : '<tr><td colspan="7" class="muted">No timed attempts recorded yet.</td></tr>';

    const corrHtml = (a.correlations || [])
      .map(
        (c) => `<div class="metric-tile">
          <small>${esc(c.label)}</small>
          <p style="margin:6px 0 0;font-weight:600;font-size:13.5px">${esc(c.summary)}</p>
        </div>`
      )
      .join('');

    const tel = window.StudyUI?.workClock?.getTelemetrySummary?.() || a.telemetrySummary || null;
    const telToday = tel?.today || {};
    const paperOn = Boolean(window.StudyUI?.workClock?.isPaperMode?.());
    const ver = a.verification || { auto_graded: 0, ide_verified: 0, self_verified: 0, fast_flag: 0 };
    const fmtSecMin = (s) => {
      const m = Math.round((Number(s) || 0) / 60);
      return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
    };
    const hasExtTel = (Number(telToday.extStudySec) || 0) + (Number(telToday.extDistractSec) || 0) > 0;
    const honestEff = tel?.honestEfficiencyPct ?? effToday;
    const effToneHonest = honestEff == null ? '' : honestEff >= 70 ? 'good' : honestEff >= 45 ? 'gold' : 'debt';
    const effVerdictHonest = honestEff == null
      ? 'Start a run to measure'
      : honestEff >= 72
      ? `${honestEff}% focused`
      : honestEff >= 48
      ? `${honestEff}% active · moderate drift`
      : `${honestEff}% active · high idle / browse time`;

    root.innerHTML = `
      <div class="mc-top-head">
        <div>
          <h1 class="sch-page-title">Metrics &amp; Telemetry</h1>
          <small class="muted">Oslo time (Europe/Oslo) · Multi-tab locked · ${tel?.deviceCount || 1} device${(tel?.deviceCount || 1) === 1 ? '' : 's'} · ${tel?.bucketCount || 0} verifiable 5m buckets</small>
        </div>
        <div class="mc-top-actions">
          <button type="button" class="mini-tool-btn ${paperOn ? 'active' : ''}" id="btn-mc-paper-mode" title="Keep active solving time running while working on paper or in an IDE without counting as AFK">
            ${paperOn ? '📝 Paper / IDE Mode: ON' : '📝 Paper / IDE Mode'}
          </button>
          <button type="button" class="mini-tool-btn" id="btn-mc-export-telemetry" title="Download raw immutable 5m telemetry buckets + per-device daily ledger as JSON">
            Export Telemetry JSON
          </button>
          <span class="mc-live-pill"><i aria-hidden="true"></i>LIVE · Oslo</span>
        </div>
      </div>

      <div class="mc-kpi-grid">
        <div class="mc-kpi-card">
          <div class="mc-kpi-label">Hours Worked (Oslo)</div>
          <div class="mc-kpi-val-row">
            <b id="mc-live-hours-today">${esc(fmtHours(liveActiveMin))}</b>
            <span class="mc-delta is-neutral" id="mc-live-hours-week">Wk ${esc(fmtHours(l7.totalActiveMinutes || 0))}</span>
          </div>
          <small class="muted">Deep (Hard) today: ${esc(((db.todayHighMinutes || 0) / 60).toFixed(1))}h / 4.5h cap</small>
        </div>

        <div class="mc-kpi-card">
          <div class="mc-kpi-label">Screen Time vs Work</div>
          <div class="mc-kpi-val-row">
            <b id="mc-live-screen-today">${esc(screenSec >= liveActiveMin * 60 && scr.screenLabel ? scr.screenLabel : fmtHours(screenMin))}</b>
            <span class="badge ${effToneHonest}" id="mc-live-eff-badge">${honestEff != null ? `${honestEff}% active` : 'Idle'}</span>
          </div>
          <small class="muted" id="mc-live-screen-sub">${esc(effVerdictHonest)} · ${esc(scr.offScreenLabel || fmtHours(db.todayAwayMinutes || 0))} off-screen</small>
        </div>

        <div class="mc-kpi-card">
          <div class="mc-kpi-label">Productivity Index (UPI)</div>
          <div class="mc-kpi-val-row">
            <b>${l7.upi ?? ov.upi ?? '—'}</b>
            ${upiDeltaPill}
          </div>
          <small class="muted">All-time: ${ov.upi ?? '—'} · ${a.totalAttempts || 0} Qs · ${ov.avgAccuracy != null ? `${Math.round(ov.avgAccuracy * 100)}%` : '—'} acc</small>
        </div>

        <div class="mc-kpi-card">
          <div class="mc-kpi-label">Pace vs AI Par</div>
          <div class="mc-kpi-val-row">
            <b>${pace != null ? `${pace.toFixed(2)}×` : '—'}</b>
            ${pacePill}
          </div>
          <small class="muted">Beat AI Par on ${ov.beatAiRate != null ? `${Math.round(ov.beatAiRate * 100)}%` : '—'} of tasks</small>
        </div>

        <div class="mc-kpi-card">
          <div class="mc-kpi-label">DLPFC-Adjusted Output (7d)</div>
          <div class="mc-kpi-val-row">
            <b>${l7.adjustedUnits != null ? `${l7.adjustedUnits.toFixed(1)}` : '0.0'}</b>
            ${outDeltaPill}
          </div>
          <small class="muted">${l7.attempts || 0} Qs weighted by difficulty × AI Par</small>
        </div>
      </div>

      <div class="mc-telemetry-strip">
        <div class="mc-tel-group">
          <span class="mc-tel-lbl">Today Breakdown</span>
          <span class="mc-tel-chip is-solve">Solving <b>${esc(fmtSecMin(telToday.solvingSec))}</b></span>
          <span class="mc-tel-chip is-read">Reading <b>${esc(fmtSecMin(telToday.readingSec))}</b></span>
          <span class="mc-tel-chip is-browse">App Browse <b>${esc(fmtSecMin(telToday.appBrowseSec))}</b></span>
          <span class="mc-tel-chip is-afk">AFK Idle <b>${esc(fmtSecMin(telToday.afkIdleSec))}</b></span>
          <span class="mc-tel-chip is-break">Breaks <b>${esc(fmtSecMin(telToday.breakSec))}</b></span>
          ${hasExtTel ? `<span class="mc-tel-chip is-solve">Browser Study <b>${esc(fmtSecMin(telToday.extStudySec))}</b></span><span class="mc-tel-chip is-afk">Browser Distract <b>${esc(fmtSecMin(telToday.extDistractSec))}</b></span>` : ''}
        </div>
        <div class="mc-tel-group">
          <span class="mc-tel-lbl">Verification</span>
          <span class="mc-tel-chip is-solve">Auto-graded <b>${ver.auto_graded || 0}</b></span>
          <span class="mc-tel-chip is-read">IDE Verified <b>${ver.ide_verified || 0}</b></span>
          <span class="mc-tel-chip is-browse">Self-check <b>${ver.self_verified || 0}</b></span>
          ${ver.fast_flag > 0 ? `<span class="mc-tel-chip is-afk">Fast-flagged <b>${ver.fast_flag}</b></span>` : ''}
        </div>
      </div>

      <!-- HERO BLOCKWORKS-STYLE DUAL-AXIS INTERACTIVE CHART -->
      <section class="panel mc-chart-card">
        <div class="mc-card-head">
          <div>
            <h3 class="mc-card-title" id="mc-hero-title">Productivity &amp; Efficiency Overview</h3>
            <p class="mc-card-sub" id="mc-hero-sub">Compare daily/weekly work against screen time, AI-Par pace, and optimal targets</p>
          </div>
          <div class="mc-controls">
            <select class="mc-select" id="mc-hero-metric" aria-label="Chart metric">
              <option value="study_vs_efficiency" ${uiState.heroMetric === 'study_vs_efficiency' ? 'selected' : ''}>Study Hours vs Focus %</option>
              <option value="dlpfc_vs_pace" ${uiState.heroMetric === 'dlpfc_vs_pace' ? 'selected' : ''}>DLPFC Output vs AI-Par Pace</option>
              <option value="hours_vs_upi" ${uiState.heroMetric === 'hours_vs_upi' ? 'selected' : ''}>Study Hours vs UPI Score</option>
            </select>
            <select class="mc-select" id="mc-hero-gran" aria-label="Time granularity">
              <option value="daily" ${uiState.heroGranularity === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${uiState.heroGranularity === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="monthly" ${uiState.heroGranularity === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select>
            <div class="mc-seg" id="mc-hero-range-seg" ${uiState.heroGranularity !== 'daily' ? 'hidden' : ''}>
              <button type="button" class="mc-seg-btn ${uiState.heroRange === 14 ? 'active' : ''}" data-hero-range="14">14D</button>
              <button type="button" class="mc-seg-btn ${uiState.heroRange === 30 ? 'active' : ''}" data-hero-range="30">30D</button>
              <button type="button" class="mc-seg-btn ${uiState.heroRange === 90 ? 'active' : ''}" data-hero-range="90">All</button>
            </div>
          </div>
        </div>
        <div class="mc-legend" id="mc-hero-legend"></div>
        <div id="mc-hero-chart"></div>
      </section>

      <!-- 2-COLUMN SECONDARY CHARTS -->
      <div class="mc-two-col">
        <section class="panel mc-chart-card">
          <div class="mc-card-head">
            <div>
              <h3 class="mc-card-title">Active Work vs Screen Time</h3>
              <p class="mc-card-sub">Spot slacking: bright bar = real work inside muted total screen time</p>
            </div>
            <div class="mc-seg">
              <button type="button" class="mc-seg-btn ${uiState.screenGranularity === 'daily' ? 'active' : ''}" data-screen-gran="daily">Daily</button>
              <button type="button" class="mc-seg-btn ${uiState.screenGranularity === 'weekly' ? 'active' : ''}" data-screen-gran="weekly">Weekly</button>
            </div>
          </div>
          <div class="mc-legend">
            <span class="mc-leg-item"><i style="background:#0f766e"></i>Active work (≥68% focus)</span>
            <span class="mc-leg-item"><i style="background:#f59e0b"></i>Drift (45–67%)</span>
            <span class="mc-leg-item"><i style="background:#ef4444"></i>High idle (&lt;45%)</span>
            <span class="mc-leg-item"><i class="is-muted"></i>Total screen time</span>
          </div>
          <div id="mc-screen-chart"></div>
        </section>

        <section class="panel mc-chart-card">
          <div class="mc-card-head">
            <div>
              <h3 class="mc-card-title">Hours Worked Breakdown</h3>
              <p class="mc-card-sub">Compare Oslo study hours across courses or DLPFC difficulty tiers</p>
            </div>
            <div class="mc-controls">
              <div class="mc-seg">
                <button type="button" class="mc-seg-btn ${uiState.stackMode === 'course' ? 'active' : ''}" data-stack-mode="course">Course</button>
                <button type="button" class="mc-seg-btn ${uiState.stackMode === 'dlpfc' ? 'active' : ''}" data-stack-mode="dlpfc">Difficulty</button>
              </div>
              <div class="mc-seg">
                <button type="button" class="mc-seg-btn ${uiState.stackGranularity === 'daily' ? 'active' : ''}" data-stack-gran="daily">Daily</button>
                <button type="button" class="mc-seg-btn ${uiState.stackGranularity === 'weekly' ? 'active' : ''}" data-stack-gran="weekly">Weekly</button>
              </div>
            </div>
          </div>
          <div class="mc-legend" id="mc-stack-legend"></div>
          <div id="mc-stack-chart"></div>
        </section>
      </div>

      <!-- TOPIC COVERAGE & HOURS WORKED VS AI-PAR RECOMMENDED BEFORE EXAM -->
      <section class="panel mc-chart-card" id="mc-topics-card"></section>

      ${(() => {
        const aid = ctx.examAidStats;
        if (!aid || (!aid.examQTotal && !aid.sitCount && !aid.refQs && !aid.hintsTotal)) return '';
        const indLabel = aid.independencePct != null ? `${aid.independencePct}%` : '—';
        const indTone = aid.independencePct == null ? '' : aid.independencePct >= 85 ? 'good' : aid.independencePct >= 65 ? 'gold' : 'debt';
        const refMinTxt = aid.refSec >= 60 ? `${Math.round(aid.refSec / 60)}m` : aid.refSec > 0 ? `${aid.refSec}s` : '0m';
        const gapsHtml = aid.recallGaps?.length
          ? `<div class="mc-aid-gaps">
              <div class="mc-aid-gaps-head">
                <small class="muted"><strong>Formula &amp; Concept Recall Gaps</strong> — topics where you opened Reference or Hints during exams</small>
              </div>
              <div class="mc-aid-gap-list">
                ${aid.recallGaps.map((g) => {
                  const refPart = g.refCount > 0
                    ? `<span class="exam-hint-chip ${g.openBook ? 'is-info' : 'is-assisted'}">📖 Ref ${g.refCount}×${g.refSec >= 10 ? ` (${g.refSec >= 60 ? `${Math.round(g.refSec / 60)}m` : `${Math.round(g.refSec)}s`})` : ''}</span>`
                    : '';
                  const hintPart = g.hintCount > 0
                    ? `<span class="exam-hint-chip is-assisted">💡 ${g.hintCount} hint${g.hintCount === 1 ? '' : 's'}</span>`
                    : '';
                  return `<div class="mc-aid-gap-row">
                    <div class="mc-aid-gap-info">
                      <span class="mc-aid-course-tag">${esc(g.courseCode)}</span>
                      <strong>${esc(g.topicTitle)}</strong>
                      <div class="mc-aid-gap-chips">${refPart}${hintPart}</div>
                    </div>
                    <button type="button" class="ghost-btn mc-aid-drill-btn" data-aid-drill-course="${esc(g.courseId)}" data-aid-drill-topic="${esc(g.topicId)}">Drill closed-book →</button>
                  </div>`;
                }).join('')}
              </div>
            </div>`
          : `<p class="muted" style="font-size:12.5px;margin:8px 0 0">No formula or reference lookup gaps recorded yet — all logged exam questions were solved without notes or hints.</p>`;
        return `
          <section class="panel mc-chart-card mc-aid-card" id="mc-exam-aid-card">
            <div class="mc-card-head">
              <div>
                <h3 class="mc-card-title">Closed-Book Independence &amp; Exam Aid Reliance</h3>
                <p class="mc-card-sub">Tracks Reference book opens &amp; Hints during exams so you spot formulas you haven't memorized yet</p>
              </div>
              ${aid.independencePct != null ? `<span class="badge ${indTone}">${indLabel} unassisted</span>` : ''}
            </div>
            <div class="mc-aid-stats">
              <div class="mc-aid-tile"><small>Closed-Book Independence</small><b>${indLabel}</b><span>${aid.closedBookQTotal ? `${aid.closedBookQClean}/${aid.closedBookQTotal} closed-book Qs` : `${aid.cleanSitCount}/${aid.sitCount} clean sits`}</span></div>
              <div class="mc-aid-tile"><small>Exam Reference Lookups</small><b>${aid.refQs} Q${aid.refQs === 1 ? '' : 's'}</b><span>${refMinTxt} in notes during exams</span></div>
              <div class="mc-aid-tile"><small>Exam Hints Used</small><b>${aid.hintsTotal}</b><span>Across logged exam runs</span></div>
              <div class="mc-aid-tile"><small>Clean Exam Sits</small><b>${aid.cleanSitCount} / ${aid.sitCount}</b><span>0 hints &amp; 0 closed-book ref</span></div>
            </div>
            ${gapsHtml}
          </section>`;
      })()}

      <!-- FIXED SUBGROUP TABLES -->
      <div class="mc-two-col">
        <section class="panel mc-table-card">
          <h3 class="mc-card-title" style="margin-bottom:8px">Performance by Course</h3>
          <div class="task-table-wrap">
            <table class="task-table mc-compact-table">
              <thead><tr><th>Course</th><th class="mc-num">Qs</th><th class="mc-num">UPI</th><th class="mc-num">Acc</th><th class="mc-num">Pace</th><th class="mc-num">Beat AI</th><th class="mc-num">Time</th></tr></thead>
              <tbody>${courseRowsHtml}</tbody>
            </table>
          </div>
        </section>

        <section class="panel mc-table-card">
          <h3 class="mc-card-title" style="margin-bottom:8px">By Difficulty, Format &amp; Oslo Time</h3>
          <div class="task-table-wrap">
            <table class="task-table mc-compact-table">
              <thead><tr><th>Subgroup</th><th class="mc-num">Qs</th><th class="mc-num">UPI</th><th class="mc-num">Acc</th><th class="mc-num">Pace</th><th class="mc-num">Beat AI</th><th class="mc-num">Time</th></tr></thead>
              <tbody>${subRowsHtml}</tbody>
            </table>
          </div>
        </section>
      </div>

      ${corrHtml ? `
        <section class="panel" style="margin-bottom:14px">
          <span class="eyebrow">Subjective Check-In ↔ Objective UPI</span>
          <h3 style="margin:4px 0 8px">Personal Performance Correlations</h3>
          <div class="metrics-grid">${corrHtml}</div>
        </section>` : ''}

      <details class="panel mc-brief-details">
        <summary>AI Coach &amp; Telemetry Brief <small class="muted" style="font-weight:500;margin-left:6px">Copy structured snapshot for any LLM</small></summary>
        <div class="row-actions" style="margin:10px 0 8px">
          <button type="button" class="primary-btn" id="btn-copy-ai-brief">Copy AI Brief</button>
          <small class="muted">Local agents also read <code>Study-OS/data/logs/ai_context_snapshot.json</code></small>
        </div>
        <textarea id="txt-ai-brief" readonly style="font-family:ui-monospace,monospace;font-size:12px;min-height:190px">${esc(ctx.aiBriefText || '')}</textarea>
      </details>
    `;

    // Paint Hero Combo Chart
    const paintHero = () => {
      const buckets = aggregateBuckets(dailySeries, uiState.heroGranularity, uiState.heroRange);
      const heroEl = root.querySelector('#mc-hero-chart');
      const legEl = root.querySelector('#mc-hero-legend');
      const titleEl = root.querySelector('#mc-hero-title');
      const subEl = root.querySelector('#mc-hero-sub');
      const rangeSeg = root.querySelector('#mc-hero-range-seg');
      if (rangeSeg) rangeSeg.hidden = uiState.heroGranularity !== 'daily';

      if (uiState.heroMetric === 'dlpfc_vs_pace') {
        if (titleEl) titleEl.textContent = 'DLPFC-Adjusted Output vs AI-Par Pace';
        if (subEl) subEl.textContent = 'Bars = exercises weighted by difficulty × AI Par · Line = speed vs optimal par (1.00× = on par, >1.00× = faster)';
        if (legEl) {
          legEl.innerHTML = `
            <span class="mc-leg-item"><i style="background:#0ea5e9"></i>DLPFC-Adjusted Output (pts)</span>
            <span class="mc-leg-item"><i style="background:#f59e0b"></i>Pace Ratio vs AI Par (×)</span>
            <span class="mc-leg-item"><i class="is-dash"></i>1.00× Optimal Par</span>`;
        }
        mountComboChart(heroEl, buckets, {
          ariaLabel: 'DLPFC-Adjusted Output vs AI-Par Pace',
          getBar: (b) => b.adjustedUnits,
          getLine: (b) => b.paceRatio,
          barColor: '#0ea5e9',
          lineColor: '#f59e0b',
          barUnit: 'pts',
          lineUnit: 'x',
          barMinMax: 5,
          lineFixedMin: 0,
          lineFixedMax: 1.5,
          targetLine: 1.0,
          targetLabel: '1.00× AI Par',
          renderTooltip: (b) => {
            const diff = b.paceRatio != null ? Math.round((b.paceRatio - 1) * 100) : null;
            const diffTxt = diff == null ? '—' : diff >= 0 ? `+${diff}% faster than par` : `${diff}% slower than par`;
            return `
              <div class="mc-tt-head">${esc(b.tooltipTitle)}</div>
              <div class="mc-tt-row"><span><i style="background:#0ea5e9"></i>DLPFC Output</span><b>${b.adjustedUnits.toFixed(1)} pts</b></div>
              <div class="mc-tt-row"><span><i style="background:#f59e0b"></i>Pace vs AI Par</span><b>${b.paceRatio != null ? `${b.paceRatio.toFixed(2)}×` : '—'}</b></div>
              <div class="mc-tt-sub">${esc(diffTxt)} · ${b.attempts} Qs · ${esc(fmtHours(b.activeMin))}</div>
            `;
          },
        });
      } else if (uiState.heroMetric === 'hours_vs_upi') {
        if (titleEl) titleEl.textContent = 'Oslo Study Hours vs UPI Score';
        if (subEl) subEl.textContent = 'Bars = active hours worked · Line = Universal Productivity Index (accuracy + pace + difficulty)';
        if (legEl) {
          legEl.innerHTML = `
            <span class="mc-leg-item"><i style="background:#0f766e"></i>Active Study Hours</span>
            <span class="mc-leg-item"><i style="background:#f59e0b"></i>UPI Score</span>
            <span class="mc-leg-item"><i class="is-dash"></i>80 Target UPI</span>`;
        }
        mountComboChart(heroEl, buckets, {
          ariaLabel: 'Study Hours vs UPI Score',
          getBar: (b) => b.activeMin / 60,
          getLine: (b) => b.upi,
          barColor: '#0f766e',
          lineColor: '#f59e0b',
          barUnit: 'h',
          lineUnit: 'upi',
          barMinMax: 2,
          lineFixedMin: 0,
          lineFixedMax: 120,
          targetLine: 80,
          targetLabel: '80 Target UPI',
          renderTooltip: (b) => `
            <div class="mc-tt-head">${esc(b.tooltipTitle)}</div>
            <div class="mc-tt-row"><span><i style="background:#0f766e"></i>Active Study</span><b>${esc(fmtHours(b.activeMin))}</b></div>
            <div class="mc-tt-row"><span><i style="background:#f59e0b"></i>UPI Score</span><b>${b.upi ?? '—'}</b></div>
            <div class="mc-tt-sub">${b.attempts} Qs · ${b.accuracyPct != null ? `${b.accuracyPct}% acc` : 'no graded Qs'} · Hard ${esc(fmtHours(b.highMin))}</div>
          `,
        });
      } else {
        if (titleEl) titleEl.textContent = 'Oslo Study Hours vs Focus Efficiency';
        if (subEl) subEl.textContent = 'Bars = active study inside total screen time · Line = focus efficiency % (spot slacking instantly)';
        if (legEl) {
          legEl.innerHTML = `
            <span class="mc-leg-item"><i style="background:#0f766e"></i>Active Study Hours</span>
            <span class="mc-leg-item"><i class="is-muted"></i>Total Screen Time</span>
            <span class="mc-leg-item"><i style="background:#f59e0b"></i>Focus Efficiency (%)</span>
            <span class="mc-leg-item"><i class="is-dash"></i>75% Optimal</span>`;
        }
        mountComboChart(heroEl, buckets, {
          ariaLabel: 'Oslo Study Hours vs Focus Efficiency',
          getBar: (b) => b.activeMin / 60,
          getBgBar: (b) => b.screenMin / 60,
          getLine: (b) => b.efficiencyPct,
          barColor: '#0f766e',
          lineColor: '#f59e0b',
          barUnit: 'h',
          lineUnit: '%',
          barMinMax: 2,
          lineFixedMin: 0,
          lineFixedMax: 100,
          targetLine: 75,
          targetLabel: '75% Optimal',
          renderTooltip: (b) => {
            const idleMin = Math.max(0, b.screenMin - b.activeMin);
            return `
              <div class="mc-tt-head">${esc(b.tooltipTitle)}</div>
              <div class="mc-tt-row"><span><i style="background:#0f766e"></i>Active Study</span><b>${esc(fmtHours(b.activeMin))}</b></div>
              <div class="mc-tt-row"><span><i class="is-muted"></i>Screen Time</span><b>${esc(fmtHours(b.screenMin))}</b></div>
              <div class="mc-tt-row"><span><i style="background:#f59e0b"></i>Focus Efficiency</span><b>${b.efficiencyPct != null ? `${b.efficiencyPct}%` : '—'}</b></div>
              <div class="mc-tt-sub">Idle on screen: ${esc(fmtHours(idleMin))} · ${b.attempts} Qs · ${b.adjustedUnits.toFixed(1)} adj. pts</div>
            `;
          },
        });
      }
    };

    // Paint Screen Time vs Work Chart
    const paintScreen = () => {
      const buckets = aggregateBuckets(dailySeries, uiState.screenGranularity, 14);
      mountStackedChart(
        root.querySelector('#mc-screen-chart'),
        buckets,
        [{ label: 'Active Study', color: '#0f766e', getValue: (b) => b.activeMin / 60 }],
        {
          granularity: uiState.screenGranularity,
          ariaLabel: 'Active Work vs Screen Time',
          overlayBg: (b) => b.screenMin / 60,
          renderTooltip: (b) => {
            const idleMin = Math.max(0, b.screenMin - b.activeMin);
            const verdict = b.efficiencyPct == null ? 'No screen time' : b.efficiencyPct >= 70 ? 'Dialed in' : b.efficiencyPct >= 45 ? 'Moderate drift' : 'High idle time';
            return `
              <div class="mc-tt-head">${esc(b.tooltipTitle)}</div>
              <div class="mc-tt-row"><span><i style="background:#0f766e"></i>Active Work</span><b>${esc(fmtHours(b.activeMin))}</b></div>
              <div class="mc-tt-row"><span><i class="is-muted"></i>Total Screen</span><b>${esc(fmtHours(b.screenMin))}</b></div>
              <div class="mc-tt-row"><span>Unworked Screen</span><b>${esc(fmtHours(idleMin))}</b></div>
              <div class="mc-tt-sub">${b.efficiencyPct != null ? `${b.efficiencyPct}% active · ` : ''}${esc(verdict)}</div>
            `;
          },
        }
      );
    };

    // Paint Stacked Course / DLPFC Workload Chart
    const paintStack = () => {
      const buckets = aggregateBuckets(dailySeries, uiState.stackGranularity, 14);
      const legEl = root.querySelector('#mc-stack-legend');
      let defs;
      if (uiState.stackMode === 'dlpfc') {
        defs = [
          { key: 'high', label: 'Hard (High DLPFC)', color: '#ef4444', getValue: (b) => b.highMin / 60 },
          { key: 'med', label: 'Medium', color: '#f59e0b', getValue: (b) => b.medMin / 60 },
          { key: 'low', label: 'Easy', color: '#10b981', getValue: (b) => b.lowMin / 60 },
        ];
      } else {
        const fallbackColors = ['#0f766e', '#2563eb', '#d97706', '#7c3aed', '#e11d48', '#0891b2'];
        defs = catalog.slice(0, 6).map((c, i) => ({
          key: c.courseId,
          label: c.code || c.shortTitle,
          color: c.color || fallbackColors[i % fallbackColors.length],
          getValue: (b) => (b.byCourseMin?.[c.courseId] || 0) / 60,
        }));
      }
      if (legEl) {
        legEl.innerHTML = defs.map((d) => `<span class="mc-leg-item"><i style="background:${esc(d.color)}"></i>${esc(d.label)}</span>`).join('');
      }
      mountStackedChart(root.querySelector('#mc-stack-chart'), buckets, defs, {
        granularity: uiState.stackGranularity,
        ariaLabel: 'Study Hours Breakdown',
        renderTooltip: (b, avgH) => {
          const totalH = b.activeMin / 60;
          const vsAvg = avgH > 0.05 ? Math.round(((totalH - avgH) / avgH) * 100) : null;
          const rows = defs
            .map((d) => ({ label: d.label, color: d.color, h: d.getValue(b) }))
            .filter((r) => r.h > 0.005)
            .map((r) => `<div class="mc-tt-row"><span><i style="background:${esc(r.color)}"></i>${esc(r.label)}</span><b>${esc(fmtHours(r.h * 60))}</b></div>`)
            .join('');
          return `
            <div class="mc-tt-head">${esc(b.tooltipTitle)}</div>
            ${rows || '<div class="mc-tt-sub">No active study logged</div>'}
            <div class="mc-tt-sub">Total: <b>${esc(fmtHours(b.activeMin))}</b>${vsAvg != null ? ` (${vsAvg >= 0 ? '+' : ''}${vsAvg}% vs avg)` : ''}</div>
          `;
        },
      });
    };

    paintHero();
    paintScreen();
    paintStack();
    renderTopicMatrix(root.querySelector('#mc-topics-card'), ctx);
    liveChartRepainters = { paintHero, paintScreen, paintStack };
    lastLiveChartState = {
      activeMin: liveActiveMin,
      screenMin,
      refreshedAtMs: Date.now(),
      baseWeekMin: Number(l7.totalActiveMinutes || 0),
      baseTodayMin: liveActiveMin,
    };

    // Bind chart controls
    root.querySelector('#mc-hero-metric')?.addEventListener('change', (ev) => {
      uiState.heroMetric = ev.target.value;
      paintHero();
    });
    root.querySelector('#mc-hero-gran')?.addEventListener('change', (ev) => {
      uiState.heroGranularity = ev.target.value;
      paintHero();
    });
    root.querySelectorAll('[data-hero-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.heroRange = Number(btn.dataset.heroRange) || 14;
        root.querySelectorAll('[data-hero-range]').forEach((b) => b.classList.toggle('active', b === btn));
        paintHero();
      });
    });
    root.querySelectorAll('[data-screen-gran]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.screenGranularity = btn.dataset.screenGran || 'daily';
        root.querySelectorAll('[data-screen-gran]').forEach((b) => b.classList.toggle('active', b === btn));
        paintScreen();
      });
    });
    root.querySelectorAll('[data-stack-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.stackMode = btn.dataset.stackMode || 'course';
        root.querySelectorAll('[data-stack-mode]').forEach((b) => b.classList.toggle('active', b === btn));
        paintStack();
      });
    });
    root.querySelectorAll('[data-stack-gran]').forEach((btn) => {
      btn.addEventListener('click', () => {
        uiState.stackGranularity = btn.dataset.stackGran || 'daily';
        root.querySelectorAll('[data-stack-gran]').forEach((b) => b.classList.toggle('active', b === btn));
        paintStack();
      });
    });

    root.querySelector('#btn-mc-paper-mode')?.addEventListener('click', (ev) => {
      const next = !window.StudyUI?.workClock?.isPaperMode?.();
      window.StudyUI?.workClock?.setPaperMode?.(next);
      ev.currentTarget.classList.toggle('active', next);
      ev.currentTarget.textContent = next ? '📝 Paper / IDE Mode: ON' : '📝 Paper / IDE Mode';
    });

    root.querySelector('#btn-mc-export-telemetry')?.addEventListener('click', () => {
      const payload = window.StudyUI?.workClock?.exportTelemetryJson?.();
      if (!payload) return;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `study-os-telemetry-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      window.StudyUI?.toast?.('Exported raw verifiable Telemetry Ledger JSON!');
    });

    root.querySelectorAll('[data-aid-drill-course]').forEach((btn) => {
      btn.addEventListener('click', () => {
        ctx.onPracticeTopic?.(btn.dataset.aidDrillCourse, btn.dataset.aidDrillTopic);
      });
    });

    root.querySelector('#btn-copy-ai-brief')?.addEventListener('click', async () => {
      const txt = root.querySelector('#txt-ai-brief')?.value || '';
      try {
        await navigator.clipboard.writeText(txt);
        window.StudyUI?.toast?.('Copied AI Coach Brief to clipboard!');
      } catch {
        const el = root.querySelector('#txt-ai-brief');
        el?.select?.();
        document.execCommand?.('copy');
        window.StudyUI?.toast?.('Copied AI Coach Brief!');
      }
    });
  }

  // Lightweight 1s live ticker (updates KPI tiles in-place + periodically refreshes Today's chart bar without disturbing hover tooltips)
  function updateLiveTiles(scr, liveActiveSec) {
    const hrsEl = document.getElementById('mc-live-hours-today');
    const wkEl = document.getElementById('mc-live-hours-week');
    const scrEl = document.getElementById('mc-live-screen-today');
    const effBadge = document.getElementById('mc-live-eff-badge');
    const scrSub = document.getElementById('mc-live-screen-sub');
    if (!hrsEl && !scrEl) return;

    const baseActiveMin = Number(lastCtx?.analytics?.today?.totalActiveMinutes || 0);
    const activeMin = Math.max(baseActiveMin, Math.round((Number(liveActiveSec) || 0) / 60));
    const scrSec = Number(scr?.screenSec) || 0;
    const screenMin = Math.max(activeMin, Math.round(scrSec / 60));

    if (hrsEl) hrsEl.textContent = fmtHours(activeMin);
    if (wkEl && Number.isFinite(lastLiveChartState.baseWeekMin)) {
      const deltaToday = Math.max(0, activeMin - (lastLiveChartState.baseTodayMin || 0));
      wkEl.textContent = `Wk ${fmtHours(lastLiveChartState.baseWeekMin + deltaToday)}`;
    }
    if (scrEl) {
      scrEl.textContent = scrSec >= activeMin * 60 && scr?.screenLabel ? scr.screenLabel : fmtHours(screenMin);
    }
    if (effBadge) {
      if (screenMin > 0) {
        const eff = Math.min(100, Math.round((activeMin / screenMin) * 100));
        effBadge.textContent = `${eff}% active`;
        effBadge.className = `badge ${eff >= 70 ? 'good' : eff >= 45 ? 'gold' : 'debt'}`;
        if (scrSub) {
          const verdict = eff >= 72 ? `${eff}% focused` : eff >= 48 ? `${eff}% active · moderate drift` : `${eff}% active · high idle screen time`;
          scrSub.textContent = `${verdict} · ${scr?.offScreenLabel || '0m'} off-screen`;
        }
      }
    }

    // Live-refresh Today's bar across SVG charts whenever Today ticks up by ≥1 min (throttled ≥15s) or on a 60s heartbeat
    const nowMs = Date.now();
    const minutesChanged = activeMin !== lastLiveChartState.activeMin || screenMin !== lastLiveChartState.screenMin;
    const elapsedMs = nowMs - (lastLiveChartState.refreshedAtMs || 0);
    const shouldRepaint = liveChartRepainters && Array.isArray(lastCtx?.analytics?.dailySeries) && (
      (minutesChanged && elapsedMs >= 15000) || elapsedMs >= 60000
    );
    if (shouldRepaint) {
      const anyTooltipOpen = Boolean(document.querySelector('#analytics-root .mc-tooltip:not([hidden])'));
      if (!anyTooltipOpen) {
        const todayRow = lastCtx.analytics.dailySeries.find((d) => d.isToday);
        if (todayRow) {
          todayRow.activeMin = Math.max(Number(todayRow.activeMin || 0), activeMin);
          todayRow.screenMin = Math.max(Number(todayRow.screenMin || 0), screenMin, todayRow.activeMin);
          todayRow.offScreenMin = Math.max(Number(todayRow.offScreenMin || 0), Math.round(((Number(scr?.offScreenSec) || 0) / 60) * 10) / 10);
          todayRow.efficiencyPct = todayRow.screenMin > 0.5
            ? Math.min(100, Math.round((todayRow.activeMin / todayRow.screenMin) * 100))
            : null;
          lastLiveChartState.activeMin = activeMin;
          lastLiveChartState.screenMin = screenMin;
          lastLiveChartState.refreshedAtMs = nowMs;
          liveChartRepainters.paintHero();
          liveChartRepainters.paintScreen();
          liveChartRepainters.paintStack();
        }
      }
    }
  }

  return {
    renderDashboard,
    updateLiveTiles,
  };
})();
