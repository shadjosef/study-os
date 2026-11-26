import test from 'node:test';
import assert from 'node:assert/strict';

import fsrs from '../app/public/js/core/fsrs.js';
import grading from '../app/public/js/core/grading.js';
import analytics from '../app/public/js/core/analytics.js';

const BASE_MS = Date.parse('2026-05-12T10:00:00.000Z'); // Tuesday in Europe/Oslo (CEST, UTC+2)
const DAY_MS = 86_400_000;

// =============================================================================
// 1. UMD-lite dual-runtime export contract
// =============================================================================
test('analytics.js populates globalThis.StudyCore and exports identical functions', () => {
  assert.ok(globalThis.StudyCore, 'globalThis.StudyCore should be attached');
  assert.equal(globalThis.StudyCore.computeWeightedUpi, analytics.computeWeightedUpi);
  assert.equal(globalThis.StudyCore.computeOsloStreakDays, analytics.computeOsloStreakDays);
  assert.equal(globalThis.StudyCore.computeExamAidStats, analytics.computeExamAidStats);
  assert.equal(globalThis.StudyCore.aggregateDailyBuckets, analytics.aggregateDailyBuckets);
  assert.equal(globalThis.StudyCore.buildTopicMasteryMatrix, analytics.buildTopicMasteryMatrix);
  // Coexists cleanly with sibling core modules
  assert.equal(globalThis.StudyCore.updateFsrs5Card, fsrs.updateFsrs5Card);
  assert.equal(globalThis.StudyCore.gradeFromPct, grading.gradeFromPct);
});

// =============================================================================
// 2. Calibrated AI-Par Seconds & Attempt Classification
// =============================================================================
test('calibratedParSec scales MCQ targets by tier, text length, and exam profile', () => {
  assert.equal(analytics.calibratedParSec(null), 90);

  const shortEasyMcq = {
    kind: 'mcq',
    difficulty: 1,
    promptMarkdown: 'Define marginal cost.',
    options: ['A', 'B', 'C', 'D'],
    pacing: { learning: { target: 3 } },
  };
  const learnSec = analytics.calibratedParSec(shortEasyMcq, 'learning');
  const examSec = analytics.calibratedParSec(shortEasyMcq, 'exam');
  assert.equal(learnSec, 50); // baseLearn tier 1 = 50, textLen < 160 -> extra 0
  assert.equal(examSec, Math.round(50 * 0.72)); // 36s

  const longHardMcq = {
    kind: 'mcq',
    dlpfcBase: 3,
    contextMarkdown: 'A'.repeat(400),
    promptMarkdown: 'B'.repeat(300),
    options: ['C'.repeat(100), 'D'.repeat(100)],
    pacing: { learning: { target: 5 } },
  };
  // tier 3: base 120 + capped extra 45 = 165 <= maxLearn 190
  assert.equal(analytics.calibratedParSec(longHardMcq, 'learning'), 165);
  assert.equal(analytics.calibratedParSec(longHardMcq, 'exam'), Math.round(165 * 0.72));

  // Written/WISEflow question honours explicit faster exam target or 0.78× fallback
  const writtenQ = { kind: 'written', pacing: { learning: { target: 10 }, exam: { target: 7 } } };
  assert.equal(analytics.calibratedParSec(writtenQ, 'learning'), 600);
  assert.equal(analytics.calibratedParSec(writtenQ, 'exam'), 420);

  const writtenNoExam = { kind: 'written', pacing: { learning: { target: 10 } } };
  assert.equal(analytics.calibratedParSec(writtenNoExam, 'exam'), 468);
});

test('isAutoGradedAttempt respects explicit flag and falls back to question kind', () => {
  assert.equal(analytics.isAutoGradedAttempt({ autoGraded: false, kind: 'mcq' }), false);
  assert.equal(analytics.isAutoGradedAttempt({ autoGraded: true, kind: 'written' }), true);
  assert.equal(analytics.isAutoGradedAttempt({ kind: 'mcq' }), true);
  assert.equal(analytics.isAutoGradedAttempt({ kind: 'wiseflow' }), true);
  assert.equal(analytics.isAutoGradedAttempt({ kind: 'FLOWMULTI' }), true);
  assert.equal(analytics.isAutoGradedAttempt({ kind: 'written' }), false);
  assert.equal(analytics.isAutoGradedAttempt(null), false);
});

