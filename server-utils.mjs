// Pure, side-effect-free helpers shared by server.js and the test suite.
import * as chrono from 'chrono-node';

// Deterministically resolve a natural-language time phrase ("tomorrow at 7am") into an ISO
// string. Date math is done here by chrono-node — never by the LLM, which is unreliable at it.
// tzOffsetMinutes comes from the user's browser (positive = ahead of UTC, e.g. IST = +330),
// so "tomorrow at 7am" means 7am in the USER's timezone even though the server runs in UTC.
export function resolveDate(phrase, tzOffsetMinutes) {
  if (!phrase || typeof phrase !== 'string') return null;
  try {
    const ref = Number.isFinite(tzOffsetMinutes)
      ? { instant: new Date(), timezone: tzOffsetMinutes }
      : new Date();
    const d = chrono.parseDate(phrase, ref, { forwardDate: true });
    return d ? d.toISOString() : null;
  } catch {
    return null;
  }
}

// When a student mentions an exam, don't just log it — plan for it. Deterministic study
// blocks at 5/3/1 days before the exam, timed to when THEIR brain works (energy pref).
export function studyBlocksForExam(examTitle, startIso, tzOffsetMinutes, energy, nowMs = Date.now()) {
  const hourLocal = energy === 'morning' ? 8 : energy === 'night' ? 19 : 17;
  const offMs = (Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0) * 60000;
  const startMs = new Date(startIso).getTime();
  const blocks = [];
  for (const daysBefore of [5, 3, 1]) {
    // Anchor to the user's LOCAL wall clock, then convert back to a UTC instant.
    const local = new Date(startMs - daysBefore * 86400000 + offMs);
    local.setUTCHours(hourLocal, 0, 0, 0);
    const dueMs = local.getTime() - offMs;
    if (dueMs > nowMs && dueMs < startMs) {
      blocks.push({
        title: `Study: ${examTitle}`,
        due: new Date(dueMs).toISOString(),
        due_phrase: null,
        priority: daysBefore === 1 ? 'high' : 'medium',
        bucket: 'deep_work',
      });
    }
  }
  return blocks;
}

export function parseExtractionJson(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned); // throws → chain tries the next model
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model returned JSON that is not an object');
  }
  return parsed;
}

// One spoken thought often surfaces as BOTH a task and an event ("meeting at 6 for which
// I have to wake up" → event "meeting @6" + task "wake up @6"). The calendar event with
// its built-in notification covers the intent — a same-time to-do is just clutter.
// Drops any task whose due lands within `windowMinutes` of an event captured in the same
// dump. Tasks without a due time are never touched.
export function consolidateTaskEventOverlap(taskRows, eventRows, windowMinutes = 45) {
  const eventTimes = eventRows
    .map((e) => (e.start ? new Date(e.start).getTime() : null))
    .filter((t) => Number.isFinite(t));
  if (!eventTimes.length) return { kept: taskRows, dropped: [] };

  const windowMs = windowMinutes * 60000;
  const kept = [];
  const dropped = [];
  for (const task of taskRows) {
    const dueMs = task.due ? new Date(task.due).getTime() : NaN;
    const overlaps = Number.isFinite(dueMs) && eventTimes.some((t) => Math.abs(t - dueMs) <= windowMs);
    if (overlaps) dropped.push(task);
    else kept.push(task);
  }
  return { kept, dropped };
}

// Free models occasionally echo their own instructions instead of producing the summary
// ("The user wants a single short paragraph..."). That junk must never be stored as the
// profile — it renders straight into the UI. Returns the cleaned text, or null if the
// text smells like prompt leakage / garbage.
const PROMPT_LEAK_FRAGMENTS = [
  'the user wants',
  'single short paragraph',
  'return only',
  'condense the following',
  'observations about one',
  'max 80 words',
  'json',
  'system prompt',
  'as an ai',
  'language model',
  'the assistant',
];

export function sanitizeProfileText(text, maxLen = 400) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  const lower = trimmed.toLowerCase();
  if (PROMPT_LEAK_FRAGMENTS.some((frag) => lower.includes(frag))) return null;
  return trimmed;
}
