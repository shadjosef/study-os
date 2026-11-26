import test from 'node:test';
import assert from 'node:assert/strict';

import fsrs from '../app/public/js/core/fsrs.js';
import analytics from '../app/public/js/core/analytics.js';

const DAY_MS = 86_400_000;

// =============================================================================
// 1. reconcileDayEfficiency — Bug 1 & Bug 2 Production Reconciliation
// =============================================================================
test('reconcileDayEfficiency fixes 2.5h study + 13m browse + 3m AFK collapse (90%, NEVER 0%)', () => {
  // Exact production screenshot scenario:
  // User worked 2.5h (9000s) from synced attempts/sessions/other devices while
  // current browser tab logged 13m App Browse (780s) + 3m AFK Idle (180s) and 0s tab solving.
  const res = analytics.reconcileDayEfficiency({
    activeSec: 9000,
    screenSec: 9060,
    sessAwaySec: 0,
    hasScreenLog: true,
    telemetry: {
      solvingSec: 0,
      readingSec: 0,
      appBrowseSec: 780,
      afkIdleSec: 180,
      extStudySec: 0,
      extDistractSec: 0,
    },
  });

  assert.equal(res.telProdSec, 0);
  assert.equal(res.driftSec, 960);
  assert.equal(res.telTrackedSec, 960);
  assert.equal(res.reconciledProdSec, 9000);
  assert.equal(res.reconciledScreenSec, 9960); // 150m active + 16m browse/AFK = 166m
  assert.equal(res.hasRealScreen, true);
  assert.equal(res.efficiencyPct, 90); // 9000 / 9960 = 90.36% -> 90%, NOT 0% and NOT fabricated 100%
  assert.equal(res.reconciledSolvingSec, 9000); // 2.5h reconciled solving, NOT 0m!
  assert.equal(res.syncedSolvingSec, 9000);

  // Even when screenSec is only the 16m tab time (960s), reconciled screen still includes active + drift
  const resLowScreen = analytics.reconcileDayEfficiency({
    activeSec: 9000,
    screenSec: 960,
    sessAwaySec: 0,
    hasScreenLog: true,
    telemetry: { appBrowseSec: 780, afkIdleSec: 180 },
  });
  assert.equal(resLowScreen.reconciledScreenSec, 9960);
  assert.equal(resLowScreen.efficiencyPct, 90);
});

test('reconcileDayEfficiency preserves null on past days with no screen log and 0% on pure browse', () => {
  // Past day with historical attempts but ZERO screen/telemetry logs -> MUST stay null
  const pastNoScreen = analytics.reconcileDayEfficiency({
    activeSec: 5400,
    screenSec: 0,
    sessAwaySec: 0,
    hasScreenLog: false,
    telemetry: null,
  });
  assert.equal(pastNoScreen.hasRealScreen, false);
  assert.equal(pastNoScreen.efficiencyPct, null);
  assert.equal(pastNoScreen.reconciledProdSec, 5400);
  assert.equal(pastNoScreen.reconciledScreenSec, 5400);

  // Pure browse / AFK with 0 work -> honest 0%
  const pureBrowse = analytics.reconcileDayEfficiency({
    activeSec: 0,
    screenSec: 960,
    sessAwaySec: 0,
    hasScreenLog: true,
    telemetry: { solvingSec: 0, readingSec: 0, appBrowseSec: 780, afkIdleSec: 180 },
  });
  assert.equal(pureBrowse.hasRealScreen, true);
  assert.equal(pureBrowse.reconciledProdSec, 0);
  assert.equal(pureBrowse.reconciledScreenSec, 960);
  assert.equal(pureBrowse.efficiencyPct, 0);
  assert.equal(pureBrowse.reconciledSolvingSec, 0);

  // Reading + Chrome Extension study is NOT misattributed to Solving
  const readingAndExt = analytics.reconcileDayEfficiency({
    activeSec: 0,
    screenSec: 3600,
    hasScreenLog: true,
    telemetry: { solvingSec: 0, readingSec: 1200, extStudySec: 1800, appBrowseSec: 600 },
  });
  assert.equal(readingAndExt.reconciledProdSec, 3000);
  assert.equal(readingAndExt.reconciledScreenSec, 3600);
  assert.equal(readingAndExt.efficiencyPct, 83);
  assert.equal(readingAndExt.reconciledSolvingSec, 0);

  // Session away fallback when no screen log or telemetry exists
  const sessAwayOnly = analytics.reconcileDayEfficiency({
    activeSec: 3600,
    screenSec: 0,
    sessAwaySec: 1200,
    hasScreenLog: false,
    telemetry: null,
  });
  assert.equal(sessAwayOnly.hasRealScreen, true);
  assert.equal(sessAwayOnly.reconciledScreenSec, 4800);
  assert.equal(sessAwayOnly.efficiencyPct, 75);

  // Sub-30s brief noise stays null
  const briefOpen = analytics.reconcileDayEfficiency({
    activeSec: 0,
    screenSec: 15,
    hasScreenLog: false,
    telemetry: { appBrowseSec: 15 },
  });
  assert.equal(briefOpen.efficiencyPct, null);
});