// =============================================================================
// 3. Weighted UPI, Adjusted Units & Attempt Bucket Summaries
// =============================================================================
test('computeWeightedUpi handles empty input, weighting, tier/exam multipliers, and 150 cap', () => {
  assert.equal(analytics.computeWeightedUpi([]), null);
  assert.equal(analytics.computeWeightedUpi(null), null);

  // Single tier-2 auto-graded attempt at 100% acc, 1.0× par, 0.9 focus -> 100*(0.45+0.35+0.18)=98
  const baseMcq = { kind: 'mcq', dlpfcTier: 2, qualityAccuracy: 1, paceRatio: 1.0, profile: 'learning' };
  assert.equal(analytics.computeWeightedUpi([baseMcq], 0.9), 98);

  // Hard (tier 3) + exam mode gives 1.22 * 1.08 boost
  const hardExam = { kind: 'wiseflow', dlpfcTier: 3, qualityAccuracy: 1, paceRatio: 1.2, profile: 'exam' };
  const hardUpi = analytics.computeWeightedUpi([hardExam], 0.9);
  assert.ok(hardUpi > 120 && hardUpi <= 150, `Expected boosted UPI in (120,150], got ${hardUpi}`);

  // Extreme qualityAccuracy (>1) and paceRatio (>1.35) clamp cleanly -> 100*(0.45+0.35*1.35+0.2)*1.22*1.08 = 147.9 -> 148
  const maxUpi = analytics.computeWeightedUpi(
    [{ kind: 'wiseflow', dlpfcTier: 3, qualityAccuracy: 2.5, paceRatio: 9.0, profile: 'exam' }],
    1.0
  );
  assert.equal(maxUpi, 148);
  assert.ok(maxUpi <= 150);

  // Self-graded written carries 0.45× weight vs 1.0× for auto-graded
  const mixed = analytics.computeWeightedUpi([
    { kind: 'mcq', dlpfcTier: 2, qualityAccuracy: 1, paceRatio: 1.0 }, // score 98, w=1.0
    { kind: 'written', dlpfcTier: 2, qualityAccuracy: 0, paceRatio: 0 }, // score 18, w=0.45
  ], 0.9);
  assert.equal(mixed, Math.round((1.0 * 98 + 0.45 * 18) / 1.45));
});

test('resolveAttemptTier, computeAttemptAdjustedUnits, and summarizeAttemptBucket aggregate cleanly', () => {
  const lookup = { 'econ:q1': 3 };
  assert.equal(analytics.resolveAttemptTier({ questionId: 'econ:q1', kind: 'mcq' }, lookup), 3);
  assert.equal(analytics.resolveAttemptTier({ dlpfcTier: 99 }, null), 3);
  assert.equal(analytics.resolveAttemptTier({ dlpfcTier: -2 }, null), 1);

  // Empty bucket returns null rates and zero totals (no NaN)
  assert.deepEqual(analytics.summarizeAttemptBucket([]), {
    count: 0,
    avgAccuracy: null,
    beatAiRate: null,
    avgPaceRatio: null,
    totalActiveMinutes: 0,
    adjustedUnits: 0,
    upi: null,
  });

  const bucket = analytics.summarizeAttemptBucket([
    { questionId: 'econ:q1', kind: 'mcq', qualityAccuracy: 1.0, paceRatio: 1.2, beatAi: true, activeSec: 120, aiParSec: 180 },
    { questionId: 'econ:q2', kind: 'written', dlpfcTier: 2, qualityAccuracy: 0.5, paceRatio: 0.8, beatAi: false, activeSec: 240, aiParSec: 360 },
  ], lookup, 0.9);

  assert.equal(bucket.count, 2);
  assert.equal(bucket.avgAccuracy, 0.75);
  assert.equal(bucket.beatAiRate, 0.5);
  assert.equal(bucket.avgPaceRatio, 1.0);
  assert.equal(bucket.totalActiveMinutes, 6);
  // q1: (180/180)*1.35*1.0 = 1.35; q2: (360/180)*1.0*0.5 = 1.0 -> sum 2.35 -> rounded 2.4
  assert.equal(bucket.adjustedUnits, 2.4);
  assert.ok(Number.isFinite(bucket.upi));
});

