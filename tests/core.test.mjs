import test from 'node:test';
import assert from 'node:assert/strict';

import fsrs from '../app/public/js/core/fsrs.js';
import grading from '../app/public/js/core/grading.js';
import schedule from '../app/public/js/core/schedule.js';

const BASE_MS = Date.parse('2026-05-01T10:00:00.000Z');
const DAY_MS = 86_400_000;

// =============================================================================
// 1. UMD-lite dual-runtime export contract
// =============================================================================
test('UMD-lite modules populate globalThis.StudyCore and export identical functions', () => {
  assert.ok(globalThis.StudyCore, 'globalThis.StudyCore should be attached');
  assert.equal(globalThis.StudyCore.updateFsrs5Card, fsrs.updateFsrs5Card);
  assert.equal(globalThis.StudyCore.parseWiseflowNumber, grading.parseWiseflowNumber);
  assert.equal(globalThis.StudyCore.deriveSleepWindow, schedule.deriveSleepWindow);
  assert.equal(globalThis.StudyCore.computeClientStudyEstimate, schedule.computeClientStudyEstimate);
});

// =============================================================================
// 2. FSRS-5 scheduling, retention, overrides & cognitive load (fsrs.js)
// =============================================================================
test('FSRS-5 retrievability equals 1.0 at t=0, 0.9 at t=S, and decreases monotonically', () => {
  assert.equal(fsrs.computeFsrsRetrievability(10, 0), 1);
  assert.ok(Math.abs(fsrs.computeFsrsRetrievability(10, 10) - 0.9) < 1e-12);
  assert.ok(Math.abs(fsrs.computeFsrsRetrievability(3.2, 3.2) - 0.9) < 1e-12);
  const r1 = fsrs.computeFsrsRetrievability(5, 1);
  const r5 = fsrs.computeFsrsRetrievability(5, 5);
  const r20 = fsrs.computeFsrsRetrievability(5, 20);
  assert.ok(r1 > r5 && r5 > r20 && r20 > 0);
  // Floors invalid/tiny stability and negative elapsed days safely
  assert.equal(fsrs.computeFsrsRetrievability(0, -5), 1);
});

test('FSRS-5 first-review initialization scales stability across Again/Hard/Good/Easy', () => {
  const again = fsrs.updateFsrs5Card(null, 1, BASE_MS);
  const hard = fsrs.updateFsrs5Card(null, 2, BASE_MS);
  const good = fsrs.updateFsrs5Card(null, 3, BASE_MS);
  const easy = fsrs.updateFsrs5Card(null, 4, BASE_MS);

  assert.equal(again.stability, 0.4);
  assert.equal(again.lapses, 1);
  assert.equal(again.scheduledDays, 0.02);

  assert.equal(hard.stability, 1.2);
  assert.equal(good.stability, 3.2);
  assert.equal(easy.stability, 7.5);
  assert.equal(easy.lapses, 0);

  assert.ok(again.stability < hard.stability);
  assert.ok(hard.stability < good.stability);
  assert.ok(good.stability < easy.stability);
  assert.ok(again.difficulty > hard.difficulty && hard.difficulty > good.difficulty && good.difficulty > easy.difficulty);
});

test('FSRS-5 subsequent review grows stability across Hard < Good < Easy and lapses on Again', () => {
  const first = fsrs.updateFsrs5Card(null, 3, BASE_MS);
  const reviewAt = BASE_MS + 3 * DAY_MS;

  const again = fsrs.updateFsrs5Card(first, 1, reviewAt);
  const hard = fsrs.updateFsrs5Card(first, 2, reviewAt);
  const good = fsrs.updateFsrs5Card(first, 3, reviewAt);
  const easy = fsrs.updateFsrs5Card(first, 4, reviewAt);

  assert.equal(again.reps, 2);
  assert.equal(again.lapses, 1);
  assert.ok(again.stability < first.stability, 'Again lapse should reduce stability');
  assert.equal(again.scheduledDays, 0.04);

  assert.ok(hard.stability > first.stability, 'Hard recall should still grow stability');
  assert.ok(good.stability > hard.stability, 'Good should grow more than Hard');
  assert.ok(easy.stability > good.stability, 'Easy should grow more than Good');
  assert.equal(good.due, new Date(reviewAt + good.scheduledDays * DAY_MS).toISOString());
});

