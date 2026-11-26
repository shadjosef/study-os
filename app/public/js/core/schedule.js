/* Study-OS Pure Core Module: Circadian Sleep Windows, Study-Budget Estimation & Block Timing State
 * Zero runtime dependencies · Dual browser (`window.StudyCore`) & Node (`module.exports`) UMD-lite module.
 */
(function (root) {
  'use strict';

  /** @const {number} Max daily High-DLPFC synthesis budget in minutes (4.5h/day). */
  const HIGH_DLPFC_CAP_MIN = 270;

  /** @const {number} Overdue study debt rollover window in milliseconds (14 days). */
  const SCHED_DEBT_WINDOW_MS = 14 * 86_400_000;

  /**
   * @typedef {'high_dlpfc' | 'med_dlpfc' | 'low_dlpfc'} DlpfcMode
   */

  /**
   * @typedef {'past' | 'live_now' | 'upcoming'} BlockTimingState
   */

  /**
   * @typedef {Object} SleepWindow
   * @property {string} wakeTime - Normalized `HH:MM` wake-up time.
   * @property {string} bedTime - Derived `HH:MM` bedtime (`wakeTime - sleepHours`, wrapped modulo 24h).
   * @property {string} studyStart - Earliest study start (`wakeTime + 30m`, wrapped modulo 24h).
   * @property {string} studyEnd - Latest study end (`bedTime - 30m`, wrapped modulo 24h).
   * @property {number} sleepHours - Clamped sleep duration in hours `[6, 10]`.
   */

  /**
   * @typedef {Object} StudyBudgetEstimate
   * @property {number} recommendedStudyHours - Recommended weekly self-study hours `[5, 36]`.
   * @property {number} weeklyWorkHours - Clamped paid work hours `[0, 60]`.
   * @property {number} weeklyClassHours - Clamped weekly lecture/class hours `[0, 35]`.
   * @property {number} totalCommittedHours - Sum of work + class + recommended study hours.
   */

  /**
   * @typedef {Object} CircadianTarget
   * @property {DlpfcMode} mode
   * @property {string} windowLabel
   * @property {string} [explain]
   */

  /**
   * @typedef {Object} ScheduleBlockLike
   * @property {string} [eventId]
   * @property {string} [startIso]
   * @property {string} [endIso]
   * @property {string} [startLabel]
   * @property {string} [summary]
   * @property {string} [blockKind]
   * @property {string} [dlpfcMode]
   * @property {BlockTimingState} [timingState]
   * @property {boolean} [optional]
   * @property {boolean} [completed]
   * @property {string} [completedAt]
   * @property {boolean} [completedEarly]
   * @property {boolean} [dismissed]
   * @property {{ cognitiveMode?: string }} [autoQueue]
   */

  /**
   * @typedef {Object} BlockTimingResult
   * @property {BlockTimingState} timingState
   * @property {number} startMs
   * @property {number} endMs
   */

  /**
   * @typedef {Object} LocalScheduleStatus
   * @property {Record<string, { at?: string, early?: boolean } | false>} [completed]
   * @property {Record<string, unknown>} [dismissed]
   */

  /**
   * @typedef {Object} SandboxBlockOverride
   * @property {boolean} [hasCompleted]
   * @property {{ at?: string, early?: boolean } | boolean} [completedValue]
   * @property {boolean} [dismissed]
   */

  /**
   * @typedef {Object} BlockEffectiveStateOptions
   * @property {number} [nowMs] - Epoch ms to evaluate timing against (defaults to `Date.now()`).
   * @property {number} [debtWindowMs] - Overdue debt window in ms (defaults to 14 days).
   * @property {LocalScheduleStatus | null} [localStatus] - Optional desktop localStorage overrides.
   * @property {SandboxBlockOverride | null} [sandboxOverride] - Optional Dev Sandbox overrides.
   * @property {boolean} [useBlockTimingFallback=true] - Fall back to `block.timingState` if timestamps are missing.
   */

  /**
   * @typedef {Object} BlockEffectiveState
   * @property {BlockTimingState} timingState
   * @property {boolean} completed
   * @property {string} completedAt
   * @property {boolean} completedEarly
   * @property {boolean} dismissed
   * @property {boolean} isDebt
   * @property {number} startMs
   * @property {number} endMs
   */

  /**
   * Parse an `HH:MM` 24-hour clock string to minutes since midnight (`0..1439`).
   * Returns `fallback` when invalid.
   * Extracted faithfully from `app.js#parseHmToMins`.
   * @param {unknown} hm
   * @param {number} [fallback=450]
   * @returns {number}
   */
  function parseHmToMins(hm, fallback = 450) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hm || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
  }

  /**
   * Convert minutes since midnight (including negative or >= 1440 values) into `HH:MM`.
   * Extracted faithfully from `app.js#minsToHm`.
   * @param {number} mins
   * @returns {string}
   */
  function minsToHm(mins) {
    const n = ((Math.round(mins) % 1440) + 1440) % 1440;
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }

  /**
   * Derive a student's bedtime and buffered study window (`+30m` after wake, `-30m` before bed)
   * from a wake-up time and sleep duration, wrapping cleanly past midnight.
   * Extracted faithfully from `app.js#deriveSleepWindow`.
   * @param {unknown} wakeTime - Wake-up time in `HH:MM` format (defaults to `07:30`).
   * @param {number} [sleepHours=8] - Target sleep hours, clamped to `[6, 10]`.
   * @returns {SleepWindow}
   */
  function deriveSleepWindow(wakeTime, sleepHours = 8) {
    const wakeMins = parseHmToMins(wakeTime, 7 * 60 + 30);
    const sleep = Math.max(6, Math.min(10, Number(sleepHours) || 8));
    const bedMins = wakeMins - Math.round(sleep * 60);
    return {
      wakeTime: minsToHm(wakeMins),
      bedTime: minsToHm(bedMins),
      studyStart: minsToHm(wakeMins + 30),
      studyEnd: minsToHm(bedMins - 30),
      sleepHours: sleep,
    };
  }

  /**
   * Estimate a sustainable weekly self-study budget from paid work hours, fixed class hours,
   * and active course load. Clamps inputs and prevents burnout under heavy work shifts.
   * Extracted faithfully from `app.js#computeClientStudyEstimate`.
   * @param {number} workH - Paid work hours per week (clamped to `[0, 60]`).
   * @param {number} classH - Fixed lecture/class hours per week (clamped to `[0, 35]`).
   * @param {number} courseCount - Number of active courses (floored at 1).
   * @returns {StudyBudgetEstimate}
   */
  function computeClientStudyEstimate(workH, classH, courseCount) {
    const w = Math.max(0, Math.min(60, Number(workH) || 0));
    const c = Math.max(0, Math.min(35, Number(classH) || 0));
    const courses = Math.max(1, Number(courseCount) || 1);
    const baseAcad = Math.max(12, Math.min(42, courses * 8));
    const rawSelf = Math.max(6, baseAcad - c);
    const penalty = Math.max(0, w - 6) * 0.6;
    const rec = Math.round(Math.max(5, Math.min(36, rawSelf - penalty)) * 10) / 10;
    return {
      recommendedStudyHours: rec,
      weeklyWorkHours: w,
      weeklyClassHours: Math.round(c * 10) / 10,
      totalCommittedHours: Math.round((w + c + rec) * 10) / 10,
    };
  }

  /**
   * Resolve automatic circadian DLPFC cognitive load mode for a given hour of day
   * and cumulative High-DLPFC minutes spent today.
   * Extracted faithfully from `app.js#getCircadianAutoTarget`.
   * @param {number} hour - Local hour of day (`0..23`).
   * @param {number} [usedHighMinutes=0] - High-DLPFC active minutes logged today.
   * @returns {CircadianTarget}
   */
  function getCircadianAutoTarget(hour, usedHighMinutes = 0) {
    const hr = Number(hour);
    const used = Number(usedHighMinutes) || 0;
    if (hr >= 6 && hr < 15) {
      if (used >= HIGH_DLPFC_CAP_MIN) {
        return {
          mode: 'med_dlpfc',
          windowLabel: 'Pre-15:00 · 4.5h Cap Reached',
          explain: 'Switched to Med after reaching the 4.5h High practice limit.',
        };
      }
      return {
        mode: 'high_dlpfc',
        windowLabel: '08:00–15:00 Peak Capacity Window',
      };
    }
    if (hr >= 15 && hr < 18) {
      return {
        mode: 'med_dlpfc',
        windowLabel: '15:00–18:00 Procedural Window',
      };
    }
    return {
      mode: 'low_dlpfc',
      windowLabel: 'Evening Consolidation Window',
    };
  }

  /**
   * Return true when a calendar block represents an actionable study or recall sprint block.
   * @param {ScheduleBlockLike | null | undefined} block
   * @returns {boolean}
   */
  function isStudyBlockKind(block) {
    return block?.blockKind === 'study_block' || block?.blockKind === 'recall_sprint';
  }

  /**
   * Determine whether a scheduled block is `'past'`, `'live_now'`, or `'upcoming'` at `nowMs`.
   * Extracted faithfully from `app.js` calendar hydration & `getBlockEffectiveState`.
   * @param {ScheduleBlockLike | null | undefined} block
   * @param {number} [nowMs=Date.now()]
   * @param {boolean} [useBlockTimingFallback=true]
   * @returns {BlockTimingResult}
   */
  function computeBlockTimingState(block, nowMs = Date.now(), useBlockTimingFallback = true) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const startMs = Date.parse(block?.startIso || '');
    const endMs = Date.parse(block?.endIso || '');
    /** @type {BlockTimingState} */
    const timingState =
      Number.isFinite(endMs) && endMs <= tMs
        ? 'past'
        : Number.isFinite(startMs) && startMs <= tMs
        ? 'live_now'
        : Number.isFinite(startMs)
        ? 'upcoming'
        : useBlockTimingFallback
        ? block?.timingState || 'upcoming'
        : 'upcoming';
    return { timingState, startMs, endMs };
  }

  /**
   * Check whether a past, uncompleted, non-optional study block counts as active rollover study debt.
   * @param {ScheduleBlockLike | null | undefined} block
   * @param {BlockTimingState} timingState
   * @param {boolean} completed
   * @param {boolean} dismissed
   * @param {number} endMs
   * @param {number} [nowMs=Date.now()]
   * @param {number} [debtWindowMs=SCHED_DEBT_WINDOW_MS]
   * @returns {boolean}
   */
  function isBlockStudyDebt(
    block,
    timingState,
    completed,
    dismissed,
    endMs,
    nowMs = Date.now(),
    debtWindowMs = SCHED_DEBT_WINDOW_MS
  ) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const winMs = Number.isFinite(Number(debtWindowMs)) ? Number(debtWindowMs) : SCHED_DEBT_WINDOW_MS;
    return Boolean(
      isStudyBlockKind(block) &&
        !block?.optional &&
        timingState === 'past' &&
        !completed &&
        !dismissed &&
        Number.isFinite(endMs) &&
        endMs >= tMs - winMs
    );
  }

  /**
   * Resolve a scheduled block's effective timing, completion, dismissal, and rollover debt state.
   * Extracted faithfully from `app.js#getBlockEffectiveState`.
   * @param {ScheduleBlockLike | null | undefined} block
   * @param {BlockEffectiveStateOptions} [opts]
   * @returns {BlockEffectiveState}
   */
  function evaluateBlockEffectiveState(block, opts = {}) {
    const id = String(block?.eventId || '');
    const nowMs = Number.isFinite(Number(opts?.nowMs)) ? Number(opts.nowMs) : Date.now();
    const debtWindowMs = Number.isFinite(Number(opts?.debtWindowMs))
      ? Number(opts.debtWindowMs)
      : SCHED_DEBT_WINDOW_MS;
    const useFallback = opts?.useBlockTimingFallback !== false;
    const { timingState, startMs, endMs } = computeBlockTimingState(block, nowMs, useFallback);

    let completed = Boolean(block?.completed);
    let completedAt = block?.completedAt || '';
    let completedEarly = Boolean(block?.completedEarly);
    let dismissed = Boolean(block?.dismissed);

    const loc = opts?.localStatus || null;
    if (loc && id) {
      const locComp = loc.completed ? loc.completed[id] : undefined;
      if (locComp) {
        completed = true;
        completedAt = locComp.at || completedAt;
        completedEarly = Boolean(locComp.early);
      } else if (locComp === false) {
        completed = false;
      }
      if (!completed && loc.dismissed && loc.dismissed[id]) {
        dismissed = true;
      }
    }

    const sandbox = opts?.sandboxOverride || null;
    if (sandbox) {
      if (sandbox.hasCompleted) {
        const s = sandbox.completedValue;
        completed = Boolean(s);
        completedEarly = Boolean(s && typeof s === 'object' && s.early);
        completedAt = (s && typeof s === 'object' && s.at) || '';
      }
      if (sandbox.dismissed) {
        dismissed = true;
      }
    }

    const isDebt = isBlockStudyDebt(block, timingState, completed, dismissed, endMs, nowMs, debtWindowMs);
    return { timingState, completed, completedAt, completedEarly, dismissed, isDebt, startMs, endMs };
  }

  /**
   * Infer a block's DLPFC cognitive mode and tier (`1`=Low, `2`=Med, `3`=High) from explicit metadata,
   * summary keywords, block kind, or start hour.
   * Extracted faithfully from `app.js#inferBlockDlpfc`.
   * @param {ScheduleBlockLike | null | undefined} block
   * @param {string} [fallbackMode='med_dlpfc']
   * @returns {{ mode: string, tier: 1 | 2 | 3 }}
   */
  function inferBlockDlpfcMode(block, fallbackMode = 'med_dlpfc') {
    const rawMode = block?.dlpfcMode || block?.autoQueue?.cognitiveMode || '';
    const sum = String(block?.summary || '');
    let mode = rawMode;
    if (!mode) {
      if (/\b(high\s*dlpfc|hard)\b/i.test(sum)) mode = 'high_dlpfc';
      else if (/\b(low\s*dlpfc|easy|recall)\b/i.test(sum) || block?.blockKind === 'recall_sprint') mode = 'low_dlpfc';
      else if (/\b(med(?:ium)?\s*dlpfc|medium)\b/i.test(sum)) mode = 'med_dlpfc';
      else {
        const rawHour = String(block?.startLabel || '').split(':')[0];
        const h = rawHour !== '' ? Number(rawHour) : NaN;
        if (Number.isFinite(h)) mode = h < 15 ? 'high_dlpfc' : h < 18 ? 'med_dlpfc' : 'low_dlpfc';
        else mode = fallbackMode;
      }
    }
    /** @type {1 | 2 | 3} */
    const tier = mode === 'high_dlpfc' ? 3 : mode === 'low_dlpfc' ? 1 : 2;
    return { mode, tier };
  }

  /**
   * Format a duration in minutes as compact human text (e.g., `50m`, `1h`, `1h 30m`).
   * Extracted faithfully from `app.js#formatDurationShort`.
   * @param {number} minutes
   * @returns {string}
   */
  function formatDurationShort(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r ? `${h}h ${r}m` : `${h}h`;
    }
    return `${m}m`;
  }

  const api = {
    HIGH_DLPFC_CAP_MIN,
    SCHED_DEBT_WINDOW_MS,
    parseHmToMins,
    minsToHm,
    deriveSleepWindow,
    computeClientStudyEstimate,
    getCircadianAutoTarget,
    isStudyBlockKind,
    computeBlockTimingState,
    isBlockStudyDebt,
    evaluateBlockEffectiveState,
    inferBlockDlpfcMode,
    formatDurationShort,
  };

  /** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore = {
    ...(/** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore || {}),
    ...api,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