// =============================================================================
// 2. buildOsloHeatmap — 12-Week (84-Day) Oslo Consistency Heatmap
// =============================================================================
test('buildOsloHeatmap builds 84-day grid with streaks, intensity levels, and DST safety', () => {
  // End on 2026-04-15 so the 84-day window crosses Europe/Oslo DST spring-forward (2026-03-29)
  const todayIso = '2026-04-15';
  const series = [
    // Earlier 4-day streak (longest)
    { day: '2026-03-27', activeMin: 30, attempts: 2, upi: 82 },
    { day: '2026-03-28', activeMin: 75, attempts: 5, upi: 90 },
    { day: '2026-03-29', activeMin: 150, attempts: 9, upi: 96 }, // DST switch day
    { day: '2026-03-30', activeMin: 260, attempts: 14, upi: 105 },
    // Current 2-day streak (today inactive, yesterday + day before active)
    { day: '2026-04-13', activeMin: 50, attempts: 3, upi: 88 },
    { day: '2026-04-14', activeMin: 130, attempts: 8, upi: 94, efficiencyPct: 86 },
    { day: '2026-04-15', isToday: true, activeMin: 0, attempts: 0, upi: null },
  ];

  const hm = analytics.buildOsloHeatmap(series, todayIso, 12);
  assert.equal(hm.weeks, 12);
  assert.equal(hm.totalDays, 84);
  assert.equal(hm.cells.length, 84);
  assert.equal(hm.endDay, '2026-04-15');
  assert.equal(hm.startDay, '2026-01-22'); // 83 days before 2026-04-15

  // Every day key in the 84-day window must be unique and strictly increasing (DST safe)
  const uniqueDays = new Set(hm.cells.map((c) => c.day));
  assert.equal(uniqueDays.size, 84);
  assert.ok(hm.cells[83].isToday);

  // Verify intensity levels 0..4
  const byDay = new Map(hm.cells.map((c) => [c.day, c]));
  assert.equal(byDay.get('2026-04-15').level, 0);
  assert.equal(byDay.get('2026-03-27').level, 1); // 30m -> level 1
  assert.equal(byDay.get('2026-03-28').level, 2); // 75m -> level 2
  assert.equal(byDay.get('2026-03-29').level, 3); // 150m -> level 3
  assert.equal(byDay.get('2026-03-30').level, 4); // 260m -> level 4
  assert.equal(byDay.get('2026-04-14').efficiencyPct, 86);

  // Streaks & totals
  assert.equal(hm.activeDays, 6);
  assert.equal(hm.currentStreak, 2); // empty today does not break yesterday's 2-day streak
  assert.equal(hm.longestStreak, 4);
  assert.equal(hm.totalAttempts, 41);
  assert.equal(hm.totalActiveMin, 695);
  assert.ok(hm.monthLabels.length >= 3);

  // Every column has exactly 7 slots (Mon..Sun) and total non-null slots === 84
  let placed = 0;
  for (const col of hm.columns) {
    assert.equal(col.length, 7);
    for (let dow = 0; dow < 7; dow++) {
      if (col[dow]) {
        assert.equal(col[dow].weekday, dow);
        placed++;
      }
    }
  }
  assert.equal(placed, 84);
});