test('FSRS-5 caps stability at 365 days and clamps difficulty inside [1, 10]', () => {
  let card = fsrs.updateFsrs5Card(null, 4, BASE_MS);
  let clock = BASE_MS;
  for (let i = 0; i < 12; i++) {
    clock += card.scheduledDays * DAY_MS;
    card = fsrs.updateFsrs5Card(card, 4, clock);
  }
  assert.ok(card.stability <= 365, `Expected stability <= 365, got ${card.stability}`);
  assert.ok(card.difficulty >= 1 && card.difficulty <= 10);
});

test('applyDifficultyOverrideFsrs scales intervals cleanly across Again/Hard/Good/Easy', () => {
  const prev = { reps: 2, stability: 4, scheduledDays: 4, lastGrade: 3, due: new Date(BASE_MS).toISOString() };

  const rAgain = fsrs.applyDifficultyOverrideFsrs(prev, 1, 'done', BASE_MS);
  assert.equal(rAgain.scheduledDays, 1);
  assert.equal(rAgain.status, 'revisit');
  assert.equal(rAgain.personalDifficulty, 3);

  const rHard = fsrs.applyDifficultyOverrideFsrs(prev, 2, 'revisit', BASE_MS);
  assert.equal(rHard.scheduledDays, 2); // round(4 * 0.6) = 2
  assert.equal(rHard.status, 'done');
  assert.equal(rHard.personalDifficulty, 3);

  const rGood = fsrs.applyDifficultyOverrideFsrs(prev, 3, 'not_started', BASE_MS);
  assert.equal(rGood.scheduledDays, 6); // round(4 * 1.5) = 6
  assert.equal(rGood.status, 'done');
  assert.equal(rGood.personalDifficulty, 2);

  const rEasy = fsrs.applyDifficultyOverrideFsrs(prev, 4, 'done', BASE_MS);
  assert.equal(rEasy.scheduledDays, 10); // round(4 * 2.5) = 10
  assert.equal(rEasy.personalDifficulty, 1);
  assert.equal(rEasy.fsrs.due, new Date(BASE_MS + 10 * DAY_MS).toISOString());
});

test('applyDifficultyOverrideFsrs clamps Hard upper bound at 3d and enforces minimums on fresh cards', () => {
  const highStab = { reps: 5, stability: 20 };
  assert.equal(fsrs.applyDifficultyOverrideFsrs(highStab, 2, 'done', BASE_MS).scheduledDays, 3);

  const freshGood = fsrs.applyDifficultyOverrideFsrs(null, 3, '', BASE_MS);
  const freshEasy = fsrs.applyDifficultyOverrideFsrs(null, 4, '', BASE_MS);
  assert.equal(freshGood.scheduledDays, 3);
  assert.equal(freshGood.fsrs.reps, 1);
  assert.equal(freshEasy.scheduledDays, 7);
});

test('scheduleAttemptFsrs schedules 4d at >=85% mastery and 1d below threshold', () => {
  const pass = fsrs.scheduleAttemptFsrs({ reps: 2 }, 0.85, BASE_MS);
  assert.equal(pass.reps, 3);
  assert.equal(pass.scheduledDays, 4);
  assert.equal(pass.lastGrade, 3);
  assert.equal(pass.due, new Date(BASE_MS + 4 * DAY_MS).toISOString());

  const fail = fsrs.scheduleAttemptFsrs({ reps: 2 }, 0.84, BASE_MS);
  assert.equal(fail.reps, 3);
  assert.equal(fail.scheduledDays, 1);
  assert.equal(fail.lastGrade, 1);
  assert.equal(fail.due, new Date(BASE_MS + 1 * DAY_MS).toISOString());
});

test('suggestFsrsGrade maps accuracy, pace, hints, and beatAi to grades 1..4', () => {
  assert.equal(fsrs.suggestFsrsGrade({ qualityAccuracy: 0.5, effectiveSec: 60, aiParSec: 120 }), 1);
  assert.equal(fsrs.suggestFsrsGrade({ qualityAccuracy: 0.9, effectiveSec: 60, aiParSec: 120, hintsUsed: 1 }), 2);
  assert.equal(fsrs.suggestFsrsGrade({ qualityAccuracy: 0.9, effectiveSec: 160, aiParSec: 120 }), 2);
  assert.equal(fsrs.suggestFsrsGrade({ qualityAccuracy: 0.95, effectiveSec: 110, aiParSec: 120, beatAi: true }), 3);
  assert.equal(fsrs.suggestFsrsGrade({ qualityAccuracy: 1.0, effectiveSec: 90, aiParSec: 120, beatAi: true }), 4);
});

