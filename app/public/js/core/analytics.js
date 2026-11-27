/* Study-OS Pure Core Module: Analytics, UPI Scoring, Streaks, Topic Mastery, Exam Aid & Chart Buckets
 * Zero runtime dependencies · Dual browser (`window.StudyCore`) & Node (`module.exports`) UMD-lite module.
 */
(function (root) {
  'use strict';

  /** @const {number} */
  const MS_PER_DAY = 86_400_000;

  /**
   * @typedef {'ready' | 'building' | 'lacking'} TopicReadinessStatus
   */

  /**
   * @typedef {Object} StudyAttemptLike
   * @property {string} [questionId]
   * @property {string} [courseId]
   * @property {string | number} [topicId]
   * @property {string} [kind]
   * @property {string} [profile]
   * @property {boolean} [autoGraded]
   * @property {number} [qualityAccuracy]
   * @property {number} [paceRatio]
   * @property {boolean} [beatAi]
   * @property {number} [activeSec]
   * @property {number} [aiParSec]
   * @property {number} [parSec]
   * @property {number} [dlpfcTier]
   * @property {string} [timestamp]
   * @property {string} [verificationTier]
   * @property {string} [source]
   * @property {number} [hintsUsed]
   * @property {boolean} [refUsed]
   * @property {number} [refSec]
   * @property {boolean} [openBookExam]
   */

  /**
   * @typedef {Object} AttemptBucketSummary
   * @property {number} count
   * @property {number | null} avgAccuracy
   * @property {number | null} beatAiRate
   * @property {number | null} avgPaceRatio
   * @property {number} totalActiveMinutes
   * @property {number} adjustedUnits
   * @property {number | null} upi
   */

  /**
   * @typedef {Object} DayActivityLike
   * @property {Array<unknown> | number} [attempts]
   * @property {number} [activeSec]
   * @property {number} [activeMin]
   */

  /**
   * @typedef {Object} CheckInSessionLike
   * @property {number} [upi]
   * @property {{ focus?: number, energy?: number, startInertia?: number }} [checkIn]
   */

  /**
   * @typedef {Object} CheckInCorrelation
   * @property {string} label
   * @property {string} summary
   */

  /**
   * @typedef {Object} VerificationTierCounts
   * @property {number} auto_graded
   * @property {number} ide_verified
   * @property {number} self_verified
   * @property {number} fast_flag
   */

  /**
   * @typedef {Object} TopicStatSpec
   * @property {string | number} id
   * @property {string} [title]
   * @property {number} [questionCount]
   * @property {number} [parMinutes]
   * @property {string[]} [questionIds]
   */

  /**
   * @typedef {Object} CatalogCourseLike
   * @property {string} courseId
   * @property {string} [code]
   * @property {string} [shortTitle]
   * @property {number} [questionCount]
   * @property {TopicStatSpec[]} [topicStats]
   * @property {Array<{ id: string | number, title?: string }>} [topics]
   */

  /**
   * @typedef {Object} TopicMasteryRow
   * @property {string} id
   * @property {number} order
   * @property {string} title
   * @property {number} workedMin
   * @property {number} recommendedMin
   * @property {number} ratioToPar
   * @property {number} doneCount
   * @property {number} totalCount
   * @property {number} revisitCount
   * @property {number} coveragePct
   * @property {number | null} avgPaceRatio
   * @property {number | null} avgAccuracy
   * @property {TopicReadinessStatus} status
   */

  /**
   * @typedef {Object} NormalizedExamAttempt
   * @property {string} sessionId
   * @property {string} completedAt
   * @property {number} pct
   * @property {number} rawPct
   * @property {string} grade
   * @property {number} earnedPts
   * @property {number} totalPts
   * @property {number} gradedCount
   * @property {number} totalCount
   * @property {boolean} complete
   * @property {number} hintsUsed
   * @property {number} hintedQCount
   * @property {number} hintPenaltyPts
   * @property {number} refQCount
   * @property {number} refSec
   * @property {number} refPenaltyPts
   * @property {boolean} openBookExam
   * @property {number} breaksCount
   * @property {number} breakSec
   * @property {number} durationSec
   * @property {'guided' | 'blind'} examStyle
   * @property {'auto' | 'rubric' | 'mixed'} gradingKind
   */

  /**
   * @typedef {Object} ExamResultEntryLike
   * @property {string} [courseId]
   * @property {number} [bestPct]
   * @property {number} [bestRawPct]
   * @property {number} [lastPct]
   * @property {number} [gradedCount]
   * @property {number} [totalCount]
   * @property {number} [attemptsCount]
   * @property {number} [completedAttempts]
   * @property {number | null} [bestHintsUsed]
   * @property {number | null} [bestRefQCount]
   * @property {number | null} [bestRefSec]
   * @property {number | null} [bestCleanPct]
   * @property {boolean} [openBookExam]
   * @property {string} [gradingKind]
   * @property {Array<Record<string, unknown>>} [attemptHistory]
   */

  /**
   * @typedef {Object} ExamAidRecallGap
   * @property {string} courseId
   * @property {string} courseCode
   * @property {string} courseShort
   * @property {string} topicId
   * @property {string} topicTitle
   * @property {boolean} openBook
   * @property {number} refCount
   * @property {number} refSec
   * @property {number} hintCount
   * @property {number} attempts
   */

  /**
   * @typedef {Object} ExamAidStats
   * @property {number} examQTotal
   * @property {number} closedBookQTotal
   * @property {number} closedBookQClean
   * @property {number | null} independencePct
   * @property {number} refQs
   * @property {number} refSec
   * @property {number} hintsTotal
   * @property {number} sitCount
   * @property {number} cleanSitCount
   * @property {ExamAidRecallGap[]} recallGaps
   */

  /**
   * @typedef {Object} EctsGradeLike
   * @property {'A' | 'B' | 'C' | 'D' | 'E' | 'F'} letter
   * @property {string} label
   * @property {string} cls
   * @property {0 | 1 | 2 | 3 | 4 | 5} points
   * @property {number} pct
   * @property {number} toA
   */

  /**
   * @typedef {Object} ExamPaperProgressResult
   * @property {number} total
   * @property {number} done
   * @property {number} revisit
   * @property {number} inProgress
   * @property {number} touched
   * @property {number} pct
   * @property {number} revisitPct
   * @property {'completed' | 'in_progress' | 'not_started'} status
   * @property {number | null} avgAccPct
   * @property {number} firstUndoneIdx
   * @property {EctsGradeLike | null} grade
   * @property {string} gradeSource
   * @property {number | null} bestPct
   * @property {number | null} bestRawPct
   * @property {number | null} lastPct
   * @property {number | null} bestHintsUsed
   * @property {number | null} bestRefQCount
   * @property {number} bestRefSec
   * @property {boolean} openBookExam
   * @property {number | null} bestCleanPct
   * @property {EctsGradeLike | null} bestCleanGrade
   * @property {number} completedAttempts
   * @property {Array<Record<string, unknown>>} attemptHistory
   * @property {ExamResultEntryLike | null} savedResult
   * @property {string} gradingMode
   * @property {string} gradingLabel
   * @property {boolean} isGradeA
   */

  /**
   * @typedef {Object} DailySeriesRowLike
   * @property {string} day
   * @property {boolean} [isToday]
   * @property {number} [activeMin]
   * @property {number} [screenMin]
   * @property {number} [offScreenMin]
   * @property {number} [highMin]
   * @property {number} [medMin]
   * @property {number} [lowMin]
   * @property {number} [attempts]
   * @property {number} [adjustedUnits]
   * @property {number | null} [avgPaceRatio]
   * @property {number | null} [upi]
   * @property {number | null} [accuracyPct]
   * @property {number | null} [efficiencyPct]
   * @property {boolean} [hasScreenLog]
   * @property {Record<string, number>} [byCourseMin]
   */

  /**
   * @typedef {Object} DayTelemetryLike
   * @property {number} [solvingSec]
   * @property {number} [readingSec]
   * @property {number} [appBrowseSec]
   * @property {number} [afkIdleSec]
   * @property {number} [awaySec]
   * @property {number} [breakSec]
   * @property {number} [extStudySec]
   * @property {number} [extDistractSec]
   * @property {number} [extOtherSec]
   * @property {Record<string, number>} [courseSec]
   */

  /**
   * @typedef {Object} ReconcileDayEfficiencyInput
   * @property {number} [activeSec]
   * @property {number} [screenSec]
   * @property {number} [sessAwaySec]
   * @property {boolean} [hasScreenLog]
   * @property {DayTelemetryLike | null} [telemetry]
   */

  /**
   * @typedef {Object} ReconcileDayEfficiencyResult
   * @property {number} telProdSec
   * @property {number} telTrackedSec
   * @property {number} driftSec
   * @property {number} reconciledProdSec
   * @property {number} reconciledScreenSec
   * @property {boolean} hasRealScreen
   * @property {number | null} efficiencyPct
   * @property {number} reconciledSolvingSec
   * @property {number} syncedSolvingSec
   */

  /**
   * @typedef {Object} OsloHeatmapCell
   * @property {string} day
   * @property {number} weekday
   * @property {number} weekIndex
   * @property {boolean} isToday
   * @property {number} activeMin
   * @property {number} attempts
   * @property {number | null} upi
   * @property {number | null} efficiencyPct
   * @property {0 | 1 | 2 | 3 | 4} level
   */

  /**
   * @typedef {Object} OsloHeatmapResult
   * @property {number} weeks
   * @property {string} startDay
   * @property {string} endDay
   * @property {OsloHeatmapCell[]} cells
   * @property {Array<Array<OsloHeatmapCell | null>>} columns
   * @property {Array<{ colIndex: number, label: string }>} monthLabels
   * @property {number} activeDays
   * @property {number} totalDays
   * @property {number} totalActiveMin
   * @property {number} totalAttempts
   * @property {number} currentStreak
   * @property {number} longestStreak
   */

  /**
   * @typedef {Object} FsrsCardLike
   * @property {string} [questionId]
   * @property {string} [courseId]
   * @property {number} [stability]
   * @property {number} [difficulty]
   * @property {number} [reps]
   * @property {number} [lapses]
   * @property {number} [lastGrade]
   * @property {number} [scheduledDays]
   * @property {string} [lastReview]
   * @property {string} [due]
   * @property {string} [updatedAt]
   * @property {FsrsCardLike} [fsrs]
   */

  /**
   * @typedef {Object} FsrsForecastBucket
   * @property {string} day
   * @property {string} label
   * @property {number} dayOffset
   * @property {boolean} isToday
   * @property {number} count
   * @property {number} overdueCount
   * @property {number} scheduledCount
   * @property {Record<string, number>} byCourse
   */

  /**
   * @typedef {Object} FsrsForecastResult
   * @property {string} todayIso
   * @property {number} days
   * @property {number} trackedCards
   * @property {number | null} avgRetrievabilityPct
   * @property {number} overdueCount
   * @property {number} atRiskCount
   * @property {number} stableCount
   * @property {number} dueNext7Days
   * @property {number} dueNext14Days
   * @property {number} laterCount
   * @property {FsrsForecastBucket | null} peakDay
   * @property {FsrsForecastBucket[]} buckets
   */

  /**
   * @typedef {Object} HourlyPerformanceBucket
   * @property {number} hour
   * @property {string} label
   * @property {string} rangeLabel
   * @property {number} attempts
   * @property {number} activeMin
   * @property {number} activeHours
   * @property {number | null} upi
   * @property {number | null} accuracyPct
   * @property {number | null} beatAiRatePct
   * @property {number | null} avgPaceRatio
   * @property {boolean} isPeak
   */

  /**
   * @typedef {Object} HourlyPerformanceResult
   * @property {string} timezone
   * @property {HourlyPerformanceBucket[]} hours
   * @property {number} totalAttempts
   * @property {number} activeHourCount
   * @property {HourlyPerformanceBucket | null} peakHour
   * @property {HourlyPerformanceBucket | null} mostActiveHour
   */

  /**
   * @typedef {Object} ChartBucket
   * @property {string} key
   * @property {string} label
   * @property {string} tooltipTitle
   * @property {boolean} isCurrent
   * @property {number} activeMin
   * @property {number} screenMin
   * @property {number} offScreenMin
   * @property {number} highMin
   * @property {number} medMin
   * @property {number} lowMin
   * @property {number} attempts
   * @property {number} adjustedUnits
   * @property {number | null} paceRatio
   * @property {number | null} upi
   * @property {number | null} accuracyPct
   * @property {number | null} efficiencyPct
   * @property {Record<string, number>} byCourseMin
   */

  /**
   * @typedef {Object} QuestionPacingLike
   * @property {string} [kind]
   * @property {number} [difficulty]
   * @property {number} [dlpfcBase]
   * @property {Array<unknown>} [wiseflowFields]
   * @property {string} [contextMarkdown]
   * @property {string} [promptMarkdown]
   * @property {string[]} [options]
   * @property {{ learning?: { target?: number }, exam?: { target?: number } }} [pacing]
   */

  /**
   * Return true if a value is a non-null plain object (not an array).
   * @param {unknown} value
   * @returns {value is Record<string, unknown>}
   */
  function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Parse an ISO timestamp string to epoch milliseconds, returning `0` on failure.
   * @param {unknown} value
   * @returns {number}
   */
  function parseTimestampMs(value) {
    return typeof value === 'string' ? Date.parse(value) || 0 : 0;
  }

  /**
   * Resolve ECTS letter grade from percentage using `StudyCore.gradeFromPct` when loaded,
   * with an identical standalone Norwegian ECTS fallback.
   * @param {unknown} pct
   * @returns {EctsGradeLike | null}
   */
  function resolveGradeFromPct(pct) {
    const core = /** @type {{ StudyCore?: { gradeFromPct?: (p: unknown) => EctsGradeLike | null } }} */ (root).StudyCore;
    if (core && typeof core.gradeFromPct === 'function') {
      return core.gradeFromPct(pct);
    }
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

  /**
   * Resolve intrinsic DLPFC tier for a question (delegates to `StudyCore.effectiveDlpfc` if loaded).
   * @param {QuestionPacingLike} q
   * @returns {1 | 2 | 3}
   */
  function resolveIntrinsicTier(q) {
    const core = /** @type {{ StudyCore?: { effectiveDlpfc?: (item: QuestionPacingLike) => { tier: 1 | 2 | 3 } } }} */ (root).StudyCore;
    if (core && typeof core.effectiveDlpfc === 'function') {
      return core.effectiveDlpfc(q).tier;
    }
    const rawBase = Number(q.dlpfcBase);
    if (rawBase === 1 || rawBase === 2 || rawBase === 3) return rawBase;
    if (q.kind === 'mcq') return Number(q.difficulty || 1) >= 3 ? 2 : 1;
    return Number(q.difficulty || 2) >= 3 || (q.wiseflowFields || []).length >= 4 ? 3 : 2;
  }

  /**
   * Compute calibrated AI-Par target duration in seconds for a question in `learning` or `exam` mode.
   * Extracted faithfully from `app.js#calibratedParSec`.
   * @param {QuestionPacingLike | null | undefined} q
   * @param {'learning' | 'exam' | string} [profile='learning']
   * @returns {number}
   */
  function calibratedParSec(q, profile = 'learning') {
    if (!q) return 90;
    const prof = profile === 'exam' ? 'exam' : 'learning';
    const rawLearnSec = Math.max(20, Math.round((Number(q.pacing?.learning?.target) || (q.kind === 'mcq' ? 2 : 6)) * 60));
    const rawExamSec = q.pacing?.exam?.target ? Math.max(20, Math.round(Number(q.pacing.exam.target) * 60)) : 0;

    if (q.kind === 'mcq') {
      const tier = resolveIntrinsicTier(q);
      const textLen =
        (q.contextMarkdown?.length || 0) +
        (q.promptMarkdown?.length || 0) +
        (Array.isArray(q.options) ? q.options.join(' ').length : 0);
      const extraCap = tier === 1 ? 25 : tier === 2 ? 35 : 45;
      const extra = Math.min(extraCap, Math.round(Math.max(0, textLen - 160) / 14));
      const baseLearn = tier === 1 ? 50 : tier === 2 ? 80 : 120;
      const maxLearn = tier === 1 ? 85 : tier === 2 ? 135 : 190;
      const learnSec = Math.min(rawLearnSec, maxLearn, baseLearn + extra);
      if (prof === 'exam') {
        const examTarget = Math.max(30, Math.round(learnSec * 0.72));
        return rawExamSec ? Math.min(rawExamSec, examTarget) : examTarget;
      }
      return learnSec;
    }

    if (prof === 'exam') {
      if (rawExamSec && rawExamSec < rawLearnSec * 0.92) return rawExamSec;
      return Math.max(45, Math.round(rawLearnSec * 0.78));
    }
    return rawLearnSec;
  }

  /**
   * Return true if an attempt was objectively auto-graded (MCQ / WISEflow / FLOWmulti).
   * Extracted faithfully from `app.js#isAutoGradedAttempt`.
   * @param {StudyAttemptLike | null | undefined} a
   * @returns {boolean}
   */
  function isAutoGradedAttempt(a) {
    if (typeof a?.autoGraded === 'boolean') return a.autoGraded;
    const k = String(a?.kind || '').toLowerCase();
    return k === 'mcq' || k === 'wiseflow' || k === 'flowmulti';
  }

  /**
   * Compute Universal Productivity Index (UPI) weighted across auto-graded (1.0×) and self-graded (0.45×) tasks,
   * DLPFC cognitive load tier, and exam vs learning pacing profile.
   * Extracted faithfully from `app.js#computeWeightedUpi`.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @param {number} [focusDensity=0.9]
   * @returns {number | null}
   */
  function computeWeightedUpi(attempts, focusDensity = 0.9) {
    if (!Array.isArray(attempts) || !attempts.length) return null;
    const rawFd = Number(focusDensity);
    const fd = Math.max(0, Math.min(1, Number.isFinite(rawFd) ? rawFd : 0.9));
    let weightedSum = 0;
    let totalW = 0;
    for (const a of attempts) {
      if (!a) continue;
      const auto = isAutoGradedAttempt(a);
      const w = auto ? 1.0 : 0.45;
      const qAcc = Math.max(0, Math.min(1, Number(a.qualityAccuracy || 0)));
      const prCap = auto ? 1.35 : 1.0;
      const pr = Math.max(0, Math.min(prCap, Number(a.paceRatio || 0)));
      const tier = Number(a.dlpfcTier || (a.kind === 'mcq' ? 1 : 2));
      const tierMult = tier === 3 ? 1.22 : tier === 1 ? 0.85 : 1.0;
      const examMult = a.profile === 'exam' ? 1.08 : 1.0;
      const score = Math.min(150, 100 * (0.45 * qAcc + 0.35 * pr + 0.2 * fd) * tierMult * examMult);
      weightedSum += w * score;
      totalW += w;
    }
    return totalW > 0 ? Math.round(weightedSum / totalW) : null;
  }

  /**
   * Resolve clamped DLPFC tier (`1`, `2`, or `3`) for a logged attempt.
   * @param {StudyAttemptLike | null | undefined} a
   * @param {Record<string, string | number> | null} [qTierLookup=null]
   * @returns {1 | 2 | 3}
   */
  function resolveAttemptTier(a, qTierLookup = null) {
    const qid = a?.questionId ? String(a.questionId) : '';
    const lookupTier = qTierLookup && qid ? qTierLookup[qid] : undefined;
    const raw = Number(a?.dlpfcTier || lookupTier || (a?.kind === 'mcq' ? 1 : 2));
    const clamped = Math.min(3, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 2));
    return /** @type {1 | 2 | 3} */ (clamped);
  }

  /**
   * Compute DLPFC- and AI-Par-adjusted output units for a single attempt.
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {StudyAttemptLike | null | undefined} a
   * @param {Record<string, string | number> | null} [qTierLookup=null]
   * @returns {number}
   */
  function computeAttemptAdjustedUnits(a, qTierLookup = null) {
    if (!a) return 0;
    const tier = resolveAttemptTier(a, qTierLookup);
    const tierW = tier === 3 ? 1.35 : tier === 1 ? 0.75 : 1.0;
    const parSec = Math.max(45, Number(a.aiParSec || a.parSec || (a.kind === 'mcq' ? 90 : 300)));
    const qAcc = Math.max(0.3, Math.min(1, Number(a.qualityAccuracy ?? 0.8)));
    return (parSec / 180) * tierW * qAcc;
  }

  /**
   * Aggregate accuracy, beat-AI-Par rate, pace ratio, active minutes, adjusted units, and UPI for a bucket of attempts.
   * Extracted faithfully from `app.js#recomputeWebAnalytics#summarizeBucket`.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @param {Record<string, string | number> | null} [qTierLookup=null]
   * @param {number} [focusDensity=0.9]
   * @returns {AttemptBucketSummary}
   */
  function summarizeAttemptBucket(attempts, qTierLookup = null, focusDensity = 0.9) {
    const arr = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
    if (!arr.length) {
      return {
        count: 0,
        avgAccuracy: null,
        beatAiRate: null,
        avgPaceRatio: null,
        totalActiveMinutes: 0,
        adjustedUnits: 0,
        upi: null,
      };
    }
    const totalSec = arr.reduce((s, a) => s + Math.max(0, Number(a.activeSec || 0)), 0);
    const pArr = arr.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
    return {
      count: arr.length,
      avgAccuracy: arr.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / arr.length,
      beatAiRate: arr.filter((a) => Boolean(a.beatAi)).length / arr.length,
      avgPaceRatio: pArr.length
        ? Math.round((pArr.reduce((s, a) => s + Number(a.paceRatio), 0) / pArr.length) * 100) / 100
        : null,
      totalActiveMinutes: Math.round(totalSec / 60),
      adjustedUnits: Math.round(arr.reduce((s, a) => s + computeAttemptAdjustedUnits(a, qTierLookup), 0) * 10) / 10,
      upi: computeWeightedUpi(arr, focusDensity),
    };
  }

  /**
   * Count consecutive active study days in `timeZone` (default `Europe/Oslo`) looking backwards from `nowMs`.
   * Today (`i === 0`) may be empty without resetting an ongoing streak from yesterday.
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {Map<string, DayActivityLike> | Record<string, DayActivityLike> | null | undefined} dayActivity
   * @param {number} [nowMs=Date.now()]
   * @param {number} [maxLookbackDays=60]
   * @param {string} [timeZone='Europe/Oslo']
   * @returns {number}
   */
  function computeOsloStreakDays(dayActivity, nowMs = Date.now(), maxLookbackDays = 60, timeZone = 'Europe/Oslo') {
    if (!dayActivity) return 0;
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const limit = Math.max(1, Math.round(Number(maxLookbackDays) || 60));
    const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone });
    const getRow = (/** @type {string} */ key) =>
      dayActivity instanceof Map ? dayActivity.get(key) : dayActivity[key];

    let streakDays = 0;
    for (let i = 0; i < limit; i++) {
      const dk = dayFormat.format(new Date(tMs - i * MS_PER_DAY));
      const dr = getRow(dk);
      const attemptCount = Array.isArray(dr?.attempts)
        ? dr.attempts.length
        : Math.max(0, Number(dr?.attempts || 0));
      const activeSec = Number(dr?.activeSec ?? (Number(dr?.activeMin || 0) * 60));
      if (dr && (attemptCount > 0 || activeSec >= 180)) {
        streakDays++;
      } else if (i > 0) {
        break;
      }
    }
    return streakDays;
  }

  /**
   * Compute subjective check-in (`focus`, `energy`, `startInertia`) ↔ objective Session UPI impact summaries.
   * Requires at least 3 checked-in sessions with finite UPI and both high (>=4) and low (1..2) samples.
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {CheckInSessionLike[] | null | undefined} sessions
   * @returns {CheckInCorrelation[]}
   */
  function computeCheckInCorrelations(sessions) {
    const checkedSessions = (Array.isArray(sessions) ? sessions : []).filter(
      (s) => Boolean(s?.checkIn) && Number.isFinite(Number(s?.upi))
    );
    /** @type {CheckInCorrelation[]} */
    const correlations = [];
    if (checkedSessions.length < 3) return correlations;

    /** @type {Array<['focus' | 'energy' | 'startInertia', string]>} */
    const pairs = [
      ['focus', 'Focus Rating ↔ Session UPI'],
      ['energy', 'Energy Level ↔ Session UPI'],
      ['startInertia', 'Start Inertia ↔ Session UPI'],
    ];
    for (const [field, label] of pairs) {
      const hi = checkedSessions.filter((s) => Number(s.checkIn?.[field] || 0) >= 4);
      const lo = checkedSessions.filter((s) => {
        const val = Number(s.checkIn?.[field] || 0);
        return val > 0 && val <= 2;
      });
      if (hi.length && lo.length) {
        const avgHi = Math.round(hi.reduce((sum, s) => sum + Number(s.upi), 0) / hi.length);
        const avgLo = Math.round(lo.reduce((sum, s) => sum + Number(s.upi), 0) / lo.length);
        const diff = avgHi - avgLo;
        correlations.push({
          label,
          summary: `High (${avgHi} UPI) vs Low (${avgLo} UPI) → ${diff >= 0 ? '+' : ''}${diff} UPI impact across ${hi.length + lo.length} sessions.`,
        });
      }
    }
    return correlations;
  }

  /**
   * Tally verification integrity tiers (`auto_graded`, `ide_verified`, `self_verified`, `fast_flag`).
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @returns {VerificationTierCounts}
   */
  function classifyVerificationTiers(attempts) {
    /** @type {Record<string, number>} */
    const counts = { auto_graded: 0, ide_verified: 0, self_verified: 0, fast_flag: 0 };
    for (const a of Array.isArray(attempts) ? attempts : []) {
      if (!a) continue;
      const vt =
        a.verificationTier ||
        (isAutoGradedAttempt(a)
          ? 'auto_graded'
          : a.source === 'ide_companion'
          ? 'ide_verified'
          : Number(a.activeSec || 0) > 0 &&
            Number(a.aiParSec || 0) >= 120 &&
            Number(a.activeSec) < Number(a.aiParSec) * 0.12
          ? 'fast_flag'
          : 'self_verified');
      counts[vt] = (counts[vt] || 0) + 1;
    }
    return {
      auto_graded: counts.auto_graded || 0,
      ide_verified: counts.ide_verified || 0,
      self_verified: counts.self_verified || 0,
      fast_flag: counts.fast_flag || 0,
    };
  }

  /**
   * Classify a topic's exam-readiness status from its ratio to AI-Par hours, completion %, accuracy, and revisits.
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {number} ratioToPar
   * @param {number} coveragePct
   * @param {number | null} avgAccuracy
   * @param {number} revisitCount
   * @returns {TopicReadinessStatus}
   */
  function classifyTopicReadiness(ratioToPar, coveragePct, avgAccuracy, revisitCount) {
    if (
      (ratioToPar >= 0.72 || coveragePct >= 75) &&
      (avgAccuracy == null || avgAccuracy >= 0.72) &&
      revisitCount <= 1
    ) {
      return 'ready';
    }
    if (ratioToPar >= 0.3 || coveragePct >= 30) {
      return 'building';
    }
    return 'lacking';
  }

  /**
   * Build the per-course topic mastery matrix comparing worked minutes against recommended AI-Par targets.
   * Extracted faithfully from `app.js#recomputeWebAnalytics`.
   * @param {CatalogCourseLike[] | null | undefined} catalog
   * @param {Record<string, { status?: string }> | null | undefined} records
   * @param {Record<string, number> | null | undefined} topicAttemptSec
   * @param {Record<string, StudyAttemptLike[]> | null | undefined} topicAttempts
   * @returns {Record<string, TopicMasteryRow[]>}
   */
  function buildTopicMasteryMatrix(catalog, records, topicAttemptSec, topicAttempts) {
    /** @type {Record<string, TopicMasteryRow[]>} */
    const topicMatrix = {};
    const recMap = records || {};
    const secMap = topicAttemptSec || {};
    const attMap = topicAttempts || {};

    for (const c of Array.isArray(catalog) ? catalog : []) {
      if (!c?.courseId) continue;
      const statsList =
        Array.isArray(c.topicStats) && c.topicStats.length
          ? c.topicStats
          : (c.topics || []).map((t) => ({
              id: String(t.id),
              title: t.title || `Topic ${t.id}`,
              questionCount: Math.max(1, Math.round((c.questionCount || 10) / Math.max(1, (c.topics || []).length))),
              parMinutes: Math.max(20, Math.round(((c.questionCount || 10) * 3.5) / Math.max(1, (c.topics || []).length))),
              questionIds: /** @type {string[]} */ ([]),
            }));

      topicMatrix[c.courseId] = statsList.map((ts, orderIdx) => {
        const tid = String(ts.id);
        const tk = `${c.courseId}::${tid}`;
        const qIds = Array.isArray(ts.questionIds) ? ts.questionIds : [];
        const tAtts = attMap[tk] || [];
        let doneCount = 0;
        let revisitCount = 0;
        let recordCreditMin = 0;
        const tsQCount = Number(ts.questionCount || 0);
        const avgQParMin = tsQCount > 0 ? (Number(ts.parMinutes) || 20) / tsQCount : 3;
        const attemptedQids = new Set(tAtts.map((a) => a.questionId));

        for (const qid of qIds) {
          const rec = recMap[qid];
          if (!rec) continue;
          if (rec.status === 'done') {
            doneCount++;
            if (!attemptedQids.has(qid)) recordCreditMin += avgQParMin * 0.85;
          } else if (rec.status === 'revisit') {
            revisitCount++;
          }
        }

        const workedMin = Math.round(((secMap[tk] || 0) / 60 + recordCreditMin) * 10) / 10;
        const recommendedMin = Math.max(15, Math.round(Number(ts.parMinutes) || 20));
        const ratioToPar = recommendedMin > 0 ? workedMin / recommendedMin : 0;
        const totalCount = Math.max(1, tsQCount || qIds.length || 1);
        const coveragePct = Math.min(100, Math.round((doneCount / totalCount) * 100));
        const tPaceArr = tAtts.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
        const avgTopicPace = tPaceArr.length
          ? Math.round((tPaceArr.reduce((s, a) => s + Number(a.paceRatio), 0) / tPaceArr.length) * 100) / 100
          : null;
        const avgTopicAcc = tAtts.length
          ? tAtts.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / tAtts.length
          : null;
        const status = classifyTopicReadiness(ratioToPar, coveragePct, avgTopicAcc, revisitCount);

        return {
          id: tid,
          order: orderIdx,
          title: ts.title || `Topic ${tid}`,
          workedMin,
          recommendedMin,
          ratioToPar,
          doneCount,
          totalCount,
          revisitCount,
          coveragePct,
          avgPaceRatio: avgTopicPace,
          avgAccuracy: avgTopicAcc,
          status,
        };
      });
    }
    return topicMatrix;
  }

  /**
   * Normalize, deduplicate, and sort up to 15 historical exam attempts newest-first.
   * Extracted faithfully from `app.js#normalizeAttemptHistoryList`.
   * @param {unknown} list
   * @returns {NormalizedExamAttempt[]}
   */
  function normalizeAttemptHistoryList(list) {
    if (!Array.isArray(list)) return [];
    /** @type {Map<string, NormalizedExamAttempt>} */
    const byKey = new Map();
    for (const item of list) {
      if (!isPlainRecord(item) || !Number.isFinite(Number(item.pct))) continue;
      const pct = Math.max(0, Math.min(100, Math.round(Number(item.pct) * 10) / 10));
      const rawPct = Number.isFinite(Number(item.rawPct))
        ? Math.max(0, Math.min(100, Math.round(Number(item.rawPct) * 10) / 10))
        : pct;
      const completedAt =
        typeof item.completedAt === 'string' && parseTimestampMs(item.completedAt)
          ? new Date(item.completedAt).toISOString()
          : '';
      const sid =
        typeof item.sessionId === 'string' && item.sessionId.trim()
          ? item.sessionId.trim().slice(0, 64)
          : completedAt || `at-${byKey.size}`;
      const rawGradingKind = String(item.gradingKind || '');
      /** @type {'auto' | 'rubric' | 'mixed'} */
      const gradingKind =
        rawGradingKind === 'auto' || rawGradingKind === 'rubric' || rawGradingKind === 'mixed'
          ? rawGradingKind
          : 'mixed';
      /** @type {NormalizedExamAttempt} */
      const clean = {
        sessionId: sid,
        completedAt,
        pct,
        rawPct,
        grade: resolveGradeFromPct(pct)?.letter || 'F',
        earnedPts: Math.max(0, Math.round(Number(item.earnedPts || 0) * 10) / 10),
        totalPts: Math.max(0, Math.round(Number(item.totalPts || 0) * 10) / 10),
        gradedCount: Math.max(0, Math.round(Number(item.gradedCount || 0))),
        totalCount: Math.max(0, Math.round(Number(item.totalCount || 0))),
        complete: Boolean(item.complete),
        hintsUsed: Math.max(0, Math.round(Number(item.hintsUsed || 0))),
        hintedQCount: Math.max(0, Math.round(Number(item.hintedQCount || 0))),
        hintPenaltyPts: Math.max(0, Math.round(Number(item.hintPenaltyPts || 0) * 10) / 10),
        refQCount: Math.max(0, Math.round(Number(item.refQCount || 0))),
        refSec: Math.max(0, Math.round(Number(item.refSec || 0))),
        refPenaltyPts: Math.max(0, Math.round(Number(item.refPenaltyPts || 0) * 10) / 10),
        openBookExam: Boolean(item.openBookExam),
        breaksCount: Math.max(0, Math.round(Number(item.breaksCount || 0))),
        breakSec: Math.max(0, Math.round(Number(item.breakSec || 0))),
        durationSec: Math.max(0, Math.round(Number(item.durationSec || 0))),
        examStyle: item.examStyle === 'guided' ? 'guided' : 'blind',
        gradingKind,
      };
      const prev = byKey.get(sid);
      if (!prev || parseTimestampMs(clean.completedAt) >= parseTimestampMs(prev.completedAt)) {
        byKey.set(sid, clean);
      }
    }
    return [...byKey.values()]
      .sort((a, b) => parseTimestampMs(b.completedAt) - parseTimestampMs(a.completedAt))
      .slice(0, 15);
  }

  /**
   * Compare two exam attempts: higher percentage wins (> 0.04pt margin), with fewer aid units breaking ties.
   * Extracted faithfully from `app.js#isBetterExamAttempt`.
   * @param {number} candPct
   * @param {number | null | undefined} candAids
   * @param {number} prevPct
   * @param {number | null | undefined} prevAids
   * @returns {boolean}
   */
  function isBetterExamAttempt(candPct, candAids, prevPct, prevAids) {
    if (!Number.isFinite(prevPct) || prevPct < 0) return true;
    if (candPct > prevPct + 0.04) return true;
    if (Math.abs(candPct - prevPct) <= 0.04) {
      const ch = candAids != null && Number.isFinite(Number(candAids)) ? Number(candAids) : 9999;
      const ph = prevAids != null && Number.isFinite(Number(prevAids)) ? Number(prevAids) : 9999;
      return ch <= ph;
    }
    return false;
  }

  /**
   * Sum exam aid units (hints plus closed-book reference lookups). Open-book reference lookups count as 0.
   * Extracted faithfully from `app.js#countExamAidUnits`.
   * @param {number | null | undefined} hints
   * @param {number | null | undefined} refQs
   * @param {boolean} [openBook=false]
   * @returns {number | null}
   */
  function countExamAidUnits(hints, refQs, openBook = false) {
    if (hints == null && refQs == null) return null;
    return Math.max(0, Number(hints || 0)) + (openBook ? 0 : Math.max(0, Number(refQs || 0)));
  }

  /**
   * Infer total completed exam sits from an exam result record and its attempt history.
   * Extracted faithfully from `app.js#inferCompletedAttempts`.
   * @param {unknown} entry
   * @returns {number}
   */
  function inferCompletedAttempts(entry) {
    if (!isPlainRecord(entry)) return 0;
    const explicit = Number(entry.completedAttempts);
    const histComplete = Array.isArray(entry.attemptHistory)
      ? entry.attemptHistory.filter((x) => isPlainRecord(x) && Boolean(x.complete)).length
      : 0;
    if (entry.completedAttempts !== undefined && entry.completedAttempts !== null && Number.isFinite(explicit) && explicit >= 0) {
      return Math.max(Math.round(explicit), histComplete);
    }
    const g = Number(entry.gradedCount || 0);
    const t = Number(entry.totalCount || 0);
    const legacyCount = t > 0 && g >= t ? Math.max(1, Math.round(Number(entry.attemptsCount || 1))) : 0;
    return Math.max(legacyCount, histComplete);
  }

  /**
   * Compute full progress, grade status, and aid metadata for a single exam paper collection.
   * Extracted faithfully from `app.js#computeExamPaperProgress`.
   * @param {string[] | null | undefined} qIds
   * @param {Record<string, { status?: string }> | null | undefined} records
   * @param {Map<string, number> | Record<string, number> | null | undefined} attemptsByQid
   * @param {ExamResultEntryLike | null} [savedResult=null]
   * @param {{ gradingMode?: string } | null} [col=null]
   * @returns {ExamPaperProgressResult}
   */
  function computeExamPaperProgress(qIds, records, attemptsByQid, savedResult = null, col = null) {
    const ids = Array.isArray(qIds) ? qIds : [];
    const recMap = records || {};
    const getAcc = (/** @type {string} */ qid) => {
      if (!attemptsByQid) return undefined;
      return attemptsByQid instanceof Map ? attemptsByQid.get(qid) : attemptsByQid[qid];
    };

    const total = ids.length;
    let done = 0;
    let revisit = 0;
    let inProgress = 0;
    let firstUndoneIdx = 0;
    let foundUndone = false;
    let accSum = 0;
    let accCount = 0;

    ids.forEach((qid, idx) => {
      const rec = recMap[qid];
      const st = rec?.status || 'not_started';
      if (st === 'done') {
        done++;
      } else {
        if (!foundUndone) {
          firstUndoneIdx = idx;
          foundUndone = true;
        }
        if (st === 'revisit') revisit++;
        else if (st === 'in_progress') inProgress++;
      }
      const latestAcc = getAcc(qid);
      if (latestAcc !== undefined && latestAcc !== null && Number.isFinite(Number(latestAcc))) {
        accSum += Number(latestAcc);
        accCount++;
      }
    });

    const touched = done + revisit + inProgress;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const revisitPct = total > 0 ? Math.min(100 - pct, Math.round((revisit / total) * 100)) : 0;
    const hasSavedSit = Boolean(
      savedResult &&
        (savedResult.bestPct != null || savedResult.lastPct != null) &&
        Number.isFinite(Number(savedResult.bestPct ?? savedResult.lastPct))
    );
    /** @type {'completed' | 'in_progress' | 'not_started'} */
    const status =
      (total > 0 && done >= total) || (hasSavedSit && Number(savedResult?.gradedCount || 0) >= Math.max(1, total))
        ? 'completed'
        : touched > 0 || hasSavedSit
        ? 'in_progress'
        : 'not_started';
    const avgAccPct = accCount > 0 ? Math.round((accSum / accCount) * 100) : null;

    const completedAttempts = savedResult ? inferCompletedAttempts(savedResult) : status === 'completed' ? 1 : 0;
    const hasCompletedSit = Boolean(hasSavedSit && (completedAttempts > 0 || status === 'completed'));

    /** @type {EctsGradeLike | null} */
    let grade = null;
    let gradeSource = '';
    /** @type {number | null} */
    let bestPct = null;
    /** @type {number | null} */
    let lastPct = null;

    if (hasSavedSit && savedResult) {
      bestPct = Math.round(Number(savedResult.bestPct ?? savedResult.lastPct));
      lastPct = Math.round(Number(savedResult.lastPct ?? bestPct));
      grade = resolveGradeFromPct(bestPct);
      gradeSource = hasCompletedSit ? 'official' : 'estimate';
    } else if (avgAccPct != null && total > 0) {
      const fullCoverage = accCount >= total || status === 'completed';
      bestPct = avgAccPct;
      lastPct = avgAccPct;
      grade = resolveGradeFromPct(avgAccPct);
      gradeSource = fullCoverage ? 'derived' : 'estimate';
    }

    const gradingMode = savedResult?.gradingKind || col?.gradingMode || '';
    const gradingLabel =
      gradingMode === 'auto'
        ? 'Auto-graded'
        : gradingMode === 'rubric'
        ? 'Rubric-graded'
        : gradingMode === 'mixed'
        ? 'Auto + Rubric'
        : '';
    const bestHintsUsed =
      savedResult && savedResult.bestHintsUsed != null && Number.isFinite(Number(savedResult.bestHintsUsed))
        ? Math.max(0, Math.round(Number(savedResult.bestHintsUsed)))
        : null;
    const bestRefQCount =
      savedResult && savedResult.bestRefQCount != null && Number.isFinite(Number(savedResult.bestRefQCount))
        ? Math.max(0, Math.round(Number(savedResult.bestRefQCount)))
        : null;
    const bestRefSec =
      savedResult && savedResult.bestRefSec != null && Number.isFinite(Number(savedResult.bestRefSec))
        ? Math.max(0, Math.round(Number(savedResult.bestRefSec)))
        : 0;
    const openBookExam = Boolean(savedResult?.openBookExam);
    const bestRawPct =
      savedResult && savedResult.bestRawPct != null && Number.isFinite(Number(savedResult.bestRawPct))
        ? Math.round(Number(savedResult.bestRawPct))
        : bestPct;
    const bestCleanPct =
      savedResult && savedResult.bestCleanPct != null && Number.isFinite(Number(savedResult.bestCleanPct))
        ? Math.round(Number(savedResult.bestCleanPct))
        : null;
    const bestCleanGrade = bestCleanPct != null ? resolveGradeFromPct(bestCleanPct) : null;
    const attemptHistory = Array.isArray(savedResult?.attemptHistory) ? savedResult.attemptHistory : [];

    return {
      total,
      done,
      revisit,
      inProgress,
      touched,
      pct: status === 'completed' ? 100 : pct,
      revisitPct: status === 'completed' ? 0 : revisitPct,
      status,
      avgAccPct,
      firstUndoneIdx,
      grade,
      gradeSource,
      bestPct,
      bestRawPct,
      lastPct,
      bestHintsUsed,
      bestRefQCount,
      bestRefSec,
      openBookExam,
      bestCleanPct,
      bestCleanGrade,
      completedAttempts,
      attemptHistory,
      savedResult,
      gradingMode,
      gradingLabel,
      isGradeA: Boolean(grade && gradeSource !== 'estimate' && grade.letter === 'A'),
    };
  }

  /**
   * Compute closed-book independence %, exam reference usage, hint counts, clean sits, and top recall gaps.
   * Extracted faithfully from `app.js#computeExamAidStats`.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @param {Record<string, ExamResultEntryLike> | null | undefined} examResults
   * @param {CatalogCourseLike[] | null | undefined} catalog
   * @returns {ExamAidStats}
   */
  function computeExamAidStats(attempts, examResults, catalog) {
    const courseList = Array.isArray(catalog) ? catalog : [];
    const courseById = new Map(courseList.map((c) => [c.courseId, c]));
    /** @type {Map<string, string>} */
    const topicTitleMap = new Map();
    for (const c of courseList) {
      for (const t of c.topics || []) {
        topicTitleMap.set(`${c.courseId}:${t.id}`, t.title || `Topic ${t.id}`);
      }
    }

    let examQTotal = 0;
    let examQClean = 0;
    let closedBookQTotal = 0;
    let closedBookQClean = 0;
    let examRefQs = 0;
    let examRefSec = 0;
    let examHints = 0;
    /** @type {Map<string, ExamAidRecallGap>} */
    const byTopic = new Map();

    for (const a of Array.isArray(attempts) ? attempts : []) {
      if (!a || a.profile !== 'exam') continue;
      const openBook = Boolean(a.openBookExam || a.courseId === 'prog-3021');
      const h = Math.max(0, Number(a.hintsUsed || 0));
      const rUsed = Boolean(a.refUsed);
      const rSec = Math.max(0, Number(a.refSec || 0));
      examQTotal += 1;
      examHints += h;
      if (rUsed) examRefQs += 1;
      examRefSec += rSec;
      const isCleanQ = h === 0 && (openBook || !rUsed);
      if (isCleanQ) examQClean += 1;
      if (!openBook) {
        closedBookQTotal += 1;
        if (h === 0 && !rUsed) closedBookQClean += 1;
      }
      if (h > 0 || rUsed) {
        const cid = a.courseId || '';
        const tk = `${cid}:${a.topicId ?? ''}`;
        const cur = byTopic.get(tk) || {
          courseId: cid,
          courseCode: courseById.get(cid)?.code || cid,
          courseShort: courseById.get(cid)?.shortTitle || '',
          topicId: String(a.topicId ?? ''),
          topicTitle: topicTitleMap.get(tk) || `Topic ${a.topicId || '?'}`,
          openBook,
          refCount: 0,
          refSec: 0,
          hintCount: 0,
          attempts: 0,
        };
        if (rUsed) cur.refCount += 1;
        cur.refSec += rSec;
        cur.hintCount += h;
        cur.attempts += 1;
        byTopic.set(tk, cur);
      }
    }

    let sitCount = 0;
    let cleanSitCount = 0;
    let sitRefQs = 0;
    let sitRefSec = 0;
    let sitHints = 0;
    for (const entry of Object.values(examResults || {})) {
      if (!isPlainRecord(entry)) continue;
      const hist = normalizeAttemptHistoryList(entry.attemptHistory || []);
      if (hist.length) {
        for (const h of hist) {
          sitCount += 1;
          const ob = Boolean(h.openBookExam || entry.openBookExam || entry.courseId === 'prog-3021');
          if (h.hintsUsed === 0 && (ob || (h.refQCount || 0) === 0)) cleanSitCount += 1;
          sitRefQs += Number(h.refQCount || 0);
          sitRefSec += Number(h.refSec || 0);
          sitHints += Number(h.hintsUsed || 0);
        }
      } else if (entry.bestHintsUsed != null || entry.bestRefQCount != null) {
        sitCount += 1;
        const ob = Boolean(entry.openBookExam || entry.courseId === 'prog-3021');
        if ((Number(entry.bestHintsUsed) || 0) === 0 && (ob || (Number(entry.bestRefQCount) || 0) === 0)) {
          cleanSitCount += 1;
        }
        sitRefQs += Number(entry.bestRefQCount || 0);
        sitRefSec += Number(entry.bestRefSec || 0);
        sitHints += Number(entry.bestHintsUsed || 0);
      }
    }

    const recallGaps = [...byTopic.values()]
      .sort((a, b) => b.refCount * 2 + b.hintCount - (a.refCount * 2 + a.hintCount) || b.refSec - a.refSec)
      .slice(0, 6);

    const independencePct =
      closedBookQTotal > 0
        ? Math.round((closedBookQClean / closedBookQTotal) * 100)
        : examQTotal > 0
        ? Math.round((examQClean / examQTotal) * 100)
        : sitCount > 0
        ? Math.round((cleanSitCount / sitCount) * 100)
        : null;

    return {
      examQTotal,
      closedBookQTotal,
      closedBookQClean,
      independencePct,
      refQs: Math.max(examRefQs, sitRefQs),
      refSec: Math.round(Math.max(examRefSec, sitRefSec)),
      hintsTotal: Math.max(examHints, sitHints),
      sitCount,
      cleanSitCount,
      recallGaps,
    };
  }

  /**
   * Format an ISO day string (`YYYY-MM-DD`) concisely (e.g. `1 May`).
   * @param {string} isoDay
   * @returns {string}
   */
  function formatIsoDayShort(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return String(isoDay || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  /**
   * Format an ISO day string (`YYYY-MM-DD`) in uppercase tooltip form (e.g. `FRI, 1 MAY 2026`).
   * @param {string} isoDay
   * @returns {string}
   */
  function formatIsoDayFull(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return String(isoDay || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d
      .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      .toUpperCase();
  }

  /**
   * Return the Monday-anchored ISO week key (`YYYY-MM-DD`) for any `YYYY-MM-DD` date.
   * Extracted faithfully from `metrics-charts.js#isoWeekKey`.
   * @param {string} isoDay
   * @returns {string}
   */
  function isoWeekKey(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return String(isoDay || '');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Aggregate a daily Oslo time-series into `daily`, `weekly`, or `monthly` chart buckets.
   * Extracted faithfully from `metrics-charts.js#aggregateBuckets`.
   * @param {DailySeriesRowLike[] | null | undefined} dailySeries
   * @param {'daily' | 'weekly' | 'monthly' | string} [granularity='daily']
   * @param {number} [rangeDays=14]
   * @returns {ChartBucket[]}
   */
  function aggregateDailyBuckets(dailySeries, granularity = 'daily', rangeDays = 14) {
    const sorted = [...(Array.isArray(dailySeries) ? dailySeries : [])]
      .filter((d) => Boolean(d && typeof d.day === 'string'))
      .sort((a, b) => a.day.localeCompare(b.day));
    if (!sorted.length) return [];

    if (granularity === 'daily') {
      const range = Math.max(1, Math.round(Number(rangeDays) || 14));
      const slice = range >= 90 ? sorted.slice(-60) : sorted.slice(-range);
      return slice.map((d) => ({
        key: d.day,
        label: formatIsoDayShort(d.day),
        tooltipTitle: d.isToday ? `${formatIsoDayFull(d.day)} · TODAY` : formatIsoDayFull(d.day),
        isCurrent: Boolean(d.isToday),
        activeMin: d.activeMin || 0,
        screenMin: d.screenMin || 0,
        offScreenMin: d.offScreenMin || 0,
        highMin: d.highMin || 0,
        medMin: d.medMin || 0,
        lowMin: d.lowMin || 0,
        attempts: d.attempts || 0,
        adjustedUnits: d.adjustedUnits || 0,
        paceRatio: d.avgPaceRatio ?? null,
        upi: d.upi ?? null,
        accuracyPct: d.accuracyPct ?? null,
        efficiencyPct: d.efficiencyPct ?? null,
        byCourseMin: d.byCourseMin || {},
      }));
    }

    /** @type {Map<string, {
     *   key: string, isCurrent: boolean, activeMin: number, screenMin: number, offScreenMin: number,
     *   highMin: number, medMin: number, lowMin: number, attempts: number, adjustedUnits: number,
     *   paceSum: number, paceCount: number, upiSum: number, upiCount: number, accSum: number, accCount: number,
     *   byCourseMin: Record<string, number>
     * }>} */
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
      const dayAttempts = d.attempts || 0;
      g.activeMin += d.activeMin || 0;
      g.screenMin += d.screenMin || 0;
      g.offScreenMin += d.offScreenMin || 0;
      g.highMin += d.highMin || 0;
      g.medMin += d.medMin || 0;
      g.lowMin += d.lowMin || 0;
      g.attempts += dayAttempts;
      g.adjustedUnits += d.adjustedUnits || 0;
      if (d.avgPaceRatio != null && dayAttempts > 0) {
        g.paceSum += d.avgPaceRatio * dayAttempts;
        g.paceCount += dayAttempts;
      }
      if (d.upi != null && dayAttempts > 0) {
        g.upiSum += d.upi * dayAttempts;
        g.upiCount += dayAttempts;
      }
      if (d.accuracyPct != null && dayAttempts > 0) {
        g.accSum += d.accuracyPct * dayAttempts;
        g.accCount += dayAttempts;
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
        const label =
          granularity === 'monthly'
            ? new Date(`${g.key}-01T00:00:00Z`).toLocaleDateString('en-GB', {
                month: 'short',
                year: '2-digit',
                timeZone: 'UTC',
              })
            : `Wk ${formatIsoDayShort(g.key)}`;
        const tooltipTitle =
          granularity === 'monthly'
            ? `${label.toUpperCase()}${g.isCurrent ? ' · CURRENT' : ''}`
            : `WEEK OF ${formatIsoDayShort(g.key).toUpperCase()}${g.isCurrent ? ' · THIS WEEK' : ''}`;
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

  /**
   * Compute a clean chart axis upper bound rounded to `[1.2, 2, 3, 5, 7.5, 10] × 10^k`.
   * Extracted faithfully from `metrics-charts.js#niceMax`.
   * @param {number} rawMax
   * @param {number} [minFloor=1]
   * @returns {number}
   */
  function computeNiceAxisMax(rawMax, minFloor = 1) {
    const floor = Math.max(1e-6, Number(minFloor) || 1);
    const v = Math.max(floor, Number(rawMax) || 0);
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / pow;
    const step = norm <= 1.2 ? 1.2 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : norm <= 7.5 ? 7.5 : 10;
    return step * pow;
  }

  /**
   * Sort topic mastery rows by `'lacking'` (urgent gaps first), `'worked'` (most studied first), or `'syllabus'` order.
   * Extracted faithfully from `metrics-charts.js#renderTopicMatrix`.
   * @param {TopicMasteryRow[] | null | undefined} topics
   * @param {'lacking' | 'worked' | 'syllabus' | string} [sortMode='lacking']
   * @returns {TopicMasteryRow[]}
   */
  function sortTopicMatrixRows(topics, sortMode = 'lacking') {
    const list = [...(Array.isArray(topics) ? topics : [])];
    return list.sort((a, b) => {
      if (sortMode === 'worked') return b.workedMin - a.workedMin || b.coveragePct - a.coveragePct;
      if (sortMode === 'lacking') {
        const score = (/** @type {TopicMasteryRow} */ t) =>
          (t.revisitCount > 0 ? -20 : 0) +
          t.ratioToPar * 100 +
          (t.doneCount / Math.max(1, t.totalCount)) * 40;
        return score(a) - score(b);
      }
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }

  /**
   * Reconcile verified active study time with browser 5m telemetry buckets and screen logs.
   * Ensures synced/logged attempt solving time is never ignored when a browser tab only logged
   * browse/AFK drift, while never fabricating efficiency on past days without real screen logs.
   * @param {ReconcileDayEfficiencyInput | null | undefined} input
   * @returns {ReconcileDayEfficiencyResult}
   */
  function reconcileDayEfficiency(input) {
    const safeActiveSec = Math.max(0, Number(input?.activeSec) || 0);
    const safeScreenSec = Math.max(0, Number(input?.screenSec) || 0);
    const safeSessAwaySec = Math.max(0, Number(input?.sessAwaySec) || 0);
    const td = isPlainRecord(input?.telemetry) ? /** @type {DayTelemetryLike} */ (input.telemetry) : null;

    const solvingSec = Math.max(0, Number(td?.solvingSec) || 0);
    const readingSec = Math.max(0, Number(td?.readingSec) || 0);
    const extStudySec = Math.max(0, Number(td?.extStudySec) || 0);
    const appBrowseSec = Math.max(0, Number(td?.appBrowseSec) || 0);
    const afkIdleSec = Math.max(0, Number(td?.afkIdleSec) || 0);
    const extDistractSec = Math.max(0, Number(td?.extDistractSec) || 0);

    const telProdSec = solvingSec + readingSec + extStudySec;
    const driftSec = appBrowseSec + afkIdleSec + extDistractSec;
    const telTrackedSec = telProdSec + driftSec;

    const reconciledProdSec = Math.max(telProdSec, safeActiveSec);
    const hasExplicitFlag = typeof input?.hasScreenLog === 'boolean';
    const hasRealScreen = Boolean(
      (hasExplicitFlag ? input?.hasScreenLog : safeScreenSec >= 60) ||
        safeSessAwaySec > 0 ||
        telTrackedSec >= 60
    );

    const awayFallbackSec = safeScreenSec === 0 && telTrackedSec === 0 ? safeSessAwaySec : 0;
    const reconciledScreenSec = hasRealScreen
      ? Math.max(safeScreenSec, telTrackedSec, reconciledProdSec + driftSec + awayFallbackSec)
      : reconciledProdSec;

    const efficiencyPct =
      hasRealScreen && reconciledScreenSec >= 30
        ? Math.min(100, Math.round((reconciledProdSec / reconciledScreenSec) * 100))
        : null;

    const reconciledSolvingSec = Math.max(
      solvingSec,
      Math.max(0, reconciledProdSec - readingSec - extStudySec)
    );
    const syncedSolvingSec = Math.max(0, reconciledSolvingSec - solvingSec);

    return {
      telProdSec,
      telTrackedSec,
      driftSec,
      reconciledProdSec,
      reconciledScreenSec,
      hasRealScreen,
      efficiencyPct,
      reconciledSolvingSec,
      syncedSolvingSec,
    };
  }

  /**
   * Parse an ISO `YYYY-MM-DD` string to UTC midnight epoch ms, or return null if invalid.
   * @param {unknown} isoDay
   * @returns {number | null}
   */
  function parseIsoDayUtcMs(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const ms = Date.UTC(y, mo - 1, d);
    const check = new Date(ms);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
      return null;
    }
    return ms;
  }

  /**
   * Format a UTC midnight epoch timestamp as `YYYY-MM-DD`.
   * @param {number} utcMs
   * @returns {string}
   */
  function formatUtcMsAsIsoDay(utcMs) {
    return new Date(utcMs).toISOString().slice(0, 10);
  }

  /**
   * Build a GitHub-style `weeks * 7`-day Oslo consistency heatmap with Monday-anchored columns,
   * WCAG-friendly intensity levels (`0..4`), current streak, longest streak, and month markers.
   * @param {DailySeriesRowLike[] | null | undefined} dailySeries
   * @param {string} [todayIso]
   * @param {number} [weeks=12]
   * @returns {OsloHeatmapResult}
   */
  function buildOsloHeatmap(dailySeries, todayIso, weeks = 12) {
    const safeWeeks = Math.max(1, Math.min(52, Math.round(Number(weeks) || 12)));
    const totalDays = safeWeeks * 7;
    const fallbackToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' }).format(new Date());
    const parsedEnd = parseIsoDayUtcMs(todayIso);
    const endUtcMs = parsedEnd !== null ? parsedEnd : (parseIsoDayUtcMs(fallbackToday) || Date.UTC(2026, 0, 1));
    const endDay = formatUtcMsAsIsoDay(endUtcMs);

    /** @type {Map<string, DailySeriesRowLike>} */
    const byDay = new Map();
    for (const row of Array.isArray(dailySeries) ? dailySeries : []) {
      if (row && typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day)) {
        byDay.set(row.day, row);
      }
    }

    /** @type {OsloHeatmapCell[]} */
    const cells = [];
    let activeDays = 0;
    let totalActiveMin = 0;
    let totalAttempts = 0;

    const startUtcMs = endUtcMs - (totalDays - 1) * MS_PER_DAY;
    const startDow = (new Date(startUtcMs).getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const colCount = Math.floor((startDow + totalDays - 1) / 7) + 1;
    /** @type {Array<Array<OsloHeatmapCell | null>>} */
    const columns = Array.from({ length: colCount }, () => Array.from({ length: 7 }, () => null));

    for (let i = 0; i < totalDays; i++) {
      const utcMs = startUtcMs + i * MS_PER_DAY;
      const day = formatUtcMsAsIsoDay(utcMs);
      const weekday = (new Date(utcMs).getUTCDay() + 6) % 7;
      const weekIndex = Math.floor((startDow + i) / 7);
      const row = byDay.get(day);
      const activeMin = Math.round(Math.max(0, Number(row?.activeMin) || 0) * 10) / 10;
      const attempts = Math.max(0, Math.round(Number(row?.attempts) || 0));
      const upi =
        row?.upi !== null && row?.upi !== undefined && Number.isFinite(Number(row.upi))
          ? Math.round(Number(row.upi))
          : null;
      const efficiencyPct =
        row?.efficiencyPct !== null &&
        row?.efficiencyPct !== undefined &&
        Number.isFinite(Number(row.efficiencyPct))
          ? Math.round(Number(row.efficiencyPct))
          : null;
      const isActive = activeMin >= 3 || attempts > 0;
      /** @type {0 | 1 | 2 | 3 | 4} */
      const level = !isActive
        ? 0
        : activeMin >= 240
        ? 4
        : activeMin >= 120
        ? 3
        : activeMin >= 45
        ? 2
        : 1;

      if (isActive) activeDays++;
      totalActiveMin += activeMin;
      totalAttempts += attempts;

      /** @type {OsloHeatmapCell} */
      const cell = {
        day,
        weekday,
        weekIndex,
        isToday: day === endDay,
        activeMin,
        attempts,
        upi,
        efficiencyPct,
        level,
      };
      cells.push(cell);
      columns[weekIndex][weekday] = cell;
    }

    // Current streak (tolerate empty today without breaking yesterday's active streak)
    let currentStreak = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i];
      if (c.level > 0) {
        currentStreak++;
      } else if (i < cells.length - 1) {
        break;
      }
    }

    // Longest consecutive active run within the window
    let longestStreak = 0;
    let run = 0;
    for (const c of cells) {
      if (c.level > 0) {
        run++;
        if (run > longestStreak) longestStreak = run;
      } else {
        run = 0;
      }
    }

    // Month labels anchored to first column of each month transition
    /** @type {Array<{ colIndex: number, label: string }>} */
    const monthLabels = [];
    let lastMonthKey = '';
    let lastLabelCol = -10;
    for (let colIdx = 0; colIdx < columns.length; colIdx++) {
      const col = columns[colIdx];
      const firstOfMonth = col.find((c) => c !== null && c.day.endsWith('-01')) || null;
      const anchor = firstOfMonth || col.find((c) => c !== null) || null;
      if (!anchor) continue;
      const mk = anchor.day.slice(0, 7);
      if (mk !== lastMonthKey && (colIdx === 0 || colIdx - lastLabelCol >= 2)) {
        const d = new Date(`${mk}-01T00:00:00Z`);
        monthLabels.push({
          colIndex: colIdx,
          label: d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }),
        });
        lastMonthKey = mk;
        lastLabelCol = colIdx;
      }
    }

    return {
      weeks: safeWeeks,
      startDay: cells[0]?.day || endDay,
      endDay,
      cells,
      columns,
      monthLabels,
      activeDays,
      totalDays,
      totalActiveMin: Math.round(totalActiveMin * 10) / 10,
      totalAttempts,
      currentStreak,
      longestStreak,
    };
  }

  /**
   * Resolve FSRS-5 power-law retrievability using `StudyCore.computeFsrsRetrievability` when loaded,
   * with an identical standalone fallback.
   * @param {number} stability
   * @param {number} elapsedDays
   * @returns {number}
   */
  function resolveFsrsRetrievability(stability, elapsedDays) {
    const core = /** @type {{ StudyCore?: { computeFsrsRetrievability?: (s: number, t: number) => number } }} */ (root).StudyCore;
    if (core && typeof core.computeFsrsRetrievability === 'function') {
      return core.computeFsrsRetrievability(stability, elapsedDays);
    }
    const s = Math.max(0.2, Number(stability) || 0.2);
    const t = Math.max(0, Number(elapsedDays) || 0);
    return Math.pow(1 + t / (9 * s), -1);
  }

  /**
   * Compute FSRS memory retention stats (average current retrievability %, overdue count,
   * at-risk count, consolidated count) and a `days`-day review load forecast in Europe/Oslo.
   * Accepts an array of FSRS cards or a `{ [questionId]: { fsrs, updatedAt } }` record map.
   * @param {FsrsCardLike[] | Record<string, FsrsCardLike> | null | undefined} fsrsCards
   * @param {number} [nowMs=Date.now()]
   * @param {number} [days=14]
   * @returns {FsrsForecastResult}
   */
  function computeFsrsForecast(fsrsCards, nowMs = Date.now(), days = 14) {
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const safeDays = Math.max(1, Math.min(60, Math.round(Number(days) || 14)));
    const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
    const todayIso = dayFormat.format(new Date(tMs));
    const todayUtcMs = parseIsoDayUtcMs(todayIso) || Date.UTC(2026, 0, 1);

    /** @type {FsrsForecastBucket[]} */
    const buckets = [];
    /** @type {Map<string, FsrsForecastBucket>} */
    const bucketByDay = new Map();
    for (let i = 0; i < safeDays; i++) {
      const day = formatUtcMsAsIsoDay(todayUtcMs + i * MS_PER_DAY);
      /** @type {FsrsForecastBucket} */
      const bucket = {
        day,
        label: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : formatIsoDayShort(day),
        dayOffset: i,
        isToday: i === 0,
        count: 0,
        overdueCount: 0,
        scheduledCount: 0,
        byCourse: {},
      };
      buckets.push(bucket);
      bucketByDay.set(day, bucket);
    }

    /** @type {FsrsCardLike[]} */
    const cardList = [];
    if (Array.isArray(fsrsCards)) {
      for (const item of fsrsCards) {
        if (!isPlainRecord(item)) continue;
        if (isPlainRecord(item.fsrs)) {
          cardList.push({
            questionId: typeof item.questionId === 'string' ? item.questionId : undefined,
            courseId: typeof item.courseId === 'string' ? item.courseId : undefined,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
            .../** @type {FsrsCardLike} */ (item.fsrs),
          });
        } else {
          cardList.push(/** @type {FsrsCardLike} */ (item));
        }
      }
    } else if (isPlainRecord(fsrsCards)) {
      for (const [key, raw] of Object.entries(fsrsCards)) {
        if (!isPlainRecord(raw)) continue;
        const inner = isPlainRecord(raw.fsrs) ? /** @type {FsrsCardLike} */ (raw.fsrs) : /** @type {FsrsCardLike} */ (raw);
        const courseFromKey = key.includes(':') ? key.split(':')[0] : '';
        cardList.push({
          questionId: typeof raw.questionId === 'string' ? raw.questionId : key,
          courseId: typeof raw.courseId === 'string' ? raw.courseId : courseFromKey,
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
          ...inner,
        });
      }
    }

    let trackedCards = 0;
    let retrievabilitySum = 0;
    let overdueCount = 0;
    let atRiskCount = 0;
    let stableCount = 0;
    let laterCount = 0;

    for (const card of cardList) {
      const rawStab = Number(card.stability);
      const rawSched = Number(card.scheduledDays);
      const rawReps = Number(card.reps);
      const dueMs = typeof card.due === 'string' && card.due ? Date.parse(card.due) : NaN;
      const hasCardData =
        (Number.isFinite(rawStab) && rawStab > 0) ||
        (Number.isFinite(rawReps) && rawReps > 0) ||
        Number.isFinite(dueMs);
      if (!hasCardData) continue;

      const stability = Math.max(
        0.2,
        Number.isFinite(rawStab) && rawStab > 0
          ? rawStab
          : Number.isFinite(rawSched) && rawSched > 0
          ? rawSched
          : 1.0
      );

      let elapsedDays = 0;
      const lastReviewMs = typeof card.lastReview === 'string' && card.lastReview ? Date.parse(card.lastReview) : NaN;
      const updatedMs = typeof card.updatedAt === 'string' && card.updatedAt ? Date.parse(card.updatedAt) : NaN;
      if (Number.isFinite(lastReviewMs)) {
        elapsedDays = Math.max(0, (tMs - lastReviewMs) / MS_PER_DAY);
      } else if (Number.isFinite(dueMs)) {
        const sched = Number.isFinite(rawSched) && rawSched > 0 ? rawSched : stability;
        const inferredLastMs = dueMs - sched * MS_PER_DAY;
        elapsedDays = Math.max(0, (tMs - inferredLastMs) / MS_PER_DAY);
      } else if (Number.isFinite(updatedMs)) {
        elapsedDays = Math.max(0, (tMs - updatedMs) / MS_PER_DAY);
      }

      const r = resolveFsrsRetrievability(stability, elapsedDays);
      trackedCards++;
      retrievabilitySum += r;
      if (r < 0.8) atRiskCount++;
      if (stability >= 7) stableCount++;

      if (Number.isFinite(dueMs)) {
        const cid =
          card.courseId ||
          (typeof card.questionId === 'string' && card.questionId.includes(':')
            ? card.questionId.split(':')[0]
            : '');
        if (dueMs <= tMs) {
          overdueCount++;
          buckets[0].overdueCount++;
          buckets[0].count++;
          if (cid) buckets[0].byCourse[cid] = (buckets[0].byCourse[cid] || 0) + 1;
        } else {
          const dueDay = dayFormat.format(new Date(dueMs));
          const target = bucketByDay.get(dueDay);
          if (target) {
            target.scheduledCount++;
            target.count++;
            if (cid) target.byCourse[cid] = (target.byCourse[cid] || 0) + 1;
          } else if (dueDay < todayIso) {
            overdueCount++;
            buckets[0].overdueCount++;
            buckets[0].count++;
            if (cid) buckets[0].byCourse[cid] = (buckets[0].byCourse[cid] || 0) + 1;
          } else {
            laterCount++;
          }
        }
      }
    }

    const avgRetrievabilityPct =
      trackedCards > 0 ? Math.round((retrievabilitySum / trackedCards) * 100) : null;
    const dueNext7Days = buckets.slice(0, Math.min(7, buckets.length)).reduce((s, b) => s + b.count, 0);
    const dueNext14Days = buckets.reduce((s, b) => s + b.count, 0);

    /** @type {FsrsForecastBucket | null} */
    let peakDay = null;
    for (const b of buckets) {
      if (b.count > 0 && (!peakDay || b.count > peakDay.count)) {
        peakDay = b;
      }
    }

    return {
      todayIso,
      days: safeDays,
      trackedCards,
      avgRetrievabilityPct,
      overdueCount,
      atRiskCount,
      stableCount,
      dueNext7Days,
      dueNext14Days,
      laterCount,
      peakDay,
      buckets,
    };
  }

  /**
   * Analyze active study hours, UPI, accuracy, and Beat-AI rate across the 24-hour clock
   * in `tz` (default `Europe/Oslo`), highlighting the #1 peak performance hour.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @param {string} [tz='Europe/Oslo']
   * @returns {HourlyPerformanceResult}
   */
  function computeHourlyPerformance(attempts, tz = 'Europe/Oslo') {
    let safeTz = typeof tz === 'string' && tz.trim() ? tz.trim() : 'Europe/Oslo';
    /** @type {Intl.DateTimeFormat} */
    let hourFmt;
    try {
      hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: safeTz, hour: '2-digit', hourCycle: 'h23' });
    } catch {
      safeTz = 'Europe/Oslo';
      hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: safeTz, hour: '2-digit', hourCycle: 'h23' });
    }

    /** @type {StudyAttemptLike[][]} */
    const byHour = Array.from({ length: 24 }, () => []);
    let totalAttempts = 0;

    for (const a of Array.isArray(attempts) ? attempts : []) {
      if (!a || !a.timestamp) continue;
      const ms = parseTimestampMs(a.timestamp);
      if (!ms) continue;
      const rawH = Number(hourFmt.format(new Date(ms)));
      if (!Number.isFinite(rawH)) continue;
      const h = ((Math.floor(rawH) % 24) + 24) % 24;
      byHour[h].push(a);
      totalAttempts++;
    }

    /** @type {HourlyPerformanceBucket[]} */
    const hours = byHour.map((arr, h) => {
      const padH = String(h).padStart(2, '0');
      const nextH = String((h + 1) % 24).padStart(2, '0');
      const sec = arr.reduce((s, a) => s + Math.max(0, Number(a.activeSec) || 0), 0);
      const activeMin = Math.round((sec / 60) * 10) / 10;
      const activeHours = Math.round((sec / 3600) * 100) / 100;
      const paceArr = arr.filter((a) => Number.isFinite(Number(a.paceRatio)) && Number(a.paceRatio) > 0);
      const avgPaceRatio = paceArr.length
        ? Math.round((paceArr.reduce((s, a) => s + Number(a.paceRatio), 0) / paceArr.length) * 100) / 100
        : null;
      const accuracyPct = arr.length
        ? Math.round((arr.reduce((s, a) => s + Number(a.qualityAccuracy || 0), 0) / arr.length) * 100)
        : null;
      const beatAiRatePct = arr.length
        ? Math.round((arr.filter((a) => Boolean(a.beatAi)).length / arr.length) * 100)
        : null;
      const upi = arr.length ? computeWeightedUpi(arr, 0.9) : null;

      return {
        hour: h,
        label: padH,
        rangeLabel: `${padH}:00–${nextH}:00`,
        attempts: arr.length,
        activeMin,
        activeHours,
        upi,
        accuracyPct,
        beatAiRatePct,
        avgPaceRatio,
        isPeak: false,
      };
    });

    const populated = hours.filter((b) => b.attempts > 0);
    const multiSample = populated.filter((b) => b.attempts >= 2);
    const candidates = multiSample.length ? multiSample : populated;

    /** @type {HourlyPerformanceBucket | null} */
    let peakHour = null;
    let bestScore = -Infinity;
    for (const b of candidates) {
      const score =
        (b.upi ?? 70) * 0.65 +
        (b.beatAiRatePct ?? 50) * 0.25 +
        Math.min(20, b.attempts * 2) * 0.5;
      if (
        score > bestScore ||
        (score === bestScore &&
          peakHour !== null &&
          ((b.upi ?? 0) > (peakHour.upi ?? 0) ||
            ((b.upi ?? 0) === (peakHour.upi ?? 0) && b.attempts > peakHour.attempts)))
      ) {
        bestScore = score;
        peakHour = b;
      }
    }
    if (peakHour) peakHour.isPeak = true;

    /** @type {HourlyPerformanceBucket | null} */
    let mostActiveHour = null;
    for (const b of populated) {
      if (
        !mostActiveHour ||
        b.activeMin > mostActiveHour.activeMin ||
        (b.activeMin === mostActiveHour.activeMin && b.attempts > mostActiveHour.attempts)
      ) {
        mostActiveHour = b;
      }
    }

    return {
      timezone: safeTz,
      hours,
      totalAttempts,
      activeHourCount: populated.length,
      peakHour,
      mostActiveHour,
    };
  }

  /**
   * Escape a single CSV cell per RFC-4180 and neutralize spreadsheet formula injection
   * (`=`, `+`, `-`, `@`, tab, or CR prefixes on string cells).
   * @param {unknown} value
   * @returns {string}
   */
  function escapeCsvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    let str = String(value);
    if (/^[\t\r ]*[=+\-@]/.test(str) || /^[\t\r]/.test(str)) {
      str = `'${str}`;
    }
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Build an RFC-4180 escaped, formula-injection-guarded CSV of logged study attempts.
   * @param {StudyAttemptLike[] | null | undefined} attempts
   * @returns {string}
   */
  function buildAttemptsCsv(attempts) {
    const header = [
      'timestamp',
      'oslo_day',
      'course_id',
      'topic_id',
      'question_id',
      'kind',
      'profile',
      'dlpfc_tier',
      'active_sec',
      'ai_par_sec',
      'pace_ratio',
      'accuracy_pct',
      'beat_ai',
      'hints_used',
      'ref_used',
      'ref_sec',
      'verification_tier',
      'source',
    ].join(',');
    const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
    const rows = [header];

    for (const a of Array.isArray(attempts) ? attempts : []) {
      if (!a) continue;
      const ms = parseTimestampMs(a.timestamp);
      const osloDay = ms ? dayFmt.format(new Date(ms)) : '';
      const qAcc =
        a.qualityAccuracy !== undefined && a.qualityAccuracy !== null && Number.isFinite(Number(a.qualityAccuracy))
          ? Math.round(Number(a.qualityAccuracy) * 100)
          : '';
      const pace =
        a.paceRatio !== undefined && a.paceRatio !== null && Number.isFinite(Number(a.paceRatio))
          ? Math.round(Number(a.paceRatio) * 100) / 100
          : '';
      const tier = resolveAttemptTier(a, null);
      const row = [
        a.timestamp ?? '',
        osloDay,
        a.courseId ?? (typeof a.questionId === 'string' && a.questionId.includes(':') ? a.questionId.split(':')[0] : ''),
        a.topicId ?? '',
        a.questionId ?? '',
        a.kind ?? '',
        a.profile ?? '',
        tier,
        Math.max(0, Math.round(Number(a.activeSec) || 0)),
        Math.max(0, Math.round(Number(a.aiParSec || a.parSec) || 0)),
        pace,
        qAcc,
        Boolean(a.beatAi),
        Math.max(0, Math.round(Number(a.hintsUsed) || 0)),
        Boolean(a.refUsed),
        Math.max(0, Math.round(Number(a.refSec) || 0)),
        a.verificationTier ?? '',
        a.source ?? '',
      ].map(escapeCsvCell);
      rows.push(row.join(','));
    }

    return rows.join('\r\n');
  }

  /**
   * Build an RFC-4180 escaped, formula-injection-guarded CSV of the Oslo daily telemetry ledger.
   * @param {DailySeriesRowLike[] | null | undefined} dailySeries
   * @returns {string}
   */
  function buildDailySeriesCsv(dailySeries) {
    const header = [
      'day',
      'is_today',
      'active_min',
      'screen_min',
      'off_screen_min',
      'efficiency_pct',
      'attempts',
      'adjusted_units',
      'upi',
      'accuracy_pct',
      'avg_pace_ratio',
      'high_min',
      'med_min',
      'low_min',
      'has_screen_log',
    ].join(',');
    const sorted = [...(Array.isArray(dailySeries) ? dailySeries : [])]
      .filter((d) => Boolean(d && typeof d.day === 'string'))
      .sort((a, b) => a.day.localeCompare(b.day));
    const rows = [header];

    for (const d of sorted) {
      const row = [
        d.day,
        Boolean(d.isToday),
        Math.round(Math.max(0, Number(d.activeMin) || 0) * 10) / 10,
        Math.round(Math.max(0, Number(d.screenMin) || 0) * 10) / 10,
        Math.round(Math.max(0, Number(d.offScreenMin) || 0) * 10) / 10,
        d.efficiencyPct ?? '',
        Math.max(0, Math.round(Number(d.attempts) || 0)),
        Math.round(Math.max(0, Number(d.adjustedUnits) || 0) * 10) / 10,
        d.upi ?? '',
        d.accuracyPct ?? '',
        d.avgPaceRatio ?? '',
        Math.round(Math.max(0, Number(d.highMin) || 0) * 10) / 10,
        Math.round(Math.max(0, Number(d.medMin) || 0) * 10) / 10,
        Math.round(Math.max(0, Number(d.lowMin) || 0) * 10) / 10,
        Boolean(d.hasScreenLog),
      ].map(escapeCsvCell);
      rows.push(row.join(','));
    }

    return rows.join('\r\n');
  }

  /**
   * Parse YYYY-MM-DD string to UTC day number for clean calendar-day deltas.
   * @param {unknown} isoDay
   * @returns {number | null}
   */
  function parseDayNum(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || '').trim());
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
  }

  /**
   * Compute per-course Exam Pace (vs. Target A/B/C ramp) and Estimated ECTS Grade (Beta).
   * Combines syllabus chapter coverage, High-DLPFC mastery, accuracy, FSRS-5 exam-day retention,
   * pace vs. AI par, and any saved timed past-exam sits.
   * @param {{
   *   catalog?: Array<Record<string, any>> | null,
   *   courseProgress?: Record<string, any> | null,
   *   topicMatrix?: Record<string, Array<Record<string, any>>> | null,
   *   byCourse?: Record<string, Record<string, any>> | null,
   *   fsrsCards?: Array<Record<string, any>> | null,
   *   examResults?: Record<string, any> | null,
   *   todayIso?: string | null,
   *   targetGrade?: string | null,
   * }} [input]
   */
  function computeExamReadinessForecast(input = {}) {
    const catalog = Array.isArray(input.catalog) ? input.catalog : [];
    const courseProgress = isPlainRecord(input.courseProgress) ? input.courseProgress : {};
    const topicMatrix = isPlainRecord(input.topicMatrix) ? input.topicMatrix : {};
    const byCourse = isPlainRecord(input.byCourse) ? input.byCourse : {};
    const fsrsCards = Array.isArray(input.fsrsCards) ? input.fsrsCards : [];
    const examResults = isPlainRecord(input.examResults) ? input.examResults : {};
    const todayKey = typeof input.todayIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.todayIso)
      ? input.todayIso
      : new Date().toISOString().slice(0, 10);
    const todayNum = parseDayNum(todayKey);

    const rawTarget = String(input.targetGrade || 'A').trim().toUpperCase();
    const targetGrade = rawTarget === 'B' || rawTarget === 'C' ? rawTarget : 'A';
    const targetThresholdPct = targetGrade === 'A' ? 85 : targetGrade === 'B' ? 77 : 65;
    const targetMult = targetGrade === 'A' ? 1.0 : targetGrade === 'B' ? 0.80 : 0.60;

    // Group FSRS cards by courseId
    /** @type {Map<string, Array<Record<string, any>>>} */
    const cardsByCourse = new Map();
    for (const card of fsrsCards) {
      if (!card || typeof card !== 'object') continue;
      const cid = String(card.courseId || (typeof card.questionId === 'string' && card.questionId.includes(':') ? card.questionId.split(':')[0] : ''));
      if (!cid) continue;
      if (!cardsByCourse.has(cid)) cardsByCourse.set(cid, []);
      /** @type {Array<Record<string, any>>} */ (cardsByCourse.get(cid)).push(card);
    }

    // Group timed exam sits by courseId
    /** @type {Map<string, number[]>} */
    const mockPctsByCourse = new Map();
    for (const [key, entry] of Object.entries(examResults)) {
      if (!isPlainRecord(entry)) continue;
      const cid = String(entry.courseId || (key.includes(':') ? key.split(':')[0] : ''));
      if (!cid) continue;
      const bestClean = Number(entry.bestCleanPct);
      const bestPct = Number(entry.bestPct ?? entry.lastPct);
      const pct = Number.isFinite(bestClean) && bestClean >= 0 ? bestClean : (Number.isFinite(bestPct) && bestPct >= 0 ? bestPct : NaN);
      if (!Number.isFinite(pct)) continue;
      if (!mockPctsByCourse.has(cid)) mockPctsByCourse.set(cid, []);
      /** @type {number[]} */ (mockPctsByCourse.get(cid)).push(Math.max(0, Math.min(100, pct)));
    }

    const courses = catalog.map((course) => {
      const cid = String(course.courseId || '');
      const code = String(course.code || cid);
      const title = String(course.shortTitle || course.title || cid);
      const examDate = String(course.examInfo?.date || course.examDate || '').trim();
      const examDayNum = parseDayNum(examDate);
      const daysLeft = (todayNum != null && examDayNum != null) ? (examDayNum - todayNum) : null;

      const cp = isPlainRecord(courseProgress[cid]) ? courseProgress[cid] : {};
      const byTier = isPlainRecord(cp.byTier) ? cp.byTier : {};
      const tier3 = isPlainRecord(byTier['3']) ? byTier['3'] : {};
      const totalQ = Math.max(0, Number(cp.total ?? course.questionCount ?? 0) || 0);
      const done = Math.max(0, Number(cp.done || 0) || 0);
      const revisit = Math.max(0, Number(cp.revisit || 0) || 0);
      const dueFsrs = Math.max(0, Number(cp.dueFsrs || 0) || 0);
      const highTotal = Math.max(0, Number(tier3.total || 0) || 0);
      const highDone = Math.max(0, Number(tier3.done || 0) || 0);

      const topics = Array.isArray(topicMatrix[cid]) ? topicMatrix[cid] : [];
      const topicsCount = topics.length || (Array.isArray(course.topics) ? course.topics.length : 0);
      const stats = isPlainRecord(byCourse[cid]) ? byCourse[cid] : {};
      const attemptsCount = Math.max(0, Number(stats.count || 0) || 0);
      const hasAcc = stats.avgAccuracy !== undefined && stats.avgAccuracy !== null && Number.isFinite(Number(stats.avgAccuracy)) && attemptsCount > 0;
      const courseAcc = hasAcc ? Math.max(0, Math.min(1, Number(stats.avgAccuracy))) : null;
      const avgPaceRatio = stats.avgPaceRatio !== undefined && stats.avgPaceRatio !== null && Number.isFinite(Number(stats.avgPaceRatio)) && attemptsCount > 0
        ? Math.max(0, Number(stats.avgPaceRatio))
        : null;
      const workedMin = Math.max(0, Number(stats.totalActiveMinutes || 0) || 0);

      // Realistic A/B/C target milestones (proportional to syllabus & bank size)
      const baseTargetDone = totalQ > 0
        ? Math.min(totalQ, Math.max(12, Math.round(Math.min(totalQ * 0.45, Math.max(totalQ * 0.30, topicsCount * 10)))))
        : 0;
      const targetDone = baseTargetDone > 0 ? Math.min(totalQ, Math.max(8, Math.round(baseTargetDone * targetMult))) : 0;
      const rawTargetHigh = highTotal > 0 ? Math.min(highTotal, Math.max(4, Math.round(highTotal * 0.65 * targetMult))) : 0;
      const targetHighDone = targetDone > 0 ? Math.min(rawTargetHigh, Math.max(4, Math.round(targetDone * 0.80))) : rawTargetHigh;

      const volumeRatio = targetDone > 0 ? Math.min(1, done / targetDone) : 0;
      const highRatio = targetHighDone > 0 ? Math.min(1, highDone / targetHighDone) : volumeRatio;

      // Syllabus chapter breadth
      let coveredTopics = 0;
      let chapterScoreSum = 0;
      for (const t of topics) {
        const covPct = Math.max(0, Number(t.coveragePct || 0));
        const tDone = Math.max(0, Number(t.doneCount || 0));
        if (tDone >= 2 || covPct >= 20) coveredTopics += 1;
        const covWeight = Math.min(1, Math.max(covPct / 35, tDone / 6));
        const tAcc = t.avgAccuracy != null && Number.isFinite(Number(t.avgAccuracy))
          ? Math.max(0, Math.min(1, Number(t.avgAccuracy)))
          : (courseAcc != null ? courseAcc : 0.55);
        chapterScoreSum += covWeight * (tAcc * 100) + (1 - covWeight) * 28;
      }
      const coveredTopicsRatio = topics.length > 0 ? coveredTopics / topics.length : volumeRatio;
      const breadthTarget = Math.max(0.45, 0.85 * targetMult);
      const breadthRatio = Math.min(1, coveredTopicsRatio / breadthTarget);

      // FSRS-5 projected retention on Exam Day (R(t_exam, S) = (1 + 19/81 * t/S)^-0.5)
      const courseCards = cardsByCourse.get(cid) || [];
      const horizonDays = daysLeft != null ? Math.max(0, Math.min(60, daysLeft)) : 7;
      let retentionSum = 0;
      let retentionN = 0;
      const nowMs = todayNum != null ? todayNum * 86_400_000 + 43_200_000 : Date.now();
      for (const c of courseCards) {
        const s = Number(c.stability);
        if (!Number.isFinite(s) || s <= 0) continue;
        const lastMs = parseTimestampMs(c.lastReview || c.updatedAt);
        const elapsedDays = lastMs > 0 ? Math.max(0, (nowMs - lastMs) / 86_400_000) : 0;
        const tExam = elapsedDays + horizonDays;
        const rExam = Math.pow(1 + (19 / 81) * (tExam / s), -0.5);
        retentionSum += Math.max(0, Math.min(1, rExam));
        retentionN += 1;
      }
      const examDayRetention = retentionN > 0 ? retentionSum / retentionN : (done > 0 ? 0.65 : 0);

      // Composite Readiness % toward the selected Target Grade
      const readinessPct = Math.max(
        0,
        Math.min(100, Math.round((0.35 * volumeRatio + 0.30 * highRatio + 0.25 * breadthRatio + 0.10 * examDayRetention) * 100))
      );

      // Ideal 28-day pre-exam ramp curve (15% at 28+ days out -> 100% on exam day)
      const expectedByTodayPct = daysLeft == null
        ? 50
        : daysLeft <= 0
          ? 100
          : daysLeft >= 28
            ? 15
            : Math.round(15 + 85 * ((28 - daysLeft) / 28));
      const paceDeltaPts = readinessPct - expectedByTodayPct;

      let paceStatus = 'on_track';
      let paceLabel = 'On Track';
      let paceTone = 'good';
      if (daysLeft != null && daysLeft < 0) {
        paceStatus = 'past';
        paceLabel = 'Exam Passed';
        paceTone = 'muted';
      } else if (done === 0 && attemptsCount === 0) {
        paceStatus = 'not_started';
        paceLabel = daysLeft != null && daysLeft <= 14 ? 'Behind · Not Started' : 'Not Started';
        paceTone = daysLeft != null && daysLeft <= 14 ? 'bad' : 'muted';
      } else if (paceDeltaPts >= 6) {
        paceStatus = 'ahead';
        paceLabel = 'Ahead of Pace';
        paceTone = 'good';
      } else if (paceDeltaPts >= -8) {
        paceStatus = 'on_track';
        paceLabel = 'On Track';
        paceTone = 'good';
      } else if (paceDeltaPts >= -22) {
        paceStatus = 'slightly_behind';
        paceLabel = 'Slightly Behind';
        paceTone = 'warn';
      } else {
        paceStatus = 'behind';
        paceLabel = 'Behind Pace';
        paceTone = 'bad';
      }

      // Estimated Exam Score (Beta) & ECTS Grade
      const mockPcts = mockPctsByCourse.get(cid) || [];
      const mockAvgPct = mockPcts.length
        ? mockPcts.reduce((s, v) => s + v, 0) / mockPcts.length
        : null;
      const hasEvidence = done > 0 || attemptsCount > 0 || mockPcts.length > 0;

      /** @type {number | null} */
      let projectedPct = null;
      /** @type {number | null} */
      let marginPct = null;
      /** @type {EctsGradeLike | null} */
      let estGrade = null;
      /** @type {EctsGradeLike | null} */
      let lowGrade = null;
      /** @type {EctsGradeLike | null} */
      let highGrade = null;

      if (hasEvidence) {
        const effAcc = courseAcc != null ? courseAcc : 0.60;
        const syllabusYieldPct = topics.length > 0
          ? chapterScoreSum / topics.length
          : (volumeRatio * (effAcc * 100) + (1 - volumeRatio) * 28);
        const highPerfPct = highTotal > 0
          ? Math.min(100, (0.30 + 0.70 * highRatio) * (effAcc * 100))
          : syllabusYieldPct;
        const paceFactor = avgPaceRatio != null
          ? Math.max(0.78, Math.min(1.04, 0.78 + 0.26 * Math.min(1, avgPaceRatio)))
          : 0.94;
        const retentionFactor = Math.max(0.84, Math.min(1.03, 0.80 + 0.23 * examDayRetention));
        let est = (0.55 * syllabusYieldPct + 0.30 * highPerfPct + 0.15 * (effAcc * 100)) * paceFactor * retentionFactor;
        if (mockAvgPct != null) {
          const mockWeight = Math.min(0.45, mockPcts.length * 0.22);
          est = est * (1 - mockWeight) + mockAvgPct * mockWeight;
        }
        projectedPct = Math.max(0, Math.min(98, Math.round(est)));
        const sampleStrength = Math.min(1, (attemptsCount + done) / 140) + Math.min(0.35, mockPcts.length * 0.18);
        marginPct = Math.max(5, Math.min(14, Math.round(14 - sampleStrength * 7)));
        estGrade = resolveGradeFromPct(projectedPct);
        lowGrade = resolveGradeFromPct(Math.max(0, projectedPct - marginPct));
        highGrade = resolveGradeFromPct(Math.min(100, projectedPct + marginPct));
      }

      const remainingTargetQs = Math.max(0, targetDone - done);
      const remainingHighQs = Math.max(0, targetHighDone - highDone);
      const activeDays = daysLeft != null ? Math.max(1, daysLeft) : 14;
      const highPerDayNeeded = (daysLeft != null && daysLeft < 0) ? 0 : Math.ceil(remainingHighQs / activeDays);
      const qsPerDayNeeded = (daysLeft != null && daysLeft < 0) ? 0 : Math.max(Math.ceil(remainingTargetQs / activeDays), highPerDayNeeded);
      const gapToTargetPct = projectedPct != null ? Math.max(0, targetThresholdPct - projectedPct) : targetThresholdPct;

      const weakestTopics = [...topics]
        .sort((a, b) => (Number(a.coveragePct || 0) - Number(b.coveragePct || 0)) || (Number(a.avgAccuracy ?? 1) - Number(b.avgAccuracy ?? 1)))
        .slice(0, 2)
        .map((t) => ({
          id: String(t.id || ''),
          title: String(t.title || ''),
          coveragePct: Math.round(Number(t.coveragePct || 0)),
          doneCount: Number(t.doneCount || 0),
          totalCount: Number(t.totalCount || 0),
        }));

      return {
        courseId: cid,
        code,
        title,
        examDate: examDate || null,
        daysLeft,
        totalQ,
        done,
        revisit,
        dueFsrs,
        highTotal,
        highDone,
        targetDone,
        targetHighDone,
        coveredTopics,
        topicsCount,
        attemptsCount,
        workedMin: Math.round(workedMin),
        avgAccuracyPct: courseAcc != null ? Math.round(courseAcc * 100) : null,
        avgPaceRatio: avgPaceRatio != null ? Math.round(avgPaceRatio * 100) / 100 : null,
        examDayRetentionPct: Math.round(examDayRetention * 100),
        mockSitsCount: mockPcts.length,
        readinessPct,
        expectedByTodayPct,
        paceDeltaPts,
        paceStatus,
        paceLabel,
        paceTone,
        projectedPct,
        marginPct,
        estGrade: estGrade ? estGrade.letter : null,
        estGradeCls: estGrade ? estGrade.cls : '',
        lowGrade: lowGrade ? lowGrade.letter : null,
        highGrade: highGrade ? highGrade.letter : null,
        gapToTargetPct,
        remainingTargetQs,
        remainingHighQs,
        qsPerDayNeeded,
        highPerDayNeeded,
        weakestTopics,
      };
    });

    // Sort: upcoming exams soonest first, then undated courses, then passed exams
    courses.sort((a, b) => {
      const aPast = a.daysLeft != null && a.daysLeft < 0 ? 1 : 0;
      const bPast = b.daysLeft != null && b.daysLeft < 0 ? 1 : 0;
      if (aPast !== bPast) return aPast - bPast;
      if (a.daysLeft != null && b.daysLeft != null) return a.daysLeft - b.daysLeft;
      if (a.daysLeft != null) return -1;
      if (b.daysLeft != null) return 1;
      return b.done - a.done;
    });

    const activeUpcoming = courses.filter((c) => c.daysLeft == null || c.daysLeft >= 0);
    const nextExam = activeUpcoming.find((c) => c.daysLeft != null) || courses[0] || null;
    const avgReadinessPct = activeUpcoming.length
      ? Math.round(activeUpcoming.reduce((s, c) => s + c.readinessPct, 0) / activeUpcoming.length)
      : 0;

    return {
      targetGrade,
      targetThresholdPct,
      todayIso: todayKey,
      nextExam,
      avgReadinessPct,
      courses,
    };
  }

  const api = {
    calibratedParSec,
    isAutoGradedAttempt,
    computeWeightedUpi,
    resolveAttemptTier,
    computeAttemptAdjustedUnits,
    summarizeAttemptBucket,
    computeOsloStreakDays,
    computeCheckInCorrelations,
    classifyVerificationTiers,
    classifyTopicReadiness,
    buildTopicMasteryMatrix,
    normalizeAttemptHistoryList,
    isBetterExamAttempt,
    countExamAidUnits,
    inferCompletedAttempts,
    computeExamPaperProgress,
    computeExamAidStats,
    isoWeekKey,
    aggregateDailyBuckets,
    computeNiceAxisMax,
    sortTopicMatrixRows,
    reconcileDayEfficiency,
    buildOsloHeatmap,
    computeFsrsForecast,
    computeHourlyPerformance,
    escapeCsvCell,
    buildAttemptsCsv,
    buildDailySeriesCsv,
    computeExamReadinessForecast,
  };

  /** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore = {
    ...(/** @type {{ StudyCore?: Record<string, unknown> }} */ (root).StudyCore || {}),
    ...api,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