// =============================================================================
// 3. computeFsrsForecast — Memory Retention & 14-Day Due Forecast
// =============================================================================
test('computeFsrsForecast computes retrievability via FSRS-5, overdue load, and 14-day buckets', () => {
  const nowMs = Date.parse('2026-05-12T10:00:00.000Z'); // 12:00 Oslo (CEST)

  // Empty guard
  const empty = analytics.computeFsrsForecast([], nowMs, 14);
  assert.equal(empty.trackedCards, 0);
  assert.equal(empty.avgRetrievabilityPct, null);
  assert.equal(empty.overdueCount, 0);
  assert.equal(empty.buckets.length, 14);
  assert.equal(empty.peakDay, null);

  const cards = [
    // Overdue by 2 days, stability 2d, lastReview 4d ago -> R(4, 2) = (1 + 4/18)^-1 = 0.818
    {
      questionId: 'econ-2522:q1',
      courseId: 'econ-2522',
      stability: 2,
      scheduledDays: 2,
      reps: 1,
      lastReview: new Date(nowMs - 4 * DAY_MS).toISOString(),
      due: new Date(nowMs - 2 * DAY_MS).toISOString(),
    },
    // Overdue & at-risk (<80% R): stability 1d, lastReview 4d ago -> R(4, 1) = (1 + 4/9)^-1 = 0.692
    {
      questionId: 'econ-2522:q2',
      courseId: 'econ-2522',
      stability: 1,
      scheduledDays: 1,
      reps: 2,
      lastReview: new Date(nowMs - 4 * DAY_MS).toISOString(),
      due: new Date(nowMs - 3 * DAY_MS).toISOString(),
    },
    // Due in 3 days, consolidated stability 10d, lastReview 7d ago -> R(7, 10) = 0.9278
    {
      questionId: 'acct-2527:q5',
      courseId: 'acct-2527',
      stability: 10,
      scheduledDays: 10,
      reps: 4,
      lastReview: new Date(nowMs - 7 * DAY_MS).toISOString(),
      due: new Date(nowMs + 3 * DAY_MS).toISOString(),
    },
    // Due in 3 days (same day as q5 -> makes day +3 have 2 scheduled cards), no lastReview (inferred from due - scheduledDays)
    {
      questionId: 'math-1001:q2',
      courseId: 'math-1001',
      stability: 4,
      scheduledDays: 4,
      reps: 1,
      due: new Date(nowMs + 3 * DAY_MS).toISOString(), // inferred elapsed = 1d -> R(1, 4) = 0.973
    },
    // Due in 20 days -> outside 14d window -> laterCount = 1
    {
      questionId: 'prog-3021:q9',
      courseId: 'prog-3021',
      stability: 25,
      scheduledDays: 25,
      reps: 5,
      lastReview: new Date(nowMs - 5 * DAY_MS).toISOString(),
      due: new Date(nowMs + 20 * DAY_MS).toISOString(),
    },
  ];

  const forecast = analytics.computeFsrsForecast(cards, nowMs, 14);
  assert.equal(forecast.todayIso, '2026-05-12');
  assert.equal(forecast.trackedCards, 5);
  assert.equal(forecast.overdueCount, 2);
  assert.equal(forecast.atRiskCount, 1); // only q2 has R < 0.80
  assert.equal(forecast.stableCount, 2); // stability >= 7: q5 (10d) and q9 (25d)
  assert.equal(forecast.laterCount, 1);
  assert.equal(forecast.dueNext7Days, 4); // 2 overdue on day 0 + 2 on day 3
  assert.equal(forecast.dueNext14Days, 4);
  assert.equal(forecast.buckets[0].overdueCount, 2);
  assert.equal(forecast.buckets[0].count, 2);
  assert.equal(forecast.buckets[3].scheduledCount, 2);
  assert.equal(forecast.buckets[3].count, 2);
  assert.equal(forecast.buckets[3].byCourse['acct-2527'], 1);
  assert.equal(forecast.buckets[3].byCourse['math-1001'], 1);

  // Verify exact average retrievability matches StudyCore.computeFsrsRetrievability
  const expectedAvgR = Math.round(
    ((fsrs.computeFsrsRetrievability(2, 4) +
      fsrs.computeFsrsRetrievability(1, 4) +
      fsrs.computeFsrsRetrievability(10, 7) +
      fsrs.computeFsrsRetrievability(4, 1) +
      fsrs.computeFsrsRetrievability(25, 5)) /
      5) *
      100
  );
  assert.equal(forecast.avgRetrievabilityPct, expectedAvgR);

  // Also accepts a records map `{ [qid]: { fsrs, updatedAt } }`
  const mapForecast = analytics.computeFsrsForecast(
    {
      'econ-2522:q1': { status: 'done', fsrs: cards[0] },
      'acct-2527:q5': { status: 'done', fsrs: cards[2] },
    },
    nowMs,
    14
  );
  assert.equal(mapForecast.trackedCards, 2);
  assert.equal(mapForecast.overdueCount, 1);
  assert.equal(mapForecast.buckets[3].count, 1);
});