test('isFsrsDue checks ISO due boundary accurately', () => {
  const nowIso = '2026-05-05T12:00:00.000Z';
  assert.equal(fsrs.isFsrsDue({ due: '2026-05-05T11:59:59.000Z' }, nowIso), true);
  assert.equal(fsrs.isFsrsDue({ due: '2026-05-05T12:00:00.000Z' }, nowIso), true);
  assert.equal(fsrs.isFsrsDue({ due: '2026-05-05T12:00:01.000Z' }, nowIso), false);
  assert.equal(fsrs.isFsrsDue(null, nowIso), false);
  assert.equal(fsrs.isFsrsDue({}, nowIso), false);
});

test('effectiveDifficulty and effectiveDlpfc escalate on lapse and chunk down on FSRS mastery', () => {
  const wfQ = { kind: 'wiseflow', difficulty: 2, wiseflowFields: [{}, {}, {}, {}] }; // base tier = 3
  assert.deepEqual(fsrs.effectiveDlpfc(wfQ, null), { base: 3, tier: 3, chunked: false });

  // Single good rep on High DLPFC -> chunks down to tier 2
  const rep1 = fsrs.effectiveDlpfc(wfQ, { status: 'done', fsrs: { reps: 1, stability: 3.2, lastGrade: 3 } });
  assert.deepEqual(rep1, { base: 3, tier: 2, chunked: true });

  // Consolidated mastery (reps >= 2, stability >= 5.0) -> chunks down to tier 1
  const mastered = fsrs.effectiveDlpfc(wfQ, { status: 'done', fsrs: { reps: 2, stability: 6.5, lastGrade: 3 } });
  assert.deepEqual(mastered, { base: 3, tier: 1, chunked: true });

  // Lapse escalates an easy MCQ from base 1 to tier 2, and non-MCQ to tier 3
  const mcq = { kind: 'mcq', difficulty: 1 };
  assert.deepEqual(fsrs.effectiveDlpfc(mcq, { status: 'revisit', fsrs: { lastGrade: 1 } }), {
    base: 1,
    tier: 2,
    chunked: false,
  });
  assert.equal(fsrs.effectiveDifficulty({ difficulty: 2 }, { fsrs: { lastGrade: 1 } }), 3);
  assert.equal(fsrs.effectiveDifficulty({ difficulty: 2 }, { fsrs: { lastGrade: 4 } }), 1);
  assert.equal(fsrs.effectiveDifficulty({ difficulty: 2 }, { personalDifficulty: 1, fsrs: { lastGrade: 1 } }), 1);
});

// =============================================================================
// 3. WISEflow FLOWmulti numeric parsing, tolerance grading & ECTS scale (grading.js)
// =============================================================================
test('parseWiseflowNumber accepts dot decimals, negative cash flows, currency/units, and US thousand commas', () => {
  assert.deepEqual(grading.parseWiseflowNumber('-200000'), { ok: true, value: -200000 });
  assert.deepEqual(grading.parseWiseflowNumber('-200,000.50'), { ok: true, value: -200000.5 });
  assert.deepEqual(grading.parseWiseflowNumber('40,700'), { ok: true, value: 40700 });
  assert.deepEqual(grading.parseWiseflowNumber('1,520,000'), { ok: true, value: 1520000 });
  assert.deepEqual(grading.parseWiseflowNumber('kr 12 500.25'), { ok: true, value: 12500.25 });
  assert.deepEqual(grading.parseWiseflowNumber('1500.75 kr'), { ok: true, value: 1500.75 });
  assert.deepEqual(grading.parseWiseflowNumber('£1,250.00'), { ok: true, value: 1250 });
  assert.deepEqual(grading.parseWiseflowNumber('+12.5%'), { ok: true, value: 12.5 });
  assert.deepEqual(grading.parseWiseflowNumber('0'), { ok: true, value: 0 });
});

test('parseWiseflowNumber rejects empty input, decimal commas, accounting parentheses, and invalid strings', () => {
  assert.deepEqual(grading.parseWiseflowNumber(''), { ok: false, empty: true });
  assert.deepEqual(grading.parseWiseflowNumber('   '), { ok: false, empty: true });
  assert.deepEqual(grading.parseWiseflowNumber(null), { ok: false, empty: true });

  // Decimal commas MUST be flagged as commaError per BI WISEflow Title Page
  assert.deepEqual(grading.parseWiseflowNumber('7,20'), { ok: false, commaError: true });
  assert.deepEqual(grading.parseWiseflowNumber('-4857,25'), { ok: false, commaError: true });
  assert.deepEqual(grading.parseWiseflowNumber('216528,93'), { ok: false, commaError: true });

  // Accounting parentheses MUST be flagged as parensError (use leading minus instead)
  assert.deepEqual(grading.parseWiseflowNumber('(500)'), { ok: false, parensError: true });
  assert.deepEqual(grading.parseWiseflowNumber('( 200,000.50 )'), { ok: false, parensError: true });

  // Malformed formats
  assert.deepEqual(grading.parseWiseflowNumber('12.34.56'), { ok: false, invalidFormat: true });
  assert.deepEqual(grading.parseWiseflowNumber('--50'), { ok: false, invalidFormat: true });
  assert.deepEqual(grading.parseWiseflowNumber('NPV'), { ok: false, invalidFormat: true });
});