// =============================================================================
// 4. Oslo Streak Calculation, Verification Tiers & Check-In Correlations
// =============================================================================
test('computeOsloStreakDays counts consecutive active days and tolerates empty today', () => {
  assert.equal(analytics.computeOsloStreakDays(null, BASE_MS), 0);

  // BASE_MS is 2026-05-12 in Europe/Oslo
  const activeTodayAndYesterday = new Map([
    ['2026-05-12', { attempts: [{}], activeSec: 60 }],
    ['2026-05-11', { attempts: [], activeSec: 200 }], // >= 180s counts
    ['2026-05-10', { attempts: [{}], activeSec: 40 }],
    ['2026-05-08', { attempts: [{}], activeSec: 600 }], // gap on 05-09 stops streak
  ]);
  assert.equal(analytics.computeOsloStreakDays(activeTodayAndYesterday, BASE_MS), 3);

  // Today has 0 activity yet, but yesterday + day before were active -> streak = 2
  const emptyToday = {
    '2026-05-12': { attempts: 0, activeSec: 60 }, // < 180s and 0 attempts
    '2026-05-11': { attempts: 2, activeSec: 300 },
    '2026-05-10': { attempts: 0, activeMin: 5 },
  };
  assert.equal(analytics.computeOsloStreakDays(emptyToday, BASE_MS), 2);

  // Yesterday empty -> streak 0 even if 2 days ago was active
  const brokenYesterday = {
    '2026-05-12': { attempts: 0, activeSec: 0 },
    '2026-05-10': { attempts: 4, activeSec: 900 },
  };
  assert.equal(analytics.computeOsloStreakDays(brokenYesterday, BASE_MS), 0);
});

test('classifyVerificationTiers separates auto, IDE, self, fast_flag, and explicit tiers', () => {
  assert.deepEqual(analytics.classifyVerificationTiers([]), {
    auto_graded: 0,
    ide_verified: 0,
    self_verified: 0,
    fast_flag: 0,
  });

  const res = analytics.classifyVerificationTiers([
    { kind: 'mcq', activeSec: 10, aiParSec: 120 }, // auto_graded
    { kind: 'written', source: 'ide_companion', activeSec: 100, aiParSec: 300 }, // ide_verified
    { kind: 'written', activeSec: 20, aiParSec: 300 }, // < 12% of 300 -> fast_flag
    { kind: 'written', activeSec: 200, aiParSec: 300 }, // self_verified
    { kind: 'written', verificationTier: 'ide_verified' }, // explicit override
  ]);
  assert.deepEqual(res, {
    auto_graded: 1,
    ide_verified: 2,
    self_verified: 1,
    fast_flag: 1,
  });
});

test('computeCheckInCorrelations requires >=3 sessions and reports High vs Low UPI deltas', () => {
  assert.deepEqual(analytics.computeCheckInCorrelations([]), []);
  assert.deepEqual(
    analytics.computeCheckInCorrelations([
      { upi: 90, checkIn: { focus: 5 } },
      { upi: 60, checkIn: { focus: 2 } },
    ]),
    []
  );

  const corrs = analytics.computeCheckInCorrelations([
    { upi: 92, checkIn: { focus: 5, energy: 4, startInertia: 1 } },
    { upi: 88, checkIn: { focus: 4, energy: 5, startInertia: 2 } },
    { upi: 60, checkIn: { focus: 2, energy: 2, startInertia: 4 } },
  ]);
  assert.equal(corrs.length, 3);
  assert.equal(corrs[0].label, 'Focus Rating ↔ Session UPI');
  assert.match(corrs[0].summary, /High \(90 UPI\) vs Low \(60 UPI\) → \+30 UPI impact across 3 sessions/);
  assert.match(corrs[2].summary, /High \(60 UPI\) vs Low \(90 UPI\) → -30 UPI impact across 3 sessions/);
});