// =============================================================================
// 4. computeHourlyPerformance — Peak Performance by Oslo Hour
// =============================================================================
test('computeHourlyPerformance buckets attempts in Europe/Oslo and finds #1 peak window', () => {
  const empty = analytics.computeHourlyPerformance([], 'Europe/Oslo');
  assert.equal(empty.hours.length, 24);
  assert.equal(empty.totalAttempts, 0);
  assert.equal(empty.peakHour, null);
  assert.equal(empty.mostActiveHour, null);

  // May 2026 is CEST (UTC+2):
  // 07:15Z -> 09:15 Oslo (hour 9)
  // 13:30Z -> 15:30 Oslo (hour 15)
  // 21:10Z -> 23:10 Oslo (hour 23)
  const attempts = [
    // Hour 9 Oslo: 3 strong attempts (high UPI, 100% beat AI)
    { timestamp: '2026-05-12T07:15:00Z', kind: 'mcq', dlpfcTier: 3, activeSec: 120, qualityAccuracy: 1.0, paceRatio: 1.25, beatAi: true },
    { timestamp: '2026-05-12T07:35:00Z', kind: 'mcq', dlpfcTier: 3, activeSec: 150, qualityAccuracy: 1.0, paceRatio: 1.2, beatAi: true },
    { timestamp: '2026-05-12T07:50:00Z', kind: 'wiseflow', dlpfcTier: 3, activeSec: 180, qualityAccuracy: 0.95, paceRatio: 1.15, beatAi: true },
    // Hour 15 Oslo: 2 weaker attempts, more raw time (mostActiveHour)
    { timestamp: '2026-05-12T13:10:00Z', kind: 'written', dlpfcTier: 2, activeSec: 900, qualityAccuracy: 0.6, paceRatio: 0.7, beatAi: false },
    { timestamp: '2026-05-12T13:40:00Z', kind: 'written', dlpfcTier: 2, activeSec: 900, qualityAccuracy: 0.65, paceRatio: 0.75, beatAi: false },
    // Hour 23 Oslo: 1 lucky outlier attempt (should NOT beat multi-sample hour 9)
    { timestamp: '2026-05-12T21:10:00Z', kind: 'mcq', dlpfcTier: 3, profile: 'exam', activeSec: 60, qualityAccuracy: 1.0, paceRatio: 1.35, beatAi: true },
  ];

  const res = analytics.computeHourlyPerformance(attempts, 'Europe/Oslo');
  assert.equal(res.totalAttempts, 6);
  assert.equal(res.activeHourCount, 3);
  assert.equal(res.peakHour?.hour, 9);
  assert.equal(res.peakHour?.rangeLabel, '09:00–10:00');
  assert.equal(res.peakHour?.beatAiRatePct, 100);
  assert.equal(res.hours[9].isPeak, true);
  assert.equal(res.hours[23].isPeak, false);
  assert.equal(res.mostActiveHour?.hour, 15);
  assert.equal(res.mostActiveHour?.activeMin, 30);

  // Invalid timezone degrades gracefully to Europe/Oslo
  const fallback = analytics.computeHourlyPerformance(attempts.slice(0, 1), 'Not/A_Real_Zone');
  assert.equal(fallback.timezone, 'Europe/Oslo');
  assert.equal(fallback.hours[9].attempts, 1);
});