test('gradeSingleWiseflowField enforces exact ±2% relative tolerance boundary', () => {
  const field = { id: 'npv', expected: 1000, points: 5 }; // band = max(0.02 * 1000, 0.02) = 20

  const atUpperBound = grading.gradeSingleWiseflowField(field, '1020');
  assert.equal(atUpperBound.passed, true);
  assert.equal(atUpperBound.earned, 5);
  assert.equal(atUpperBound.exact, false);

  const atLowerBound = grading.gradeSingleWiseflowField(field, '980');
  assert.equal(atLowerBound.passed, true);

  const justOutsideUpper = grading.gradeSingleWiseflowField(field, '1020.01');
  assert.equal(justOutsideUpper.passed, false);
  assert.equal(justOutsideUpper.earned, 0);

  const justOutsideLower = grading.gradeSingleWiseflowField(field, '979.99');
  assert.equal(justOutsideLower.passed, false);
});

test('gradeSingleWiseflowField uses absTol when expected value is zero or near zero', () => {
  const zeroField = { id: 'net', expected: 0, absTol: 0.05, points: 2 };
  assert.equal(grading.gradeSingleWiseflowField(zeroField, '0').passed, true);
  assert.equal(grading.gradeSingleWiseflowField(zeroField, '0.05').passed, true);
  assert.equal(grading.gradeSingleWiseflowField(zeroField, '-0.05').passed, true);
  assert.equal(grading.gradeSingleWiseflowField(zeroField, '0.06').passed, false);
  assert.equal(grading.gradeSingleWiseflowField(zeroField, '0.05').pctDiff, 0);

  const defaultAbsZero = { id: 'z2', expected: 0, points: 1 }; // default absTol = 0.02
  assert.equal(grading.gradeSingleWiseflowField(defaultAbsZero, '0.02').passed, true);
  assert.equal(grading.gradeSingleWiseflowField(defaultAbsZero, '0.025').passed, false);
});

test('gradeSingleWiseflowField rejects wrong-sign negative cash flows and supports altExpected', () => {
  const cf0 = { id: 'cf0', expected: -200000, points: 3 };
  assert.equal(grading.gradeSingleWiseflowField(cf0, '200000').passed, false);
  assert.equal(grading.gradeSingleWiseflowField(cf0, '(200000)').parensError, true);
  assert.equal(grading.gradeSingleWiseflowField(cf0, '-200000').passed, true);
  assert.equal(grading.gradeSingleWiseflowField(cf0, '-196000').passed, true); // within -2% of -200,000

  const withAlt = { id: 'dep', expected: -12500, altExpected: [12500], points: 2 };
  const altRes = grading.gradeSingleWiseflowField(withAlt, '12500');
  assert.equal(altRes.passed, true);
  assert.equal(altRes.matchedTarget, 12500);
});

test('gradeSingleWiseflowField grades choice slots accurately including index 0 and blank', () => {
  const choice = { id: 'decision', type: 'choice', answerIndex: 0, options: ['Accept', 'Reject'], points: 4 };
  const ok = grading.gradeSingleWiseflowField(choice, '0');
  assert.equal(ok.passed, true);
  assert.equal(ok.earned, 4);
  assert.equal(ok.expectedLabel, 'Accept');

  const wrong = grading.gradeSingleWiseflowField(choice, '1');
  assert.equal(wrong.passed, false);
  assert.equal(wrong.earned, 0);

  const blank = grading.gradeSingleWiseflowField(choice, '');
  assert.equal(blank.passed, false);
  assert.equal(blank.picked, null);
});

