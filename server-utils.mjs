// Pure, side-effect-free helpers shared by server.js and the test suite.
import * as chrono from 'chrono-node';

// A bare number/time with no preposition ("9", "9:30", "9pm") has no grammatical signal
// that it's even a time reference, so chrono-node correctly refuses to guess at it and
// returns null. Retrying with "at " prepended turns it into something chrono can parse
// the exact same way "at 9" already does, without changing the meaning at all.
const BARE_TIME_RE = /^\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i;

// Deterministically resolve a natural-language time phrase ("tomorrow at 7am") into an ISO
// string. Date math is done here by chrono-node — never by the LLM, which is unreliable at it.
// tzOffsetMinutes comes from the user's browser (positive = ahead of UTC, e.g. IST = +330),
// so "tomorrow at 7am" means 7am in the USER's timezone even though the server runs in UTC.
export function resolveDate(phrase, tzOffsetMinutes) {
  if (!phrase || typeof phrase !== 'string') return null;
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  try {
    const ref = Number.isFinite(tzOffsetMinutes)
      ? { instant: new Date(), timezone: tzOffsetMinutes }
      : new Date();
    let d = chrono.parseDate(trimmed, ref, { forwardDate: true });
    if (!d && BARE_TIME_RE.test(trimmed)) {
      d = chrono.parseDate(`at ${trimmed}`, ref, { forwardDate: true });
    }
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

// Founder dashboard: turns raw user rows + raw capture rows (tasks+events+notes, just
// {user_id, created_at}) into the numbers a founder actually watches for retention —
// without touching the database itself, so this is fully unit-testable.
// `users`: [{id, email, created_at}]. `captureRows`: [{user_id, created_at}].
export function aggregateUsageStats(users, captureRows, { nowMs = Date.now(), windowDays = 7 } = {}) {
  const windowMs = windowDays * 86400000;
  const cutoff = nowMs - windowMs;

  const perUser = new Map(
    users.map((u) => [u.id, { email: u.email || '(no email)', joinedAt: u.created_at || null, totalCaptures: 0, lastCaptureAt: null }])
  );

  let capturesInWindow = 0;
  const activeInWindow = new Set();

  for (const row of captureRows) {
    const entry = perUser.get(row.user_id);
    if (!entry) continue; // orphaned row (deleted user) — ignore, don't crash the dashboard
    entry.totalCaptures++;
    const t = new Date(row.created_at).getTime();
    if (!entry.lastCaptureAt || t > new Date(entry.lastCaptureAt).getTime()) entry.lastCaptureAt = row.created_at;
    if (t >= cutoff) {
      capturesInWindow++;
      activeInWindow.add(row.user_id);
    }
  }

  const perUserList = [...perUser.values()].sort((a, b) => {
    const at = a.lastCaptureAt ? new Date(a.lastCaptureAt).getTime() : -Infinity;
    const bt = b.lastCaptureAt ? new Date(b.lastCaptureAt).getTime() : -Infinity;
    return bt - at; // most recently active first; never-active users sink to the bottom
  });

  return {
    totalUsers: users.length,
    totalCaptures: captureRows.length,
    activeUsersInWindow: activeInWindow.size,
    capturesInWindow,
    windowDays,
    perUser: perUserList,
  };
}

// ---------- Product analytics (privacy-safe: NEVER stores user content) ----------
// Every event records only THAT an action happened plus small, non-identifying
// metadata (which tab, voice-vs-text, an error kind). No transcript, task title,
// note text, mood, or email is ever written to the analytics table — that keeps
// this defensible as plain product analytics for Google OAuth verification.

// The complete set of event types the system understands. Anything not in here is
// rejected, so the table can never fill with arbitrary (or content-bearing) junk.
export const ANALYTICS_EVENT_TYPES = new Set([
  'app_opened',
  'capture_started',
  'capture_method',
  'capture_succeeded',
  'capture_failed',
  'tab_viewed',
  'calendar_connect_clicked',
  'calendar_connected',
  'calendar_synced',
  'catchup_used',
  'energy_set',
  'task_completed',
  'task_deleted',
  'event_deleted',
  'speech_error',
]);

// Only these types may be reported by the browser via /api/track. The rest are
// emitted server-side from inside the relevant handlers, where they can't be faked.
export const CLIENT_TRACKABLE_TYPES = new Set([
  'app_opened',
  'capture_started',
  'capture_method',
  'tab_viewed',
  'calendar_connect_clicked',
  'task_completed',
  'task_deleted',
  'event_deleted',
  'speech_error',
]);

// Metadata is whitelisted key-by-key and coerced to safe, bounded values so nothing
// free-form (and no accidental PII) can ride along in the meta blob.
const ALLOWED_TABS = new Set(['today', 'tasks', 'events', 'notes', 'profile', 'admin']);
const ALLOWED_METHODS = new Set(['voice', 'text']);
const ALLOWED_ENERGY = new Set(['morning', 'night']);
const ALLOWED_FAIL_KINDS = new Set(['rate_limit', 'timeout', 'parse', 'empty', 'server']);

export function sanitizeAnalyticsMeta(type, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  switch (type) {
    case 'capture_method':
    case 'capture_succeeded':
      if (ALLOWED_METHODS.has(m.method)) out.method = m.method;
      break;
    case 'tab_viewed':
      if (ALLOWED_TABS.has(m.tab)) out.tab = m.tab;
      break;
    case 'capture_failed':
      out.kind = ALLOWED_FAIL_KINDS.has(m.kind) ? m.kind : 'server';
      break;
    case 'calendar_synced':
      out.count = Number.isFinite(m.count) ? Math.max(0, Math.min(50, Math.trunc(m.count))) : 0;
      break;
    case 'energy_set':
      if (ALLOWED_ENERGY.has(m.energy)) out.energy = m.energy;
      break;
    case 'speech_error':
      // A short recognition error code like 'no-speech' or 'network' — capped, never text.
      if (typeof m.code === 'string') out.code = m.code.slice(0, 40);
      break;
    default:
      break; // most events carry no metadata at all
  }
  return out;
}

// Derive a coarse platform label from the User-Agent, server-side. Deliberately
// low-resolution ("Android/Chrome") — enough to spot device-specific bugs like the
// Android transcript issue, without fingerprinting anyone.
export function coarsePlatform(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  if (!ua) return 'unknown';
  let os = 'other';
  if (ua.includes('android')) os = 'Android';
  else if (/iphone|ipad|ipod/.test(ua)) os = 'iOS';
  else if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macintosh')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  let browser = 'other';
  // Order matters: Edge/Brave/Opera all contain "chrome"; check the specific ones first.
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('opr/') || ua.includes('opera')) browser = 'Opera';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('chrome') || ua.includes('crios')) browser = 'Chrome';
  else if (ua.includes('safari')) browser = 'Safari';
  return `${os}/${browser}`;
}