// =============================================================================
// 5. buildAttemptsCsv & buildDailySeriesCsv — RFC-4180 + Formula Injection Guard
// =============================================================================
test('buildAttemptsCsv and buildDailySeriesCsv enforce RFC-4180 escaping and Excel formula safety', () => {
  // Empty inputs still emit valid headers
  const emptyAttemptsCsv = analytics.buildAttemptsCsv([]);
  assert.match(emptyAttemptsCsv, /^timestamp,oslo_day,course_id,/);
  assert.equal(emptyAttemptsCsv.split('\r\n').length, 1);

  const emptyDailyCsv = analytics.buildDailySeriesCsv([]);
  assert.match(emptyDailyCsv, /^day,is_today,active_min,/);
  assert.equal(emptyDailyCsv.split('\r\n').length, 1);

  // Test commas, embedded quotes, newlines, and OWASP formula injection payloads (=, +, -, @, \t)
  const dangerousAttempts = [
    {
      timestamp: '2026-05-12T08:00:00.000Z',
      courseId: '=CMD|\' /C calc\'!A0',
      topicId: '+SUM(A1:A2)',
      questionId: 'econ, "Q1"\nline2',
      kind: '-2+3',
      profile: '@HYPERLINK("http://evil")',
      dlpfcTier: 3,
      activeSec: 120,
      aiParSec: 150,
      paceRatio: 1.25,
      qualityAccuracy: 0.95,
      beatAi: true,
      hintsUsed: 0,
      refUsed: false,
      refSec: 0,
      verificationTier: 'auto_graded',
      source: '\t=IMPORTXML("http://x")',
    },
  ];

  const csv = analytics.buildAttemptsCsv(dangerousAttempts);
  assert.ok(csv.includes('\r\n'), 'Should use RFC-4180 CRLF line separators');
  // Every dangerous formula prefix MUST be neutralized with leading single quote
  assert.ok(csv.includes("'=CMD|' /C calc'!A0"), 'Must guard leading =');
  assert.ok(csv.includes("'+SUM(A1:A2)"), 'Must guard leading +');
  assert.ok(csv.includes("'-2+3"), 'Must guard leading -');
  assert.ok(csv.includes("\"'@HYPERLINK(\"\"http://evil\"\")\""), 'Must guard leading @ and double internal quotes');
  assert.ok(csv.includes('"econ, ""Q1""\nline2"'), 'Must RFC-4180 quote commas, quotes, and newlines');
  assert.ok(csv.includes("\"\t=IMPORTXML") === false && csv.includes("'\t=IMPORTXML"), 'Must guard leading tab formula');

  // Verify buildDailySeriesCsv sorts chronologically and emits empty cells for nulls
  const dailyCsv = analytics.buildDailySeriesCsv([
    {
      day: '2026-05-12',
      isToday: true,
      activeMin: 150,
      screenMin: 166,
      offScreenMin: 10,
      efficiencyPct: 90,
      attempts: 12,
      adjustedUnits: 14.5,
      upi: 102,
      accuracyPct: 92,
      avgPaceRatio: 1.12,
      highMin: 60,
      medMin: 60,
      lowMin: 30,
      hasScreenLog: true,
    },
    {
      day: '2026-05-11',
      isToday: false,
      activeMin: 45,
      screenMin: 45,
      offScreenMin: 0,
      efficiencyPct: null,
      attempts: 4,
      adjustedUnits: 3.2,
      upi: null,
      accuracyPct: null,
      avgPaceRatio: null,
      highMin: 0,
      medMin: 45,
      lowMin: 0,
      hasScreenLog: false,
    },
  ]);
  const lines = dailyCsv.split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('2026-05-11,false,45,45,0,,4,3.2,,,,0,45,0,false'));
  assert.ok(lines[2].startsWith('2026-05-12,true,150,166,10,90,12,14.5,102,92,1.12,60,60,30,true'));
  assert.ok(!dailyCsv.includes('null'), 'Null fields must serialize as empty CSV cells, never literal "null"');
});