test('evaluateWiseflowSheet aggregates multi-slot accounting worksheet points and accuracy', () => {
  const q = {
    wiseflowFields: [
      { id: 'cf0', expected: -200000, points: 3 },
      { id: 'pv', expected: 216528.93, points: 4 },
      { id: 'npv', expected: 16528.93, points: 3 },
      { id: 'verdict', type: 'choice', answerIndex: 0, options: ['Accept', 'Reject'], points: 2 },
    ],
  };

  const full = grading.evaluateWiseflowSheet(q, {
    wiseflow: { cf0: '-200,000', pv: '216528.93', npv: '16530', verdict: 0 },
  });
  assert.equal(full.earned, 12);
  assert.equal(full.total, 12);
  assert.equal(full.accuracy, 1);

  const partial = grading.evaluateWiseflowSheet(q, {
    wiseflow: { cf0: '200000', pv: '216528,93', npv: '16528.93', verdict: 0 },
  });
  assert.equal(partial.earned, 5); // npv (3) + verdict (2)
  assert.equal(partial.total, 12);
  assert.equal(partial.details.cf0.passed, false);
  assert.equal(partial.details.pv.commaError, true);
  assert.ok(Math.abs(partial.accuracy - 5 / 12) < 1e-12);

  // Empty fields guard
  assert.deepEqual(grading.evaluateWiseflowSheet({ wiseflowFields: [] }, {}), {
    earned: 0,
    total: 0,
    accuracy: 0,
    details: {},
  });
});

test('evaluateNumericCheck handles IEEE-754 tolerance edges and invalid strings', () => {
  // 1.02 - 1.00 = 0.020000000000000018 in IEEE-754; +1e-9 ensures boundary acceptance
  assert.equal(grading.evaluateNumericCheck('1.02', 1.0, 0.02, 0.02).passed, true);
  assert.equal(grading.evaluateNumericCheck('1.03', 1.0, 0.02, 0.02).passed, false);
  assert.equal(grading.evaluateNumericCheck('7,50', 7.5).passed, false);
  assert.equal(grading.evaluateNumericCheck('7,50', 7.5).parsed.commaError, true);
});

test('formatWfNum formats integers, 2-decimal floats, and 3-decimal floats cleanly', () => {
  assert.equal(grading.formatWfNum(200000), '200,000');
  assert.equal(grading.formatWfNum(-16528.9), '-16,528.90');
  assert.equal(grading.formatWfNum(0.125), '0.125');
  assert.equal(grading.formatWfNum('not-a-num'), 'not-a-num');
});

test('gradeFromPct maps Norwegian ECTS boundaries A/B/C/D/E/F and clamps out-of-range scores', () => {
  assert.equal(grading.gradeFromPct(85).letter, 'A');
  assert.equal(grading.gradeFromPct(85).toA, 0);
  assert.equal(grading.gradeFromPct(84.9).letter, 'B');
  assert.equal(grading.gradeFromPct(84.9).toA, 1);
  assert.equal(grading.gradeFromPct(77).letter, 'B');
  assert.equal(grading.gradeFromPct(76.9).letter, 'C');
  assert.equal(grading.gradeFromPct(65).letter, 'C');
  assert.equal(grading.gradeFromPct(50).letter, 'D');
  assert.equal(grading.gradeFromPct(40).letter, 'E');
  assert.equal(grading.gradeFromPct(39.9).letter, 'F');
  assert.equal(grading.gradeFromPct(120).pct, 100);
  assert.equal(grading.gradeFromPct(-10).pct, 0);
  assert.equal(grading.gradeFromPct(null), null);
  assert.equal(grading.gradeFromPct(NaN), null);
});

// =============================================================================
// 4. Circadian sleep window, study budget & block timing state (schedule.js)
// =============================================================================
test('parseHmToMins and minsToHm handle valid times, invalid fallbacks, and midnight wrap-around', () => {
  assert.equal(schedule.parseHmToMins('07:30'), 450);
  assert.equal(schedule.parseHmToMins('00:00'), 0);
  assert.equal(schedule.parseHmToMins('23:59'), 1439);
  assert.equal(schedule.parseHmToMins('24:00', 480), 480);
  assert.equal(schedule.parseHmToMins('bad', 420), 420);

  assert.equal(schedule.minsToHm(0), '00:00');
  assert.equal(schedule.minsToHm(-30), '23:30');
  assert.equal(schedule.minsToHm(-1470), '23:30');
  assert.equal(schedule.minsToHm(1440), '00:00');
  assert.equal(schedule.minsToHm(1470), '00:30');
});

