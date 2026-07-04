import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import * as chrono from 'chrono-node';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Supabase (server-side, full-access service key — never sent to the browser) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; // safe to expose to the browser (login only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Free models get rate-limited/rotated, so we try a CHAIN of known-good free models in order.
// A model only "succeeds" if its output actually parses — garbage output moves to the next one.
const EXTRACT_MODEL_CHAIN = [
  'openai/gpt-oss-120b:free', // strongest stable free model for clean JSON extraction
  'openai/gpt-oss-20b:free', // smaller sibling, usually available when 120b is saturated
  'meta-llama/llama-3.3-70b-instruct:free',
  'openrouter/free', // last resort: OpenRouter picks any live free model
];
const CONSOLIDATE_MODEL_CHAIN = ['openai/gpt-oss-120b:free', 'openrouter/free'];
const API_TIMEOUT_MS = 30000; // don't let a hung upstream call hang our request handler forever

const app = express();
app.use(express.json());
// Never let browsers cache the HTML/JS — otherwise a user's phone can keep running an old
// build after we ship a fix (which looked exactly like login "not working" after a deploy).
// Assets are tiny, so serving fresh every time costs nothing at this scale.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

const EXTRACT_SYSTEM_PROMPT = `You are Loop, the brain-dump engine for overwhelmed students. They talk fast, mix school and life in one breath, and often feel behind. Your job: turn a chaotic spoken or typed dump into an organized plan, with zero judgment.

Return ONLY valid JSON (no prose, no markdown fences) matching exactly this shape:

{
  "tasks": [{"title": string, "due_phrase": string|null, "priority": "low"|"medium"|"high", "bucket": "deep_work"|"admin"|"survival"}],
  "events": [{"title": string, "start_phrase": string|null, "duration_minutes": number|null, "is_exam": boolean}],
  "notes": [string],
  "mood_signal": string|null,
  "coach_line": string|null,
  "profile_update": string|null
}

Rules:
- "due_phrase" / "start_phrase": copy the EXACT time words heard, verbatim (e.g. "tomorrow at 7am", "next Friday", "before section"). NEVER compute dates yourself — just quote the phrase. null if no time was mentioned.
- "bucket" triages each task:
  - "deep_work" = focused brain time: studying, essays, problem sets, projects, coding, reading.
  - "admin" = quick logistics: emailing TAs/professors, forms, sign-ups, scheduling, submitting things.
  - "survival" = life upkeep: laundry, groceries, gym, meds, calling home, sleep.
- Speak student: TA, office hours, syllabus, Canvas, pset/problem set, lab, section, recitation, midterm, finals week, R.A., credit hours. "My prof moved the essay to Friday" means a deadline changed — capture the Friday deadline.
- "is_exam": true for midterms, finals, quizzes, tests — anything they will need to study for beforehand.
- "notes": feelings, worries, and thoughts worth keeping that aren't tasks or events. "mood_signal": their emotional state if detectable.
- "coach_line": ONE short warm sentence of relief (max 15 words) acknowledging what they just offloaded. Casual, human, never corporate. Examples: "That's a lot — it's all captured now." / "Okay. Your week has a shape again." Return null if the dump was purely neutral.
- "profile_update": one durable, specific fact about how this student works, thinks, or likes reminders — never a restatement of what they said. null if nothing new.
- Empty arrays where nothing fits. Never invent things they didn't say or clearly imply.`;

const CONSOLIDATE_SYSTEM_PROMPT = `Condense the following observations about one student into a single short paragraph (max 80 words) describing how they work, when their brain is at its best, what stresses them, and how they like to be reminded or supported. Be specific and concrete, not generic. Return only the paragraph, nothing else.`;