// =============================================================================
// 5. Topic Mastery Matrix & Readiness Classification
// =============================================================================
test('classifyTopicReadiness and buildTopicMasteryMatrix group ready/building/lacking accurately', () => {
  assert.equal(analytics.classifyTopicReadiness(0.8, 50, 0.85, 0), 'ready');
  assert.equal(analytics.classifyTopicReadiness(0.8, 80, 0.65, 0), 'building'); // acc < 0.72 blocks ready
  assert.equal(analytics.classifyTopicReadiness(0.8, 80, 0.9, 2), 'building'); // >1 revisit blocks ready
  assert.equal(analytics.classifyTopicReadiness(0.1, 10, null, 0), 'lacking');

  const catalog = [
    {
      courseId: 'econ-2522',
      topicStats: [
        { id: '1', title: 'Supply & Demand', questionCount: 4, parMinutes: 20, questionIds: ['e:1', 'e:2', 'e:3', 'e:4'] },
        { id: '2', title: 'Elasticity', questionCount: 4, parMinutes: 20, questionIds: ['e:5', 'e:6', 'e:7', 'e:8'] },
      ],
    },
  ];
  const records = {
    'e:1': { status: 'done' },
    'e:2': { status: 'done' },
    'e:3': { status: 'done' }, // no timed attempt -> gets 0.85 * avgQParMin credit
    'e:5': { status: 'revisit' },
  };
  const topicAttemptSec = { 'econ-2522::1': 720 }; // 12 min
  const topicAttempts = {
    'econ-2522::1': [
      { questionId: 'e:1', qualityAccuracy: 0.9, paceRatio: 1.1 },
      { questionId: 'e:2', qualityAccuracy: 0.8, paceRatio: 0.9 },
    ],
  };

  const matrix = analytics.buildTopicMasteryMatrix(catalog, records, topicAttemptSec, topicAttempts);
  assert.equal(matrix['econ-2522'].length, 2);
  const t1 = matrix['econ-2522'][0];
  const t2 = matrix['econ-2522'][1];
  // 12m + 0.85 * (20/4) = 16.25 -> 16.3m
  assert.equal(t1.workedMin, 16.3);
  assert.equal(t1.coveragePct, 75);
  assert.equal(t1.avgPaceRatio, 1.0);
  assert.equal(t1.status, 'ready');
  assert.equal(t2.revisitCount, 1);
  assert.equal(t2.status, 'lacking');

  // Sort orders
  const byLacking = analytics.sortTopicMatrixRows(matrix['econ-2522'], 'lacking');
  assert.equal(byLacking[0].id, '2');
  const byWorked = analytics.sortTopicMatrixRows(matrix['econ-2522'], 'worked');
  assert.equal(byWorked[0].id, '1');
  const bySyllabus = analytics.sortTopicMatrixRows([t2, t1], 'syllabus');
  assert.equal(bySyllabus[0].id, '1');
});

// =============================================================================
// 6. Exam Score Summaries & Closed-Book Independence / Reference Usage
// =============================================================================
test('exam attempt comparison, aid unit counting, history normalization & paper progress', () => {
  assert.equal(analytics.countExamAidUnits(null, null, false), null);
  assert.equal(analytics.countExamAidUnits(2, 3, false), 5);
  assert.equal(analytics.countExamAidUnits(2, 3, true), 2); // open-book refs don't penalize

  // Higher score wins; ties within 0.04pt break by fewer aids
  assert.equal(analytics.isBetterExamAttempt(88, 2, 85, 0), true);
  assert.equal(analytics.isBetterExamAttempt(85.02, 1, 85.0, 2), true);
  assert.equal(analytics.isBetterExamAttempt(85.02, 3, 85.0, 1), false);
  assert.equal(analytics.isBetterExamAttempt(80, 0, -1, 0), true);

  // Deduplicate by sessionId keeping newest and capping at 15 entries
  const hist = analytics.normalizeAttemptHistoryList([
    { sessionId: 's1', pct: 70, completedAt: '2026-05-01T10:00:00Z', complete: true },
    { sessionId: 's1', pct: 86, completedAt: '2026-05-02T10:00:00Z', complete: true },
    { sessionId: 's2', pct: 92, completedAt: '2026-05-03T10:00:00Z', complete: false },
    { pct: 'bad' },
  ]);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].sessionId, 's2');
  assert.equal(hist[0].grade, 'A');
  assert.equal(hist[1].pct, 86);

  assert.equal(analytics.inferCompletedAttempts({ attemptHistory: hist }), 1);
  assert.equal(analytics.inferCompletedAttempts({ gradedCount: 10, totalCount: 10, attemptsCount: 2 }), 2);

  // Full exam paper progress with saved official A grade
  const prog = analytics.computeExamPaperProgress(
    ['q1', 'q2'],
    { q1: { status: 'done' }, q2: { status: 'done' } },
    new Map([['q1', 0.9], ['q2', 0.85]]),
    { bestPct: 88, lastPct: 88, gradedCount: 2, totalCount: 2, completedAttempts: 1, gradingKind: 'auto' },
    null
  );
  assert.equal(prog.status, 'completed');
  assert.equal(prog.grade?.letter, 'A');
  assert.equal(prog.gradeSource, 'official');
  assert.equal(prog.isGradeA, true);
  assert.equal(prog.gradingLabel, 'Auto-graded');

  // Empty paper guard
  const emptyProg = analytics.computeExamPaperProgress([], {}, new Map());
  assert.equal(emptyProg.status, 'not_started');
  assert.equal(emptyProg.grade, null);
  assert.equal(emptyProg.isGradeA, false);
});