test('deriveSleepWindow wraps bedtime and studyEnd cleanly across midnight', () => {
  // Standard 07:30 wake, 8h sleep -> bed 23:30, study 08:00–23:00
  assert.deepEqual(schedule.deriveSleepWindow('07:30', 8), {
    wakeTime: '07:30',
    bedTime: '23:30',
    studyStart: '08:00',
    studyEnd: '23:00',
    sleepHours: 8,
  });

  // Exact midnight bedtime: 08:00 wake, 8h sleep -> bed 00:00, studyEnd wraps to 23:30
  assert.deepEqual(schedule.deriveSleepWindow('08:00', 8), {
    wakeTime: '08:00',
    bedTime: '00:00',
    studyStart: '08:30',
    studyEnd: '23:30',
    sleepHours: 8,
  });

  // Late sleeper past midnight: 09:00 wake, 8h sleep -> bed 01:00, studyEnd 00:30
  assert.deepEqual(schedule.deriveSleepWindow('09:00', 8), {
    wakeTime: '09:00',
    bedTime: '01:00',
    studyStart: '09:30',
    studyEnd: '00:30',
    sleepHours: 8,
  });

  // Early riser: 05:00 wake, 9h sleep -> bed 20:00, study 05:30–19:30
  assert.deepEqual(schedule.deriveSleepWindow('05:00', 9), {
    wakeTime: '05:00',
    bedTime: '20:00',
    studyStart: '05:30',
    studyEnd: '19:30',
    sleepHours: 9,
  });

  // Sleep hours clamped to [6, 10] and invalid wakeTime falls back to 07:30
  assert.equal(schedule.deriveSleepWindow('invalid', 3).sleepHours, 6);
  assert.equal(schedule.deriveSleepWindow('invalid', 3).wakeTime, '07:30');
  assert.equal(schedule.deriveSleepWindow('07:00', 14).sleepHours, 10);
});

test('computeClientStudyEstimate adjusts budget for paid work hours and clamps extremes', () => {
  // 4 courses -> baseAcad = 32; 8h class -> rawSelf = 24; 0h work -> penalty 0 -> 24h
  assert.deepEqual(schedule.computeClientStudyEstimate(0, 8, 4), {
    recommendedStudyHours: 24,
    weeklyWorkHours: 0,
    weeklyClassHours: 8,
    totalCommittedHours: 32,
  });

  // First 6h of work carry 0 penalty
  assert.equal(schedule.computeClientStudyEstimate(6, 8, 4).recommendedStudyHours, 24);

  // 16h work -> (16 - 6) * 0.6 = 6h reduction -> 18h study
  const partTime = schedule.computeClientStudyEstimate(16, 8, 4);
  assert.equal(partTime.recommendedStudyHours, 18);
  assert.equal(partTime.totalCommittedHours, 42);

  // Heavy 50h workweek clamps study floor at 5h/week (never drops below 5)
  const heavyWork = schedule.computeClientStudyEstimate(50, 10, 4);
  assert.equal(heavyWork.recommendedStudyHours, 5);

  // Extreme inputs clamp workH <= 60, classH <= 35, rec <= 36
  const maxInputs = schedule.computeClientStudyEstimate(90, 50, 10);
  assert.equal(maxInputs.weeklyWorkHours, 60);
  assert.equal(maxInputs.weeklyClassHours, 35);
  assert.equal(maxInputs.recommendedStudyHours, 5);

  // Heavy course load with 0 class & 0 work caps at 36h self-study
  const capTop = schedule.computeClientStudyEstimate(0, 0, 8);
  assert.equal(capTop.recommendedStudyHours, 36);
});

test('getCircadianAutoTarget switches High -> Med on 4.5h daily cap and routes afternoon/evening windows', () => {
  assert.equal(schedule.getCircadianAutoTarget(9, 0).mode, 'high_dlpfc');
  assert.equal(schedule.getCircadianAutoTarget(14, 269).mode, 'high_dlpfc');

  const capped = schedule.getCircadianAutoTarget(14, 270);
  assert.equal(capped.mode, 'med_dlpfc');
  assert.ok(capped.explain);

  assert.equal(schedule.getCircadianAutoTarget(15, 0).mode, 'med_dlpfc');
  assert.equal(schedule.getCircadianAutoTarget(17, 0).mode, 'med_dlpfc');
  assert.equal(schedule.getCircadianAutoTarget(18, 0).mode, 'low_dlpfc');
  assert.equal(schedule.getCircadianAutoTarget(23, 0).mode, 'low_dlpfc');
  assert.equal(schedule.getCircadianAutoTarget(5, 0).mode, 'low_dlpfc');
});