// Deterministically resolve a natural-language time phrase ("tomorrow at 7am") into an ISO
// string. Date math is done here by chrono-node — never by the LLM, which is unreliable at it.
// tzOffsetMinutes comes from the user's browser (positive = ahead of UTC, e.g. IST = +330),
// so "tomorrow at 7am" means 7am in the USER's timezone even though the server runs in UTC.
function resolveDate(phrase, tzOffsetMinutes) {
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

class RateLimitError extends Error {}

async function callModel({ model, system, userContent, maxTokens, jsonMode = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // These two headers are optional but OpenRouter uses them for its public leaderboards/rankings.
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Loop - Voice Life OS',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2, // low temp = fewer degenerate/rambling outputs from free models
        // Ask for guaranteed-valid JSON where the model supports it — fewer parse failures.
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status === 429) {
    throw new RateLimitError(`Rate limited on ${model}`);
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenRouter API error (${resp.status}) for ${model}: ${errText}`);
  }
  const result = await resp.json();
  return (result.choices?.[0]?.message?.content || '').trim();
}

// Try each model in the chain until one produces output that `validate` accepts.
// A model that is down, rate-limited, OR returns garbage just moves us to the next one —
// the request only fails if the ENTIRE chain fails.
async function callWithChain({ models, system, userContent, maxTokens, jsonMode = false, validate = null }) {
  let lastError = null;
  let sawOnlyRateLimits = true;
  for (const model of models) {
    try {
      const text = await callModel({ model, system, userContent, maxTokens, jsonMode });
      if (validate) {
        const value = validate(text); // throws if the output is unusable
        return value;
      }
      return text;
    } catch (err) {
      if (!(err instanceof RateLimitError)) sawOnlyRateLimits = false;
      lastError = err;
      console.warn(`Model ${model} failed (${err.message}), trying next in chain...`);
    }
  }
  if (sawOnlyRateLimits) throw new RateLimitError('All models rate limited');
  throw lastError || new Error('All models in chain failed');
}

function parseExtractionJson(rawText) {
  const cleaned = rawText.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned); // throws → chain tries the next model
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model returned JSON that is not an object');
  }
  return parsed;
}

// Rows come back from Postgres with snake_case created_at; the frontend expects createdAt.
function mapRow(row) {
  return { ...row, createdAt: row.created_at };
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('summary, log, energy')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    summary: data?.summary || '',
    log: Array.isArray(data?.log) ? data.log : [],
    energy: data?.energy || null, // 'morning' | 'night' | null
  };
}

// When a student mentions an exam, don't just log it — plan for it. Deterministic study
// blocks at 5/3/1 days before the exam, timed to when THEIR brain works (energy pref).
// Pure date math, zero model calls, zero cost.
function studyBlocksForExam(examTitle, startIso, tzOffsetMinutes, energy) {
  const hourLocal = energy === 'morning' ? 8 : energy === 'night' ? 19 : 17;
  const offMs = (Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0) * 60000;
  const startMs = new Date(startIso).getTime();
  const nowMs = Date.now();
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

const CATCHUP_SYSTEM_PROMPT = `You are Loop's catch-up planner for an overwhelmed student. They fell behind. Your job: reflow their overdue tasks into a realistic new plan, with ZERO guilt.

You get the current date/time, their energy pattern, and a numbered task list.

Return ONLY valid JSON (no prose, no markdown fences):
{"reschedules": [{"n": number, "due_phrase": string}], "message": string}

Rules:
- "due_phrase": a natural time phrase relative to NOW ("today at 7pm", "tomorrow morning", "Saturday afternoon"). Never a time in the past.
- Spread the load realistically: at most 2-3 deep_work items per day; admin items can batch together; survival fits into gaps. Deep work goes in the morning for a morning person, evening for a night owl.
- Nearest real deadlines and high priority first. Pushing low-priority items several days is fine and healthy.
- Include EVERY task number exactly once in "reschedules".
- "message": 1-2 warm sentences, guilt-free. ("Rough stretch — happens to everyone. Here's a week that actually fits.") Never lecture.`;

async function consolidateProfile(profile) {
  // Only spend a real model call every 5 new observations; otherwise just append cheaply.
  if (profile.log.length % 5 !== 0) {
    return [profile.summary, profile.log[profile.log.length - 1].text].filter(Boolean).join(' ');
  }
  try {
    const text = await callWithChain({
      models: CONSOLIDATE_MODEL_CHAIN,
      system: CONSOLIDATE_SYSTEM_PROMPT,
      userContent: profile.log.map((l) => `- ${l.text}`).join('\n'),
      maxTokens: 300,
    });
    return text || profile.summary;
  } catch (err) {
    console.error('Profile consolidation failed, keeping previous summary:', err.message);
    return profile.summary;
  }
}

// --- Auth: verify the browser's Supabase login token and attach the user id to the request ---
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in.' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Session expired — please log in again.' });
    }
    req.userId = data.user.id;
    next();
  } catch (e) {
    console.error('Auth check failed:', e.message);
    res.status(401).json({ error: 'Could not verify your login.' });
  }
}

// Public config: gives the browser the values it needs to run the LOGIN widget only.
// The anon key is designed to be public; the powerful service key never leaves the server.
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

// Everything else under /api requires a logged-in user.
app.use('/api', requireAuth);

app.post('/api/process', async (req, res) => {
  try {
    const { transcript, tz_offset_minutes } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Empty transcript' });
    }
    const tzOffset = Number.isFinite(tz_offset_minutes) ? tz_offset_minutes : null;
    const userId = req.userId;

    const profile = await getProfile(userId);
    const now = new Date().toISOString();

    const userContent = `Current date/time (UTC): ${now}
Known profile so far: ${profile.summary || '(none yet)'}
Energy pattern: ${profile.energy === 'morning' ? 'morning person — brain works best early' : profile.energy === 'night' ? 'night owl — brain works best late' : '(not set yet)'}

Voice note transcript:
"""${transcript}"""`;

    let parsed;
    try {
      parsed = await callWithChain({
        models: EXTRACT_MODEL_CHAIN,
        system: EXTRACT_SYSTEM_PROMPT,
        userContent,
        maxTokens: 1024,
        jsonMode: true,
        validate: parseExtractionJson, // garbage output → automatically tries the next model
      });
    } catch (err) {
      console.error(err.message);
      if (err instanceof RateLimitError) {
        return res.status(429).json({ error: 'Loop is a little busy right now — wait a minute and try again.' });
      }
      return res.status(502).json({ error: "Couldn't understand that one — try rephrasing it.", detail: err.message });
    }

    // Build rows to insert, resolving dates deterministically via chrono (never the model).
    const VALID_BUCKETS = ['deep_work', 'admin', 'survival'];
    const taskRows = (parsed.tasks || []).map((t) => ({
      user_id: userId,
      title: t.title,
      due: resolveDate(t.due_phrase, tzOffset) || t.due || null,
      due_phrase: t.due_phrase || null,
      priority: t.priority || 'medium',
      bucket: VALID_BUCKETS.includes(t.bucket) ? t.bucket : 'admin',
      done: false,
    }));
    // is_exam is used server-side to plan study blocks — it isn't stored on the event.
    const parsedEvents = (parsed.events || []).map((e) => ({
      row: {
        user_id: userId,
        title: e.title,
        start: resolveDate(e.start_phrase, tzOffset) || e.start || null,
        start_phrase: e.start_phrase || null,
        duration_minutes: e.duration_minutes ?? null,
      },
      isExam: e.is_exam === true,
    }));
    const noteRows = (parsed.notes || []).map((n) => ({
      user_id: userId,
      text: n,
      mood: parsed.mood_signal || null,
    }));

    // Exam radar: every exam with a known future date gets study blocks auto-planned,
    // timed to the student's energy pattern. This is the "midterm means a study plan,
    // not just a calendar entry" behavior.
    for (const { row, isExam } of parsedEvents) {
      if (isExam && row.start) {
        taskRows.push(
          ...studyBlocksForExam(row.title, row.start, tzOffset, profile.energy).map((b) => ({ user_id: userId, done: false, ...b }))
        );
      }
    }

    let newTasks = [];
    let newEvents = [];
    let newNotes = [];
    if (taskRows.length) {
      const { data, error } = await supabase.from('tasks').insert(taskRows).select();
      if (error) throw new Error(error.message);
      newTasks = data.map(mapRow);
    }
    if (parsedEvents.length) {
      const { data, error } = await supabase.from('events').insert(parsedEvents.map((e) => e.row)).select();
      if (error) throw new Error(error.message);
      newEvents = data.map(mapRow);
    }
    if (noteRows.length) {
      const { data, error } = await supabase.from('notes').insert(noteRows).select();
      if (error) throw new Error(error.message);
      newNotes = data.map(mapRow);
    }

    let profileSummary = profile.summary;
    if (parsed.profile_update) {
      profile.log.push({ text: parsed.profile_update, at: now });
      profileSummary = await consolidateProfile(profile);
      const { error } = await supabase
        .from('profiles')
        .upsert({ user_id: userId, summary: profileSummary, log: profile.log, updated_at: now }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
    }

    res.json({
      transcript,
      // "parsed" keeps the shape the frontend expects, with dates already resolved by chrono.
      parsed: {
        tasks: newTasks,
        events: newEvents,
        notes: newNotes.map((n) => n.text),
        mood_signal: parsed.mood_signal || null,
        coach_line: typeof parsed.coach_line === 'string' ? parsed.coach_line : null,
      },
      profile: profileSummary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.get('/api/tasks', async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*').eq('user_id', req.userId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapRow));
});

app.get('/api/events', async (req, res) => {
  const { data, error } = await supabase.from('events').select('*').eq('user_id', req.userId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapRow));
});

app.get('/api/notes', async (req, res) => {
  const { data, error } = await supabase.from('notes').select('*').eq('user_id', req.userId).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(mapRow));
});

app.get('/api/profile', async (req, res) => {
  try {
    const profile = await getProfile(req.userId);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-question onboarding: morning person or night owl. Everything time-related
// (study blocks, catch-up plans) keys off this.
app.post('/api/profile/energy', async (req, res) => {
  const { energy } = req.body;
  if (!['morning', 'night'].includes(energy)) {
    return res.status(400).json({ error: 'energy must be "morning" or "night"' });
  }
  const { error } = await supabase
    .from('profiles')
    .upsert({ user_id: req.userId, energy, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, energy });
});

// The "Fix my week" button. Takes every overdue task and asks the model for a humane
// reflow — new times as natural phrases, resolved by chrono (never model date math),
// plus a guilt-free message. The model sees short numbers, not raw ids, so a small
// free model can't mangle UUIDs.
app.post('/api/catchup', async (req, res) => {
  try {
    const tzOffset = Number.isFinite(req.body?.tz_offset_minutes) ? req.body.tz_offset_minutes : null;
    const nowIso = new Date().toISOString();

    const { data: overdue, error: qErr } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', req.userId)
      .eq('done', false)
      .not('due', 'is', null)
      .lt('due', nowIso)
      .order('due');
    if (qErr) return res.status(500).json({ error: qErr.message });
    if (!overdue.length) return res.json({ moved: 0, message: "Nothing's overdue — you're more on top of things than you think." });

    const profile = await getProfile(req.userId);
    const list = overdue
      .map((t, i) => `${i + 1}. [${t.bucket || 'task'}] ${t.title} (priority: ${t.priority}, was due: ${t.due})`)
      .join('\n');
    const userContent = `Current date/time (UTC): ${nowIso}
Energy pattern: ${profile.energy === 'morning' ? 'morning person' : profile.energy === 'night' ? 'night owl' : 'unknown'}

Overdue tasks:
${list}`;

    let plan;
    try {
      plan = await callWithChain({
        models: EXTRACT_MODEL_CHAIN,
        system: CATCHUP_SYSTEM_PROMPT,
        userContent,
        maxTokens: 1024,
        jsonMode: true,
        validate: parseExtractionJson,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        return res.status(429).json({ error: 'Loop is a little busy — try Fix my week again in a minute.' });
      }
      return res.status(502).json({ error: "Couldn't rework the plan just now — try again shortly." });
    }

    let moved = 0;
    for (const r of Array.isArray(plan.reschedules) ? plan.reschedules : []) {
      const task = overdue[Number(r.n) - 1];
      const newDue = resolveDate(r.due_phrase, tzOffset);
      if (!task || !newDue || new Date(newDue) <= new Date()) continue; // never reschedule into the past
      const { error } = await supabase
        .from('tasks')
        .update({ due: newDue, due_phrase: r.due_phrase || null })
        .eq('id', task.id)
        .eq('user_id', req.userId);
      if (!error) moved++;
    }

    res.json({
      moved,
      message: typeof plan.message === 'string' && plan.message
        ? plan.message
        : `Rescheduled ${moved} thing${moved === 1 ? '' : 's'} into the days ahead. Clean slate.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.patch('/api/tasks/:id/toggle', async (req, res) => {
  // Scoped by user_id so no one can toggle someone else's task.
  const { data: task, error: findErr } = await supabase
    .from('tasks')
    .select('id, done')
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!task) return res.status(404).json({ error: 'Not found' });
  const { data, error } = await supabase
    .from('tasks')
    .update({ done: !task.done })
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(mapRow(data));
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { error } = await supabase.from('tasks').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/events/:id', async (req, res) => {
  const { error } = await supabase.from('events').delete().eq('id', req.params.id).eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`voice-life-os running at http://localhost:${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('WARNING: OPENROUTER_API_KEY is not set. Add it to your .env file.');
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
    console.warn('WARNING: One or more SUPABASE_* env vars are missing. Login and data storage will not work.');
  }
});