// Roll a flat list of analytics rows into the numbers the founder dashboard shows.
// Everything is counted within the window except the all-time total. Defensive against
// unknown types and missing meta so a stray row never breaks the dashboard.
export function aggregateAnalyticsEvents(rows, { nowMs = Date.now(), windowDays = 7 } = {}) {
  const cutoff = nowMs - windowDays * 86400000;
  const inWindow = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);

  const count = (type) => inWindow.filter((r) => r.type === type).length;
  const tally = (type, key) => {
    const out = {};
    for (const r of inWindow) {
      if (r.type !== type) continue;
      const v = (r.meta && r.meta[key]) || 'unknown';
      out[v] = (out[v] || 0) + 1;
    }
    return out;
  };

  const started = count('capture_started');
  const succeeded = count('capture_succeeded');
  const failed = count('capture_failed');

  const platforms = {};
  for (const r of inWindow) {
    const p = r.platform || 'unknown';
    platforms[p] = (platforms[p] || 0) + 1;
  }

  const tabCounts = tally('tab_viewed', 'tab');
  const topTabs = Object.entries(tabCounts).sort((a, b) => b[1] - a[1]);

  let itemsSynced = 0;
  for (const r of inWindow) {
    if (r.type === 'calendar_synced') itemsSynced += (r.meta && Number(r.meta.count)) || 0;
  }

  return {
    windowDays,
    totalEvents: rows.length,
    eventsInWindow: inWindow.length,
    funnel: {
      app_opened: count('app_opened'),
      capture_started: started,
      capture_succeeded: succeeded,
      capture_failed: failed,
      // Success rate of captures that actually finished (started can lag on abandons).
      successRate: succeeded + failed > 0 ? Math.round((succeeded / (succeeded + failed)) * 100) : null,
    },
    captureMethods: tally('capture_method', 'method'),
    calendar: {
      connectClicked: count('calendar_connect_clicked'),
      connected: count('calendar_connected'),
      syncEvents: count('calendar_synced'),
      itemsSynced,
    },
    catchupUsed: count('catchup_used'),
    energySet: tally('energy_set', 'energy'),
    actions: {
      task_completed: count('task_completed'),
      task_deleted: count('task_deleted'),
      event_deleted: count('event_deleted'),
    },
    errors: {
      captureFailedByKind: tally('capture_failed', 'kind'),
      speechErrorByCode: tally('speech_error', 'code'),
    },
    platforms,
    topTabs,
  };
}
