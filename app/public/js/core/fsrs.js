/* Study-OS Pure Core Module: FSRS-5 Spaced Repetition, Retrievability & Cognitive Load
 * Zero runtime dependencies · Dual browser (`window.StudyCore`) & Node (`module.exports`) UMD-lite module.
 */
(function (root) {
  'use strict';

  /** @const {number} */
  const MS_PER_DAY = 86_400_000;

  /**
   * Canonical FSRS-5 rating scale.
   * @readonly
   * @enum {1 | 2 | 3 | 4}
   */
  const FSRS_GRADES = Object.freeze({
    AGAIN: /** @type {1} */ (1),
    HARD: /** @type {2} */ (2),
    GOOD: /** @type {3} */ (3),
    EASY: /** @type {4} */ (4),
  });

  /**
   * @typedef {1 | 2 | 3 | 4} FsrsGrade
   */

  /**
   * @typedef {Object} FsrsCardState
   * @property {number} stability - Memory stability in days (time until 90% retrievability).
   * @property {number} [difficulty] - Card difficulty on [1, 10] scale (FSRS-5 full update).
   * @property {number} reps - Total review repetitions.
   * @property {number} [lapses] - Count of Again (grade=1) lapses.
   * @property {FsrsGrade} lastGrade - Most recent rating (1=Again, 2=Hard, 3=Good, 4=Easy).
   * @property {number} scheduledDays - Scheduled review interval in days.
   * @property {string} [lastReview] - ISO-8601 timestamp of last review.
   * @property {string} due - ISO-8601 timestamp when the card becomes due again.
   */

  /**
   * @typedef {Object} DifficultyOverrideResult
   * @property {FsrsGrade} grade - Clamped FSRS grade (1..4).
   * @property {1 | 2 | 3} personalDifficulty - Mapped personal difficulty (3=Hard, 2=Standard, 1=Easy).
   * @property {string} status - Updated progress status ('revisit' | 'done' | preserved status).
   * @property {number} scheduledDays - Computed review interval in days.
   * @property {FsrsCardState} fsrs - Updated FSRS card state.
   */

  /**
   * @typedef {Object} AttemptGradeInput
   * @property {number} qualityAccuracy - Accuracy ratio on [0, 1].
   * @property {number} effectiveSec - Active time plus hint handicap in seconds.
   * @property {number} aiParSec - Target par time in seconds.
   * @property {number} [hintsUsed=0] - Number of hints used.
   * @property {boolean} [assisted=false] - Whether external/solution assistance was used.
   * @property {boolean} [beatAi=false] - Whether attempt beat AI par cleanly.
   */

  /**
   * @typedef {Object} QuestionLike
   * @property {string} [id]
   * @property {string} [kind]
   * @property {number} [difficulty]
   * @property {number} [dlpfcBase]
   * @property {Array<unknown>} [wiseflowFields]
   */

  /**
   * @typedef {Object} ProgressRecordLike
   * @property {string} [status]
   * @property {number} [personalDifficulty]
   * @property {Partial<FsrsCardState>} [fsrs]
   */

  /**
   * @typedef {Object} EffectiveDlpfcResult
   * @property {1 | 2 | 3} base - Intrinsic cognitive load tier (1=Low, 2=Med, 3=High).
   * @property {1 | 2 | 3} tier - Effective cognitive load tier after mastery/struggle adaptation.
   * @property {boolean} chunked - True when mastery has downgraded cognitive load from intrinsic base.
   */

  /**
   * Clamp a numeric value to `[lo, hi]`.
   * @param {number} value
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /**
   * Round a numeric value to 2 decimal places.
   * @param {number} value
   * @returns {number}
   */
  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  /**
   * Normalize any rating input into a valid FSRS grade (`1`..`4`).
   * Defaults invalid or missing values to `3` (Good).
   * @param {unknown} grade
   * @returns {FsrsGrade}
   */
  function clampFsrsGrade(grade) {
    const n = Math.round(Number(grade) || 3);
    return /** @type {FsrsGrade} */ (Math.max(1, Math.min(4, n)));
  }

  /**
   * Compute FSRS-5 power-law retrievability `R(t, S) = (1 + t / (9 * S))^-1`.
   * Returns `1.0` when `elapsedDays === 0` and `0.9` when `elapsedDays === stability`.
   * @param {number} stability - Card stability in days (floored at 0.2).
   * @param {number} elapsedDays - Elapsed days since last review (floored at 0).
   * @returns {number} Estimated recall probability in `(0, 1]`.
   */
  function computeFsrsRetrievability(stability, elapsedDays) {
    const s = Math.max(0.2, Number(stability) || 0.2);
    const t = Math.max(0, Number(elapsedDays) || 0);
    return Math.pow(1 + t / (9 * s), -1);
  }

  /**
   * Auto-suggest an FSRS rating (`1`..`4`) from attempt accuracy, pace, and aid usage.
   * Mirrors `compute_attempt_metrics` in `app/analytics.py`.
   * @param {AttemptGradeInput} metrics
   * @returns {FsrsGrade}
   */
  function suggestFsrsGrade(metrics) {
    const q = clamp(Number(metrics?.qualityAccuracy) || 0, 0, 1);
    const par = Math.max(15, Number(metrics?.aiParSec) || 120);
    const effSec = Math.max(1, Number(metrics?.effectiveSec) || 1);
    const hintsUsed = Math.max(0, Math.round(Number(metrics?.hintsUsed) || 0));
    const assisted = Boolean(metrics?.assisted);
    const beatAi = Boolean(metrics?.beatAi);

    if (q < 0.6) return 1;
    if (hintsUsed > 0 || assisted || effSec > par * 1.25 || q < 0.85) return 2;
    if (beatAi && hintsUsed === 0 && effSec <= par * 0.85 && q >= 0.99) return 4;
    return 3;
  }

  /**
   * Compute the next FSRS-5 memory state for a review (`grade` in `1..4`).
   * Faithful JavaScript port of `update_fsrs_card` in `app/analytics.py`.
   * @param {Partial<FsrsCardState> | null | undefined} prev - Prior card state (null/empty for first review).
   * @param {number} grade - Review rating: 1=Again, 2=Hard, 3=Good, 4=Easy.
   * @param {number} [nowMs=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {FsrsCardState}
   */
  function updateFsrs5Card(prev, grade, nowMs = Date.now()) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const g = clampFsrsGrade(grade);
    const nowIso = new Date(tMs).toISOString();

    if (!prev || !Number(prev.reps)) {
      /** @type {Record<FsrsGrade, number>} */
      const initStabilityMap = { 1: 0.4, 2: 1.2, 3: 3.2, 4: 7.5 };
      const initS = initStabilityMap[g];
      const initD = clamp(6.8 - (g - 1) * 1.1, 1.0, 10.0);
      const intervalDays = g === 1 ? 0.02 : round2(initS);
      return {
        stability: round2(initS),
        difficulty: round2(initD),
        reps: 1,
        lapses: g === 1 ? 1 : 0,
        lastGrade: g,
        scheduledDays: intervalDays,
        lastReview: nowIso,
        due: new Date(tMs + intervalDays * MS_PER_DAY).toISOString(),
      };
    }

    const s = Number(prev.stability) || 1.5;
    const d = Number(prev.difficulty) || 5.0;
    const reps = Math.max(0, Math.round(Number(prev.reps) || 0)) + 1;
    let lapses = Math.max(0, Math.round(Number(prev.lapses) || 0));

    let elapsedDays = 1.0;
    if (typeof prev.lastReview === 'string' && prev.lastReview) {
      const parsedLast = Date.parse(prev.lastReview);
      if (Number.isFinite(parsedLast)) {
        elapsedDays = Math.max(0.05, (tMs - parsedLast) / MS_PER_DAY);
      }
    }

    const retrievability = computeFsrsRetrievability(s, elapsedDays);
    let dNext = clamp(d - 0.55 * (g - 3), 1.0, 10.0);
    dNext = 0.85 * dNext + 0.15 * 5.2;

    /** @type {number} */
    let sNext;
    /** @type {number} */
    let intervalDays;

    if (g === 1) {
      lapses += 1;
      sNext = clamp(s * 0.28, 0.3, Math.max(1.0, s * 0.6));
      intervalDays = 0.04; // ~1 hour same-day revisit
    } else {
      const hardMult = g === 2 ? 0.78 : g === 4 ? 1.28 : 1.0;
      const growth =
        1.0 +
        Math.exp(1.45) *
          (11.0 - dNext) *
          Math.pow(s, -0.18) *
          (Math.exp(0.85 * (1.0 - retrievability)) - 1.0) *
          hardMult;
      sNext = clamp(s * Math.max(1.15, growth), 0.5, 365.0);
      intervalDays = round2(sNext);
    }

    return {
      stability: round2(sNext),
      difficulty: round2(dNext),
      reps,
      lapses,
      lastGrade: g,
      scheduledDays: intervalDays,
      lastReview: nowIso,
      due: new Date(tMs + intervalDays * MS_PER_DAY).toISOString(),
    };
  }

  /**
   * Static-web client FSRS update after logging a graded attempt (`app.js#logAttempt`).
   * Schedules 4 days out on mastery (`qualityAccuracy >= 0.85`), else 1 day out for revisit.
   * @param {Partial<FsrsCardState> | null | undefined} prevFsrs
   * @param {number} qualityAccuracy - Accuracy ratio on [0, 1].
   * @param {number} [nowMs=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {FsrsCardState}
   */
  function scheduleAttemptFsrs(prevFsrs, qualityAccuracy, nowMs = Date.now()) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const qAcc = Number(qualityAccuracy) || 0;
    const mastered = qAcc >= 0.85;
    const daysOut = mastered ? 4 : 1;
    return {
      reps: (Number(prevFsrs?.reps) || 0) + 1,
      stability: daysOut,
      scheduledDays: daysOut,
      lastGrade: mastered ? 3 : 1,
      due: new Date(tMs + daysOut * MS_PER_DAY).toISOString(),
    };
  }

  /**
   * Static-web client 1-click difficulty/FSRS override (`app.js#setQuestionDifficulty`).
   * Scales stability & interval across Again (1d), Hard (1–3d), Good (≥3d, ×1.5), and Easy (≥7d, ×2.5).
   * @param {Partial<FsrsCardState> | null | undefined} prevFsrs
   * @param {number} fsrsGrade - Selected rating (1=Again, 2=Hard, 3=Good, 4=Easy).
   * @param {string} [prevStatus=''] - Existing progress status on the question record.
   * @param {number} [nowMs=Date.now()] - Current epoch timestamp in milliseconds.
   * @returns {DifficultyOverrideResult}
   */
  function applyDifficultyOverrideFsrs(prevFsrs, fsrsGrade, prevStatus = '', nowMs = Date.now()) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const grade = clampFsrsGrade(fsrsGrade);
    const prevStab = Math.max(1, Number(prevFsrs?.stability) || 1);
    const scheduledDays =
      grade === 1
        ? 1
        : grade === 2
        ? Math.max(1, Math.min(3, Math.round(prevStab * 0.6) || 2))
        : grade === 3
        ? Math.max(3, Math.round(prevStab * 1.5))
        : Math.max(7, Math.round(prevStab * 2.5));

    /** @type {1 | 2 | 3} */
    const personalDifficulty = grade <= 2 ? 3 : grade === 4 ? 1 : 2;
    const status =
      grade === 1
        ? 'revisit'
        : !prevStatus || prevStatus === 'not_started' || prevStatus === 'revisit'
        ? 'done'
        : prevStatus;

    /** @type {FsrsCardState} */
    const fsrs = {
      ...(prevFsrs || {}),
      reps: Math.max(1, Number(prevFsrs?.reps || 0)),
      lastGrade: grade,
      scheduledDays,
      stability: scheduledDays,
      due: new Date(tMs + scheduledDays * MS_PER_DAY).toISOString(),
    };

    return { grade, personalDifficulty, status, scheduledDays, fsrs };
  }

  /**
   * Return true if an FSRS card has a valid `due` timestamp at or before `nowIso`.
   * @param {Partial<FsrsCardState> | null | undefined} fsrs
   * @param {string} [nowIso] - Reference ISO-8601 timestamp (defaults to now).
   * @returns {boolean}
   */
  function isFsrsDue(fsrs, nowIso = new Date().toISOString()) {
    return Boolean(fsrs && typeof fsrs.due === 'string' && fsrs.due.length > 0 && fsrs.due <= nowIso);
  }

  /**
   * Resolve effective difficulty (`1`..`3`) for a question using personal override or last FSRS grade.
   * Extracted faithfully from `app.js#effectiveDifficulty`.
   * @param {QuestionLike | null | undefined} q
   * @param {ProgressRecordLike | null | undefined} [rec]
   * @returns {number}
   */
  function effectiveDifficulty(q, rec = {}) {
    const authored = Number(q?.difficulty || 2);
    if (rec?.personalDifficulty && [1, 2, 3].includes(Number(rec.personalDifficulty))) {
      return Number(rec.personalDifficulty);
    }
    const lastG = rec?.fsrs?.lastGrade;
    if (lastG === 1 || lastG === 2) return Math.min(3, authored + 1);
    if (lastG === 4) return Math.max(1, authored - 1);
    return authored;
  }

  /**
   * Resolve effective circadian DLPFC cognitive load tier (`1`=Low, `2`=Med, `3`=High)
   * incorporating struggle escalation and FSRS mastery chunking.
   * Extracted faithfully from `app.js#effectiveDlpfc`.
   * @param {QuestionLike | null | undefined} q
   * @param {ProgressRecordLike | null | undefined} [rec]
   * @returns {EffectiveDlpfcResult}
   */
  function effectiveDlpfc(q, rec = null) {
    if (!q) return { base: 2, tier: 2, chunked: false };
    const rawBase = Number(q.dlpfcBase);
    /** @type {1 | 2 | 3} */
    const base =
      rawBase === 1 || rawBase === 2 || rawBase === 3
        ? rawBase
        : q.kind === 'mcq'
        ? Number(q.difficulty || 1) >= 3
          ? 2
          : 1
        : Number(q.difficulty || 2) >= 3 || (q.wiseflowFields || []).length >= 4
        ? 3
        : 2;

    if (!rec) return { base, tier: base, chunked: false };
    const st = rec.status || 'not_started';
    const pDiff = Number(rec.personalDifficulty || 0);
    const fsrs = rec.fsrs || {};
    const lastG = fsrs.lastGrade != null ? Number(fsrs.lastGrade) : null;
    const reps = Number(fsrs.reps || 0);
    const stab = Number(fsrs.stability || 0);

    if (pDiff === 3 || st === 'revisit' || lastG === 1) {
      const escalated = /** @type {1 | 2 | 3} */ (Math.min(3, Math.max(base, q.kind === 'mcq' ? 2 : 3)));
      return { base, tier: escalated, chunked: false };
    }
    if (st === 'done' && (lastG === null || lastG >= 3)) {
      if (pDiff === 1 || (reps >= 2 && stab >= 5.0)) {
        return { base, tier: 1, chunked: base > 1 };
      }
      if (base === 3 && reps >= 1) {
        return { base, tier: 2, chunked: true };
      }
    }
    return { base, tier: base, chunked: false };
  }

  const api = {
    MS_PER_DAY,
    FSRS_GRADES,
    clampFsrsGrade,
    computeFsrsRetrievability,
    suggestFsrsGrade,
    updateFsrs5Card,
    scheduleAttemptFsrs,
    applyDifficultyOverrideFsrs,
    isFsrsDue,
    effectiveDifficulty,
    effectiveDlpfc,
  };

  /** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore = {
    ...(/** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore || {}),
    ...api,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