test('computeExamAidStats computes closed-book independence %, recall gaps, and open-book exemption', () => {
  const empty = analytics.computeExamAidStats([], {}, []);
  assert.equal(empty.independencePct, null);
  assert.deepEqual(empty.recallGaps, []);

  const catalog = [
    { courseId: 'econ-2522', code: 'EXC 3420', shortTitle: 'Economics I', topics: [{ id: '1', title: 'Markets' }, { id: '2', title: 'Monopoly' }] },
    { courseId: 'prog-3021', code: 'EBA 3400', shortTitle: 'Python', topics: [{ id: '1', title: 'Pandas' }] },
  ];
  const attempts = [
    // Closed-book clean
    { profile: 'exam', courseId: 'econ-2522', topicId: '1', hintsUsed: 0, refUsed: false, refSec: 0 },
    // Closed-book used ref + 1 hint -> not clean, creates recall gap
    { profile: 'exam', courseId: 'econ-2522', topicId: '2', hintsUsed: 1, refUsed: true, refSec: 120 },
    // Open-book (prog-3021) used ref with 0 hints -> excluded from closed-book denominator, clean for overall
    { profile: 'exam', courseId: 'prog-3021', topicId: '1', hintsUsed: 0, refUsed: true, refSec: 45 },
    // Non-exam attempt ignored
    { profile: 'learning', courseId: 'econ-2522', topicId: '1', hintsUsed: 3, refUsed: true, refSec: 200 },
  ];
  const examResults = {
    'econ-2522:E25F': {
      courseId: 'econ-2522',
      attemptHistory: [
        { sessionId: 'a1', pct: 82, completedAt: '2026-05-01T10:00:00Z', hintsUsed: 0, refQCount: 0, refSec: 0 },
        { sessionId: 'a2', pct: 76, completedAt: '2026-05-02T10:00:00Z', hintsUsed: 1, refQCount: 1, refSec: 60 },
      ],
    },
  };

  const aid = analytics.computeExamAidStats(attempts, examResults, catalog);
  assert.equal(aid.examQTotal, 3);
  assert.equal(aid.closedBookQTotal, 2);
  assert.equal(aid.closedBookQClean, 1);
  assert.equal(aid.independencePct, 50); // 1/2 closed-book clean
  assert.equal(aid.sitCount, 2);
  assert.equal(aid.cleanSitCount, 1);
  assert.equal(aid.refQs, 2); // max(examRefQs=2, sitRefQs=1)
  assert.equal(aid.refSec, 165); // 120 + 45
  assert.equal(aid.hintsTotal, 1);
  assert.equal(aid.recallGaps[0].topicTitle, 'Monopoly'); // highest weight (1*2 + 1 = 3)
  assert.equal(aid.recallGaps[0].courseCode, 'EXC 3420');

  // Fallback to clean sits when only examResults exist (no per-question attempts)
  const sitsOnly = analytics.computeExamAidStats([], {
    'econ-2522:E24S': { courseId: 'econ-2522', bestHintsUsed: 0, bestRefQCount: 0 },
    'econ-2522:E24F': { courseId: 'econ-2522', bestHintsUsed: 2, bestRefQCount: 1, bestRefSec: 90 },
  }, catalog);
  assert.equal(sitsOnly.sitCount, 2);
  assert.equal(sitsOnly.cleanSitCount, 1);
  assert.equal(sitsOnly.independencePct, 50);
  assert.equal(sitsOnly.hintsTotal, 2);
  assert.equal(sitsOnly.refSec, 90);
});

