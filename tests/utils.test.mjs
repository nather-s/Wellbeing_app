import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDate,
  studyBlocksForExam,
  parseExtractionJson,
  consolidateTaskEventOverlap,
  sanitizeProfileText,
  aggregateUsageStats,
  aggregateAnalyticsEvents,
  sanitizeAnalyticsMeta,
  coarsePlatform,
  CLIENT_TRACKABLE_TYPES,
  ANALYTICS_EVENT_TYPES,
} from '../server-utils.mjs';

// ---------- consolidateTaskEventOverlap (issue: task+event duplication) ----------

test('drops a task whose due matches an event start (the "wake up for the 6 o\'clock meeting" case)', () => {
  const six = new Date(Date.now() + 86400000);
  six.setHours(6, 0, 0, 0);
  const tasks = [{ title: 'wake up', due: six.toISOString() }];
  const events = [{ title: 'ab meeting', start: six.toISOString() }];
  const { kept, dropped } = consolidateTaskEventOverlap(tasks, events);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].title, 'wake up');
});

test('drops a task within the 45-minute window of an event', () => {
  const base = Date.now() + 86400000;
  const tasks = [{ title: 'get ready', due: new Date(base + 30 * 60000).toISOString() }];
  const events = [{ title: 'meeting', start: new Date(base).toISOString() }];
  const { kept, dropped } = consolidateTaskEventOverlap(tasks, events);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('keeps a task clearly outside the window', () => {
  const base = Date.now() + 86400000;
  const tasks = [{ title: 'buy groceries', due: new Date(base + 5 * 3600000).toISOString() }];
  const events = [{ title: 'meeting', start: new Date(base).toISOString() }];
  const { kept, dropped } = consolidateTaskEventOverlap(tasks, events);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('never touches tasks without a due time', () => {
  const tasks = [{ title: 'laundry', due: null }];
  const events = [{ title: 'meeting', start: new Date().toISOString() }];
  const { kept, dropped } = consolidateTaskEventOverlap(tasks, events);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 0);
});

test('no events means no consolidation at all', () => {
  const tasks = [{ title: 'essay', due: new Date().toISOString() }, { title: 'gym', due: null }];
  const { kept, dropped } = consolidateTaskEventOverlap(tasks, []);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 0);
});

// ---------- sanitizeProfileText (issue: prompt leakage into the UI) ----------

test('rejects instruction-echo text like "The user wants a single short paragraph..."', () => {
  assert.equal(sanitizeProfileText('The user wants a single short paragraph describing them.'), null);
  assert.equal(sanitizeProfileText('Condense the following observations about one person'), null);
  assert.equal(sanitizeProfileText('Return ONLY valid JSON matching the shape'), null);
});

test('accepts a genuine profile summary', () => {
  const good = 'Night owl who studies best after 9pm; gets stressed by unread TA emails.';
  assert.equal(sanitizeProfileText(good), good);
});

test('rejects empty, non-string, and over-long text', () => {
  assert.equal(sanitizeProfileText(''), null);
  assert.equal(sanitizeProfileText(null), null);
  assert.equal(sanitizeProfileText(undefined), null);
  assert.equal(sanitizeProfileText('x'.repeat(500)), null);
});

// ---------- studyBlocksForExam ----------

test('plans up to three future study blocks strictly before the exam', () => {
  const exam = new Date(Date.now() + 7 * 86400000).toISOString();
  const blocks = studyBlocksForExam('chem midterm', exam, 330, 'night');
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.ok(new Date(b.due).getTime() > Date.now(), 'block is in the future');
    assert.ok(new Date(b.due).getTime() < new Date(exam).getTime(), 'block is before the exam');
    assert.equal(b.bucket, 'deep_work');
  }
  // Night owl -> 19:00 local (IST = UTC+5:30 -> 13:30 UTC)
  assert.equal(new Date(blocks[0].due).getUTCHours(), 13);
  assert.equal(new Date(blocks[0].due).getUTCMinutes(), 30);
  // The last block before the exam is the urgent one
  assert.equal(blocks[blocks.length - 1].priority, 'high');
});

test('skips blocks that would land in the past for a near exam', () => {
  const exam = new Date(Date.now() + 2 * 86400000).toISOString();
  const blocks = studyBlocksForExam('quiz', exam, 0, 'morning');
  assert.ok(blocks.length <= 2, 'the 5-days-before block cannot exist');
  for (const b of blocks) assert.ok(new Date(b.due).getTime() > Date.now());
});

// ---------- resolveDate ----------

test('resolves "tomorrow at 7am" into tomorrow, 7am in the user timezone (IST)', () => {
  const iso = resolveDate('tomorrow at 7am', 330);
  assert.ok(iso, 'parsed successfully');
  const utc = new Date(iso);
  // 7:00 IST == 1:30 UTC
  assert.equal(utc.getUTCHours(), 1);
  assert.equal(utc.getUTCMinutes(), 30);
  assert.ok(utc.getTime() > Date.now(), 'in the future');
});

test('returns null for garbage and missing phrases', () => {
  assert.equal(resolveDate(null, 330), null);
  assert.equal(resolveDate('', 330), null);
  assert.equal(resolveDate('completely not a time', 330), null);
});

// Regression test for the "said 9, got scheduled for 11:30" bug report. Root cause: a
// bare number like "9" has no grammatical signal it's a time at all, so chrono correctly
// refuses it (null) — the fix retries with "at " prepended instead of ever trusting a
// model-guessed absolute date as a fallback.
test('resolves a bare hour like "9" the same as "at 9" (the reported bug)', () => {
  const bare = resolveDate('9', 330);
  const withAt = resolveDate('at 9', 330);
  assert.ok(bare, 'bare "9" must resolve, not silently fail');
  assert.equal(bare, withAt, 'bare number and "at <number>" must resolve identically');
});

test('resolves bare "9:30" and "9pm" the same way as their "at" equivalents', () => {
  assert.equal(resolveDate('9:30', 330), resolveDate('at 9:30', 330));
  assert.equal(resolveDate('9pm', 330), resolveDate('at 9pm', 330));
});

// ---------- parseExtractionJson ----------

// ---------- aggregateUsageStats (founder dashboard) ----------

test('counts total users and total captures correctly', () => {
  const now = Date.now();
  const users = [
    { id: 'a', email: 'a@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
    { id: 'b', email: 'b@x.com', created_at: new Date(now - 20 * 86400000).toISOString() },
  ];
  const rows = [
    { user_id: 'a', created_at: new Date(now - 1 * 86400000).toISOString() },
    { user_id: 'a', created_at: new Date(now - 10 * 86400000).toISOString() },
    { user_id: 'b', created_at: new Date(now - 40 * 86400000).toISOString() }, // outside window
  ];
  const stats = aggregateUsageStats(users, rows, { nowMs: now, windowDays: 7 });
  assert.equal(stats.totalUsers, 2);
  assert.equal(stats.totalCaptures, 3);
});

test('activeUsersInWindow only counts users with a capture inside the window', () => {
  const now = Date.now();
  const users = [
    { id: 'a', email: 'a@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
    { id: 'b', email: 'b@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
  ];
  const rows = [
    { user_id: 'a', created_at: new Date(now - 2 * 86400000).toISOString() }, // inside 7-day window
    { user_id: 'b', created_at: new Date(now - 20 * 86400000).toISOString() }, // outside
  ];
  const stats = aggregateUsageStats(users, rows, { nowMs: now, windowDays: 7 });
  assert.equal(stats.activeUsersInWindow, 1);
  assert.equal(stats.capturesInWindow, 1);
});

test('sorts perUser by most recently active first; never-active users last', () => {
  const now = Date.now();
  const users = [
    { id: 'stale', email: 'stale@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
    { id: 'fresh', email: 'fresh@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
    { id: 'never', email: 'never@x.com', created_at: new Date(now - 30 * 86400000).toISOString() },
  ];
  const rows = [
    { user_id: 'stale', created_at: new Date(now - 20 * 86400000).toISOString() },
    { user_id: 'fresh', created_at: new Date(now - 1 * 86400000).toISOString() },
  ];
  const stats = aggregateUsageStats(users, rows, { nowMs: now });
  assert.deepEqual(stats.perUser.map((u) => u.email), ['fresh@x.com', 'stale@x.com', 'never@x.com']);
});

test('ignores capture rows belonging to a deleted user instead of crashing', () => {
  const users = [{ id: 'a', email: 'a@x.com', created_at: new Date().toISOString() }];
  const rows = [{ user_id: 'ghost-deleted-user', created_at: new Date().toISOString() }];
  const stats = aggregateUsageStats(users, rows);
  assert.equal(stats.totalCaptures, 1); // raw row count is unaffected
  assert.equal(stats.perUser[0].totalCaptures, 0); // but attributed to no one
});

test('handles zero users and zero captures without dividing by zero or throwing', () => {
  const stats = aggregateUsageStats([], []);
  assert.equal(stats.totalUsers, 0);
  assert.equal(stats.activeUsersInWindow, 0);
  assert.deepEqual(stats.perUser, []);
});

test('parses fenced and bare JSON, rejects non-objects', () => {
  assert.deepEqual(parseExtractionJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseExtractionJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseExtractionJson('[1,2]'));
  assert.throws(() => parseExtractionJson('sw</</</</'));
});

// ---------- Analytics: privacy-safe metadata sanitization ----------

test('sanitizeAnalyticsMeta whitelists known keys and drops everything else', () => {
  // A caller trying to smuggle content or extra keys through gets them stripped.
  assert.deepEqual(
    sanitizeAnalyticsMeta('tab_viewed', { tab: 'tasks', transcript: 'my private note', email: 'a@b.com' }),
    { tab: 'tasks' }
  );
  // Unknown tab value is dropped rather than stored.
  assert.deepEqual(sanitizeAnalyticsMeta('tab_viewed', { tab: 'evil' }), {});
  // Method must be voice/text.
  assert.deepEqual(sanitizeAnalyticsMeta('capture_method', { method: 'text' }), { method: 'text' });
  assert.deepEqual(sanitizeAnalyticsMeta('capture_method', { method: 'hacked' }), {});
});

test('sanitizeAnalyticsMeta clamps and defaults numeric/enum fields', () => {
  assert.deepEqual(sanitizeAnalyticsMeta('calendar_synced', { count: 999 }), { count: 50 }); // clamped
  assert.deepEqual(sanitizeAnalyticsMeta('calendar_synced', { count: -3 }), { count: 0 });
  assert.deepEqual(sanitizeAnalyticsMeta('calendar_synced', {}), { count: 0 });
  assert.deepEqual(sanitizeAnalyticsMeta('capture_failed', { kind: 'timeout' }), { kind: 'timeout' });
  assert.deepEqual(sanitizeAnalyticsMeta('capture_failed', { kind: 'weird' }), { kind: 'server' }); // safe default
  assert.deepEqual(sanitizeAnalyticsMeta('energy_set', { energy: 'morning' }), { energy: 'morning' });
});

test('sanitizeAnalyticsMeta caps a speech error code and never stores free text', () => {
  const long = 'x'.repeat(200);
  const out = sanitizeAnalyticsMeta('speech_error', { code: long });
  assert.equal(out.code.length, 40);
});

test('the browser can only report a safe subset of event types', () => {
  // Server-emitted events must NOT be forgeable from the client.
  assert.ok(CLIENT_TRACKABLE_TYPES.has('tab_viewed'));
  assert.ok(!CLIENT_TRACKABLE_TYPES.has('capture_succeeded'));
  assert.ok(!CLIENT_TRACKABLE_TYPES.has('calendar_connected'));
  // Everything client-trackable is also a known type.
  for (const t of CLIENT_TRACKABLE_TYPES) assert.ok(ANALYTICS_EVENT_TYPES.has(t));
});

// ---------- Analytics: coarse platform (no fingerprinting) ----------

test('coarsePlatform derives OS/browser without the full user-agent', () => {
  assert.equal(coarsePlatform('Mozilla/5.0 (Linux; Android 14) ... Chrome/120 Mobile Safari/537'), 'Android/Chrome');
  assert.equal(coarsePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) ... Version/17 Safari'), 'iOS/Safari');
  assert.equal(coarsePlatform('Mozilla/5.0 (Windows NT 10.0) ... Edg/120'), 'Windows/Edge');
  assert.equal(coarsePlatform(''), 'unknown');
});

// ---------- Analytics: aggregation for the dashboard ----------

test('aggregateAnalyticsEvents builds the funnel and success rate within the window', () => {
  const now = Date.now();
  const recent = (mins) => new Date(now - mins * 60000).toISOString();
  const rows = [
    { type: 'app_opened', meta: {}, platform: 'Android/Chrome', created_at: recent(10) },
    { type: 'capture_started', meta: {}, platform: 'Android/Chrome', created_at: recent(9) },
    { type: 'capture_method', meta: { method: 'voice' }, platform: 'Android/Chrome', created_at: recent(9) },
    { type: 'capture_succeeded', meta: { method: 'voice' }, platform: 'Android/Chrome', created_at: recent(8) },
    { type: 'capture_failed', meta: { kind: 'parse' }, platform: 'Android/Chrome', created_at: recent(7) },
    { type: 'tab_viewed', meta: { tab: 'tasks' }, platform: 'Android/Chrome', created_at: recent(6) },
    { type: 'tab_viewed', meta: { tab: 'tasks' }, platform: 'iOS/Safari', created_at: recent(5) },
    { type: 'calendar_synced', meta: { count: 3 }, platform: 'Android/Chrome', created_at: recent(4) },
    // An old row that must be excluded from the window but still counts in totalEvents.
    { type: 'capture_succeeded', meta: { method: 'text' }, platform: 'Windows/Chrome', created_at: new Date(now - 30 * 86400000).toISOString() },
  ];
  const a = aggregateAnalyticsEvents(rows, { nowMs: now, windowDays: 7 });
  assert.equal(a.totalEvents, 9);
  assert.equal(a.eventsInWindow, 8);
  assert.equal(a.funnel.capture_succeeded, 1);
  assert.equal(a.funnel.capture_failed, 1);
  assert.equal(a.funnel.successRate, 50); // 1 of 2 finished captures
  assert.equal(a.captureMethods.voice, 1);
  assert.equal(a.calendar.itemsSynced, 3);
  assert.equal(a.topTabs[0][0], 'tasks');
  assert.equal(a.topTabs[0][1], 2);
  assert.equal(a.platforms['Android/Chrome'], 7);
});

test('aggregateAnalyticsEvents handles an empty table without throwing or dividing by zero', () => {
  const a = aggregateAnalyticsEvents([], { nowMs: Date.now() });
  assert.equal(a.totalEvents, 0);
  assert.equal(a.funnel.successRate, null); // no finished captures -> null, not NaN
  assert.deepEqual(a.topTabs, []);
});
