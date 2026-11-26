/* Study-OS Pure Core Module: WISEflow FLOWmulti Numeric & Multi-Slot Accounting Grader + ECTS Grade Scale
 * Zero runtime dependencies · Dual browser (`window.StudyCore`) & Node (`module.exports`) UMD-lite module.
 */
(function (root) {
  'use strict';

  /**
   * @typedef {Object} ParsedWiseflowNumber
   * @property {boolean} ok - True when raw text parsed as a valid BI WISEflow number.
   * @property {number} [value] - Parsed numeric value (present when `ok` is true).
   * @property {boolean} [empty] - True when input was blank/null/undefined.
   * @property {boolean} [parensError] - True when accounting parentheses `(500)` were used instead of `-500`.
   * @property {boolean} [commaError] - True when a decimal comma (`7,25`) was used instead of a dot (`7.25`).
   * @property {boolean} [invalidFormat] - True when input contained invalid characters or malformed number syntax.
   */

  /**
   * @typedef {Object} WiseflowFieldSpec
   * @property {string} id - Unique slot identifier within the worksheet.
   * @property {'number' | 'choice' | string} [type] - Field type (`'choice'` for dropdown/MCQ slot; numeric otherwise).
   * @property {number} [points=1] - Points awarded when slot passes.
   * @property {number} [expected] - Primary expected numeric answer.
   * @property {number[]} [altExpected] - Optional alternative accepted numeric values (e.g., sign/method variants).
   * @property {number} [relTol=0.02] - Relative tolerance fraction (default ±2%).
   * @property {number} [absTol=0.02] - Absolute tolerance floor (default ±0.02).
   * @property {number} [answerIndex] - Correct 0-based option index for `type === 'choice'`.
   * @property {string[]} [options] - Option labels for `type === 'choice'`.
   */

  /**
   * @typedef {Object} WiseflowFieldGrade
   * @property {string} id
   * @property {'choice' | 'number'} type
   * @property {boolean} passed
   * @property {number} earned
   * @property {number} points
   * @property {number | null} [picked]
   * @property {string} [expectedLabel]
   * @property {number} [userValue]
   * @property {number} [expected]
   * @property {number} [matchedTarget]
   * @property {number} [band]
   * @property {boolean} [exact]
   * @property {number} [pctDiff]
   * @property {boolean} [empty]
   * @property {boolean} [parensError]
   * @property {boolean} [commaError]
   * @property {boolean} [invalidFormat]
   */

  /**
   * @typedef {Object} WiseflowSheetResult
   * @property {number} earned - Total points earned across all worksheet slots.
   * @property {number} total - Total possible points across all worksheet slots.
   * @property {number} accuracy - Accuracy ratio `earned / total` (0 when `total === 0`).
   * @property {Record<string, WiseflowFieldGrade>} details - Per-slot grading breakdown keyed by `field.id`.
   */

  /**
   * @typedef {Object} NumericCheckResult
   * @property {boolean} passed - True when parsed numeric input falls within tolerance band.
   * @property {ParsedWiseflowNumber} parsed - Underlying WISEflow number parse result.
   * @property {number} [userValue] - Parsed numeric value when `parsed.ok` is true.
   * @property {number} expected - Expected numeric value.
   * @property {number} tolerance - Effective tolerance band `max(relTol * |expected|, absTol)`.
   * @property {number} [diff] - Absolute difference `|userValue - expected|`.
   */

  /**
   * @typedef {Object} EctsGrade
   * @property {'A' | 'B' | 'C' | 'D' | 'E' | 'F'} letter
   * @property {string} label
   * @property {string} cls
   * @property {0 | 1 | 2 | 3 | 4 | 5} points
   * @property {number} pct
   * @property {number} toA
   */

  /**
   * Parse and normalize a student numeric answer according to BI WISEflow FLOWmulti rules:
   * - Rejects accounting parentheses `(123.45)` in favor of leading minus `-123.45`.
   * - Strips currency symbols (`£`, `$`, `€`, `kr`), `%`, and whitespace.
   * - Allows US thousand-group commas (`40,700`, `1,520,000`, `1,234.56`),
   *   but rejects decimal commas (`7,20`, `-4857,25`) with `commaError: true`.
   * Extracted faithfully from `runner.js#parseWiseflowNumber`.
   * @param {unknown} raw
   * @returns {ParsedWiseflowNumber}
   */
  function parseWiseflowNumber(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return { ok: false, empty: true };
    if (/^\(\s*[\d.,\s]+\s*\)$/.test(str)) {
      return { ok: false, parensError: true };
    }
    // Strip currency/unit symbols & spaces
    let clean = str.replace(/[£$€%\s]/g, '').replace(/^kr/i, '').replace(/kr$/i, '');
    if (clean.includes(',') && clean.includes('.')) {
      clean = clean.replace(/,/g, '');
    } else if (clean.includes(',')) {
      // Distinguish thousand separator `40,700` or `1,520,000` from decimal comma `7,20` / `-4857,25`
      // Per 2026 BI WISEflow Title Page: decimal operator MUST be a dot (`.`), NEVER a comma (`,`)!
      if (/^[+-]?\d{1,3}(,\d{3})+$/.test(clean)) {
        clean = clean.replace(/,/g, '');
      } else {
        return { ok: false, commaError: true };
      }
    }
    clean = clean.replace(/^\+/, '');
    if (!/^-?\d+(\.\d+)?$/.test(clean)) {
      return { ok: false, invalidFormat: true };
    }
    const val = Number(clean);
    if (!Number.isFinite(val)) return { ok: false, invalidFormat: true };
    return { ok: true, value: val };
  }

  /**
   * Format a numeric value for WISEflow feedback badges using dot decimals and en-US grouping.
   * Extracted faithfully from `runner.js#formatWfNum`.
   * @param {unknown} n
   * @returns {string}
   */
  function formatWfNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    const has3Dec = Math.abs(Math.round(v * 100) - v * 100) > 1e-4;
    return v.toLocaleString('en-US', {
      minimumFractionDigits: has3Dec ? 3 : 2,
      maximumFractionDigits: 3,
    });
  }

  /**
   * Grade a single WISEflow FLOWmulti slot (choice dropdown or numeric tolerance box).
   * Evaluates `|userValue - target| <= max(relTol * |target|, absTol) + 1e-9` across
   * `expected` and any `altExpected` values.
   * Extracted faithfully from `runner.js#gradeSingleWiseflowField`.
   * @param {WiseflowFieldSpec} f
   * @param {unknown} rawVal
   * @returns {WiseflowFieldGrade}
   */
  function gradeSingleWiseflowField(f, rawVal) {
    const pts = Number(f.points ?? 1);
    if (f.type === 'choice') {
      const picked = rawVal !== undefined && rawVal !== null && rawVal !== '' ? Number(rawVal) : null;
      const passed = picked !== null && picked === Number(f.answerIndex);
      return {
        id: f.id,
        type: 'choice',
        passed,
        earned: passed ? pts : 0,
        points: pts,
        picked,
        expectedLabel: (f.options || [])[Number(f.answerIndex)] ?? '',
      };
    }

    const parsed = parseWiseflowNumber(rawVal);
    const primaryExp = Number(f.expected);
    const relTol = Number(f.relTol ?? 0.02);
    const absTol = Number(f.absTol ?? 0.02);
    const primaryBand = Math.max(relTol * Math.abs(primaryExp), absTol);

    if (!parsed.ok) {
      return {
        id: f.id,
        type: 'number',
        passed: false,
        earned: 0,
        points: pts,
        expected: primaryExp,
        band: primaryBand,
        empty: !!parsed.empty,
        parensError: !!parsed.parensError,
        commaError: !!parsed.commaError,
        invalidFormat: !!parsed.invalidFormat,
      };
    }

    const userVal = /** @type {number} */ (parsed.value);
    const targets = [primaryExp, ...(Array.isArray(f.altExpected) ? f.altExpected.map(Number) : [])];
    for (const t of targets) {
      const band = Math.max(relTol * Math.abs(t), absTol);
      const diff = Math.abs(userVal - t);
      if (diff <= band + 1e-9) {
        const exact = diff <= 0.015;
        const pctDiff = t !== 0 ? (diff / Math.abs(t)) * 100 : 0;
        return {
          id: f.id,
          type: 'number',
          passed: true,
          earned: pts,
          points: pts,
          userValue: userVal,
          expected: primaryExp,
          matchedTarget: t,
          band: primaryBand,
          exact,
          pctDiff,
        };
      }
    }

    return {
      id: f.id,
      type: 'number',
      passed: false,
      earned: 0,
      points: pts,
      userValue: userVal,
      expected: primaryExp,
      band: primaryBand,
    };
  }

  /**
   * Evaluate all slots of a multi-box WISEflow FLOWmulti question.
   * Extracted faithfully from `runner.js#evaluateWiseflowSheet`.
   * @param {{ wiseflowFields?: WiseflowFieldSpec[] } | null | undefined} q
   * @param {{ wiseflow?: Record<string, unknown> } | null | undefined} st
   * @returns {WiseflowSheetResult}
   */
  function evaluateWiseflowSheet(q, st) {
    const fields = Array.isArray(q?.wiseflowFields) ? q.wiseflowFields : [];
    /** @type {Record<string, WiseflowFieldGrade>} */
    const details = {};
    let earned = 0;
    let total = 0;
    const answers = st?.wiseflow || {};
    for (const f of fields) {
      const res = gradeSingleWiseflowField(f, answers[f.id]);
      details[f.id] = res;
      earned += res.earned;
      total += res.points;
    }
    const accuracy = total > 0 ? earned / total : 0;
    return { earned, total, accuracy, details };
  }

  /**
   * Evaluate a standalone numeric check field against an expected answer with relative & absolute tolerance.
   * Extracted from `runner.js` numeric check handlers.
   * @param {unknown} rawVal
   * @param {number} expected
   * @param {number} [absTol=0.02]
   * @param {number} [relTol=0.02]
   * @returns {NumericCheckResult}
   */
  function evaluateNumericCheck(rawVal, expected, absTol = 0.02, relTol = 0.02) {
    const parsed = parseWiseflowNumber(rawVal);
    const exp = Number(expected);
    const tol = Math.max(Number(relTol) * Math.abs(exp), Number(absTol || 0.02));
    if (!parsed.ok || !Number.isFinite(exp)) {
      return { passed: false, parsed, expected: exp, tolerance: tol };
    }
    const userVal = /** @type {number} */ (parsed.value);
    const diff = Math.abs(userVal - exp);
    return {
      passed: diff <= tol + 1e-9,
      parsed,
      userValue: userVal,
      expected: exp,
      tolerance: tol,
      diff,
    };
  }

  /**
   * Map a percentage score `[0, 100]` to the Norwegian ECTS / BI Oslo grade scale (`A`..`F`).
   * Extracted faithfully from `app.js#gradeFromPct` and unified with `runner.js#fallbackGradeFromPct`.
   * @param {unknown} pct
   * @returns {EctsGrade | null}
   */
  function gradeFromPct(pct) {
    if (pct === null || pct === undefined || pct === '') return null;
    const p = Number(pct);
    if (!Number.isFinite(p)) return null;
    const clamped = Math.max(0, Math.min(100, Math.round(p * 10) / 10));
    const rounded = Math.round(clamped);
    if (clamped >= 85) return { letter: 'A', label: 'Excellent', cls: 'grade-a', points: 5, pct: rounded, toA: 0 };
    if (clamped >= 77) return { letter: 'B', label: 'Very Good', cls: 'grade-b', points: 4, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 65) return { letter: 'C', label: 'Good', cls: 'grade-c', points: 3, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 50) return { letter: 'D', label: 'Satisfactory', cls: 'grade-d', points: 2, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    if (clamped >= 40) return { letter: 'E', label: 'Sufficient', cls: 'grade-e', points: 1, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
    return { letter: 'F', label: 'Fail', cls: 'grade-f', points: 0, pct: rounded, toA: Math.max(1, Math.ceil(85 - clamped)) };
  }

  const api = {
    parseWiseflowNumber,
    formatWfNum,
    gradeSingleWiseflowField,
    evaluateWiseflowSheet,
    evaluateNumericCheck,
    gradeFromPct,
  };

  /** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore = {
    ...(/** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore || {}),
    ...api,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