// =============================================================================
// 7. Time-Series Bucketing & Chart Axis Scaling (metrics-charts.js helpers)
// =============================================================================
test('isoWeekKey anchors any weekday to Monday and handles invalid dates safely', () => {
  assert.equal(analytics.isoWeekKey('2026-05-11'), '2026-05-11'); // Mon
  assert.equal(analytics.isoWeekKey('2026-05-14'), '2026-05-11'); // Thu
  assert.equal(analytics.isoWeekKey('2026-05-17'), '2026-05-11'); // Sun
  assert.equal(analytics.isoWeekKey('not-a-date'), 'not-a-date');
});

test('aggregateDailyBuckets aggregates daily, weekly, and monthly weighted metrics cleanly', () => {
  assert.deepEqual(analytics.aggregateDailyBuckets([], 'daily', 14), []);

  const series = [
    { day: '2026-05-11', activeMin: 60, screenMin: 80, offScreenMin: 10, highMin: 40, medMin: 20, lowMin: 0, attempts: 2, adjustedUnits: 3.0, avgPaceRatio: 1.0, upi: 80, accuracyPct: 80, efficiencyPct: 75, byCourseMin: { econ: 60 } },
    { day: '2026-05-12', isToday: true, activeMin: 30, screenMin: 40, offScreenMin: 5, highMin: 10, medMin: 10, lowMin: 10, attempts: 4, adjustedUnits: 5.0, avgPaceRatio: 1.3, upi: 110, accuracyPct: 95, efficiencyPct: 75, byCourseMin: { econ: 20, math: 10 } },
    { day: '2026-04-15', activeMin: 45, screenMin: 90, offScreenMin: 0, highMin: 0, medMin: 45, lowMin: 0, attempts: 1, adjustedUnits: 1.5, avgPaceRatio: 0.9, upi: 70, accuracyPct: 70, efficiencyPct: 50, byCourseMin: { math: 45 } },
  ];

  const daily = analytics.aggregateDailyBuckets(series, 'daily', 2);
  assert.equal(daily.length, 2);
  assert.equal(daily[1].key, '2026-05-12');
  assert.equal(daily[1].isCurrent, true);
  assert.match(daily[1].tooltipTitle, /TODAY$/);

  const weekly = analytics.aggregateDailyBuckets(series, 'weekly', 14);
  assert.equal(weekly.length, 2);
  const wkMay = weekly[1];
  assert.equal(wkMay.key, '2026-05-11');
  assert.equal(wkMay.isCurrent, true);
  assert.equal(wkMay.activeMin, 90);
  assert.equal(wkMay.screenMin, 120);
  assert.equal(wkMay.efficiencyPct, 75);
  assert.equal(wkMay.attempts, 6);
  // Attempt-weighted UPI: (80*2 + 110*4) / 6 = 100
  assert.equal(wkMay.upi, 100);
  // Attempt-weighted pace: (1.0*2 + 1.3*4) / 6 = 1.2
  assert.equal(wkMay.paceRatio, 1.2);
  assert.deepEqual(wkMay.byCourseMin, { econ: 80, math: 10 });

  const monthly = analytics.aggregateDailyBuckets(series, 'monthly', 90);
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].key, '2026-04');
  assert.equal(monthly[1].key, '2026-05');
  assert.equal(monthly[1].isCurrent, true);
});

test('computeNiceAxisMax rounds up cleanly across magnitudes and respects floor', () => {
  assert.equal(analytics.computeNiceAxisMax(0, 1), 1.2);
  assert.equal(analytics.computeNiceAxisMax(1.1, 1), 1.2);
  assert.equal(analytics.computeNiceAxisMax(1.5, 1), 2);
  assert.equal(analytics.computeNiceAxisMax(2.6, 1), 3);
  assert.equal(analytics.computeNiceAxisMax(4.2, 1), 5);
  assert.equal(analytics.computeNiceAxisMax(6.1, 1), 7.5);
  assert.equal(analytics.computeNiceAxisMax(8.4, 1), 10);
  assert.equal(analytics.computeNiceAxisMax(42, 5), 50);
  assert.equal(analytics.computeNiceAxisMax(0.2, 5), 5);
});
