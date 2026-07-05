import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDate,
  studyBlocksForExam,
  parseExtractionJson,
  consolidateTaskEventOverlap,
  sanitizeProfileText,
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

test('parses fenced and bare JSON, rejects non-objects', () => {
  assert.deepEqual(parseExtractionJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseExtractionJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseExtractionJson('[1,2]'));
  assert.throws(() => parseExtractionJson('sw</</</</'));
});