test('computeBlockTimingState classifies past, live_now, upcoming, and fallback blocks', () => {
  const block = {
    eventId: 'blk-1',
    startIso: '2026-05-01T10:00:00.000Z',
    endIso: '2026-05-01T10:50:00.000Z',
  };

  assert.equal(schedule.computeBlockTimingState(block, Date.parse('2026-05-01T09:59:59.000Z')).timingState, 'upcoming');
  assert.equal(schedule.computeBlockTimingState(block, Date.parse('2026-05-01T10:00:00.000Z')).timingState, 'live_now');
  assert.equal(schedule.computeBlockTimingState(block, Date.parse('2026-05-01T10:49:59.000Z')).timingState, 'live_now');
  assert.equal(schedule.computeBlockTimingState(block, Date.parse('2026-05-01T10:50:00.000Z')).timingState, 'past');

  // Missing timestamps fall back to block.timingState only when enabled
  assert.equal(schedule.computeBlockTimingState({ timingState: 'live_now' }, BASE_MS, true).timingState, 'live_now');
  assert.equal(schedule.computeBlockTimingState({ timingState: 'live_now' }, BASE_MS, false).timingState, 'upcoming');
});

test('evaluateBlockEffectiveState detects 14-day rollover study debt and honors completions, dismissals, and sandbox overrides', () => {
  const pastStudy = {
    eventId: 'evt-debt',
    blockKind: 'study_block',
    startIso: new Date(BASE_MS - 2 * DAY_MS - 3_600_000).toISOString(),
    endIso: new Date(BASE_MS - 2 * DAY_MS).toISOString(),
  };

  // Uncompleted study block within 14 days -> isDebt = true
  const stDebt = schedule.evaluateBlockEffectiveState(pastStudy, { nowMs: BASE_MS });
  assert.equal(stDebt.timingState, 'past');
  assert.equal(stDebt.isDebt, true);

  // Older than 14 days -> debt expires
  const stExpired = schedule.evaluateBlockEffectiveState(pastStudy, { nowMs: BASE_MS + 13 * DAY_MS });
  assert.equal(stExpired.isDebt, false);

  // Optional study block or class lecture is never study debt
  assert.equal(schedule.evaluateBlockEffectiveState({ ...pastStudy, optional: true }, { nowMs: BASE_MS }).isDebt, false);
  assert.equal(schedule.evaluateBlockEffectiveState({ ...pastStudy, blockKind: 'class_session' }, { nowMs: BASE_MS }).isDebt, false);

  // Local completion clears debt and records completedEarly
  const stDone = schedule.evaluateBlockEffectiveState(pastStudy, {
    nowMs: BASE_MS,
    localStatus: { completed: { 'evt-debt': { at: '2026-04-28T08:00:00.000Z', early: true } } },
  });
  assert.equal(stDone.completed, true);
  assert.equal(stDone.completedEarly, true);
  assert.equal(stDone.isDebt, false);

  // Local dismissal clears debt when uncompleted
  const stDismissed = schedule.evaluateBlockEffectiveState(pastStudy, {
    nowMs: BASE_MS,
    localStatus: { dismissed: { 'evt-debt': '2026-05-01T00:00:00.000Z' } },
  });
  assert.equal(stDismissed.dismissed, true);
  assert.equal(stDismissed.isDebt, false);

  // Sandbox override takes precedence over local status
  const stSandbox = schedule.evaluateBlockEffectiveState(pastStudy, {
    nowMs: BASE_MS,
    localStatus: { completed: { 'evt-debt': { at: '2026-04-29T08:00:00.000Z', early: false } } },
    sandboxOverride: { hasCompleted: true, completedValue: false },
  });
  assert.equal(stSandbox.completed, false);
  assert.equal(stSandbox.isDebt, true);
});

test('inferBlockDlpfcMode resolves explicit mode, summary tags, recall_sprint, start hour, and fallback', () => {
  assert.deepEqual(schedule.inferBlockDlpfcMode({ dlpfcMode: 'high_dlpfc' }), { mode: 'high_dlpfc', tier: 3 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ summary: '[Low DLPFC] Flashcards' }), { mode: 'low_dlpfc', tier: 1 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ blockKind: 'recall_sprint', startLabel: '09:00' }), { mode: 'low_dlpfc', tier: 1 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ summary: 'EXC 3420 Practice', startLabel: '10:00' }), { mode: 'high_dlpfc', tier: 3 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ summary: 'EXC 3420 Practice', startLabel: '16:00' }), { mode: 'med_dlpfc', tier: 2 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ summary: 'EXC 3420 Practice', startLabel: '20:00' }), { mode: 'low_dlpfc', tier: 1 });
  assert.deepEqual(schedule.inferBlockDlpfcMode({ summary: 'Unscheduled block' }, 'high_dlpfc'), { mode: 'high_dlpfc', tier: 3 });
});

test('formatDurationShort renders minutes and hours compactly', () => {
  assert.equal(schedule.formatDurationShort(0), '0m');
  assert.equal(schedule.formatDurationShort(-10), '0m');
  assert.equal(schedule.formatDurationShort(50), '50m');
  assert.equal(schedule.formatDurationShort(60), '1h');
  assert.equal(schedule.formatDurationShort(95), '1h 35m');
});

test('FSRS clampFsrsGrade and malformed lastReview timestamps fail safe without NaN', () => {
  assert.equal(fsrs.clampFsrsGrade(0), 3);
  assert.equal(fsrs.clampFsrsGrade(-5), 1);
  assert.equal(fsrs.clampFsrsGrade(99), 4);
  assert.equal(fsrs.clampFsrsGrade('bad'), 3);

  const recovered = fsrs.updateFsrs5Card({ reps: 2, stability: 4, difficulty: 5, lastReview: 'not-a-date' }, 3, BASE_MS);
  assert.equal(recovered.reps, 3);
  assert.ok(Number.isFinite(recovered.stability) && recovered.stability > 4);
  assert.ok(Number.isFinite(Date.parse(recovered.due)));
});

test('FSRS-5 Python parity check matches app/analytics.py update_fsrs_card formula', () => {
  // Replicate exact second-review math for s=3.2, d=4.6, elapsed=3.2d (R=0.9), grade=3
  const prev = { reps: 1, stability: 3.2, difficulty: 4.6, lapses: 0, lastReview: new Date(BASE_MS).toISOString() };
  const next = fsrs.updateFsrs5Card(prev, 3, BASE_MS + 3.2 * DAY_MS);
  // dNext = 0.85 * 4.6 + 0.15 * 5.2 = 4.69
  assert.equal(next.difficulty, 4.69);
  // growth = 1 + exp(1.45) * (11 - 4.69) * 3.2^(-0.18) * (exp(0.85 * 0.1) - 1)
  const expectedGrowth = 1 + Math.exp(1.45) * (11 - 4.69) * Math.pow(3.2, -0.18) * (Math.exp(0.085) - 1);
  const expectedS = Math.round(3.2 * Math.max(1.15, expectedGrowth) * 100) / 100;
  assert.equal(next.stability, expectedS);
  assert.equal(next.scheduledDays, expectedS);
});

test('parseWiseflowNumber handles negative thousand-grouped values, leading spaces, and rejects scientific notation', () => {
  assert.deepEqual(grading.parseWiseflowNumber('  -1,250,000  '), { ok: true, value: -1250000 });
  assert.deepEqual(grading.parseWiseflowNumber('0.00'), { ok: true, value: 0 });
  assert.deepEqual(grading.parseWiseflowNumber('1e5'), { ok: false, invalidFormat: true });
  assert.deepEqual(grading.parseWiseflowNumber('1,23'), { ok: false, commaError: true });
  assert.deepEqual(grading.parseWiseflowNumber('12,34,567'), { ok: false, commaError: true });
});

test('gradeSingleWiseflowField respects custom relTol/absTol and marks exact within 0.015', () => {
  const tight = { id: 'irr', expected: 12.5, relTol: 0.005, absTol: 0.01, points: 4 }; // band = 0.0625
  const exactHit = grading.gradeSingleWiseflowField(tight, '12.51');
  assert.equal(exactHit.passed, true);
  assert.equal(exactHit.exact, true);

  const looseHit = grading.gradeSingleWiseflowField(tight, '12.56');
  assert.equal(looseHit.passed, true);
  assert.equal(looseHit.exact, false);

  const miss = grading.gradeSingleWiseflowField(tight, '12.60');
  assert.equal(miss.passed, false);
});

test('deriveSleepWindow handles near-midnight wake times and computeClientStudyEstimate handles 0/negative inputs', () => {
  // Wake at 00:15 with 8h sleep -> bed 16:15, studyStart 00:45, studyEnd 15:45
  assert.deepEqual(schedule.deriveSleepWindow('00:15', 8), {
    wakeTime: '00:15',
    bedTime: '16:15',
    studyStart: '00:45',
    studyEnd: '15:45',
    sleepHours: 8,
  });

  // Wake at 23:45 -> studyStart wraps past midnight to 00:15
  assert.deepEqual(schedule.deriveSleepWindow('23:45', 8), {
    wakeTime: '23:45',
    bedTime: '15:45',
    studyStart: '00:15',
    studyEnd: '15:15',
    sleepHours: 8,
  });

  // Negative/zero courseCount, workH, classH clamp cleanly without NaN
  const est = schedule.computeClientStudyEstimate(-10, -5, 0);
  assert.deepEqual(est, {
    recommendedStudyHours: 12,
    weeklyWorkHours: 0,
    weeklyClassHours: 0,
    totalCommittedHours: 12,
  });
});

