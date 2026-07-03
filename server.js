import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as chrono from 'chrono-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
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

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { tasks: [], events: [], notes: [], profile: { summary: '', log: [] } };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const EXTRACT_SYSTEM_PROMPT = `You are the extraction engine behind a voice-first personal organizer used by all kinds of people (students, professionals, parents, freelancers) — not a niche tool.

Given a raw spoken-language transcript, pull out anything actionable or worth remembering. Return ONLY valid JSON (no prose, no markdown fences) matching exactly this shape:

{
  "tasks": [{"title": string, "due_phrase": string|null, "priority": "low"|"medium"|"high"}],
  "events": [{"title": string, "start_phrase": string|null, "duration_minutes": number|null}],
  "notes": [string],
  "mood_signal": string|null,
  "profile_update": string|null
}

Rules:
- "due_phrase" / "start_phrase": copy the EXACT time words the person said, verbatim (e.g. "tomorrow at 7am", "next Friday evening", "in two hours"). Do NOT convert to a date yourself — just quote the phrase. If no time was mentioned, use null.
- "tasks" are things to do. "events" are things at a specific time. "notes" are anything reflective, emotional, or worth remembering that isn't a task or event.
- "profile_update": one short sentence capturing something durable and specific you learned about how this person thinks, works, trains, or likes to be reminded — never a summary of what they just said. Return null if nothing new was learned.
- If a category is empty, return an empty array.
- Never invent details that weren't said or clearly implied.`;

const CONSOLIDATE_SYSTEM_PROMPT = `Condense the following list of observations about one person into a single short paragraph (max 80 words) describing how they think, work, and like to be reminded or supported. Be specific and concrete, not generic. Return only the paragraph, nothing else.`;

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

app.post('/api/process', async (req, res) => {
  try {
    const { transcript, tz_offset_minutes } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Empty transcript' });
    }
    const tzOffset = Number.isFinite(tz_offset_minutes) ? tz_offset_minutes : null;

    const data = loadData();
    const now = new Date().toISOString();

    const userContent = `Current date/time (UTC): ${now}
Known profile so far: ${data.profile.summary || '(none yet)'}

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

    const newTasks = [];
    const newEvents = [];
    const newNotes = [];

    for (const t of parsed.tasks || []) {
      // Date math happens HERE via chrono-node, not in the model. Fall back to a model-provided
      // ISO string ("due") only if the fallback router returned the old schema, else null.
      const due = resolveDate(t.due_phrase, tzOffset) || t.due || null;
      const task = { id: randomUUID(), title: t.title, due, due_phrase: t.due_phrase || null, priority: t.priority || 'medium', done: false, createdAt: now };
      data.tasks.push(task);
      newTasks.push(task);
    }
    for (const e of parsed.events || []) {
      const start = resolveDate(e.start_phrase, tzOffset) || e.start || null;
      const event = { id: randomUUID(), title: e.title, start, start_phrase: e.start_phrase || null, duration_minutes: e.duration_minutes, createdAt: now };
      data.events.push(event);
      newEvents.push(event);
    }
    for (const n of parsed.notes || []) {
      const note = { id: randomUUID(), text: n, mood: parsed.mood_signal || null, createdAt: now };
      data.notes.push(note);
      newNotes.push(note);
    }

    if (parsed.profile_update) {
      data.profile.log.push({ text: parsed.profile_update, at: now });
      data.profile.summary = await consolidateProfile(data.profile);
    }

    saveData(data);
    res.json({
      transcript,
      // "parsed" keeps the shape the frontend expects, but with dates already resolved by chrono.
      parsed: { tasks: newTasks, events: newEvents, notes: newNotes.map((n) => n.text), mood_signal: parsed.mood_signal || null },
      tasks: data.tasks,
      events: data.events,
      notes: data.notes,
      profile: data.profile.summary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.get('/api/tasks', (req, res) => res.json(loadData().tasks));
app.get('/api/events', (req, res) => res.json(loadData().events));
app.get('/api/notes', (req, res) => res.json(loadData().notes));
app.get('/api/profile', (req, res) => res.json(loadData().profile));

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const data = loadData();
  const task = data.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  task.done = !task.done;
  saveData(data);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  data.tasks = data.tasks.filter((t) => t.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/events/:id', (req, res) => {
  const data = loadData();
  data.events = data.events.filter((e) => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`voice-life-os running at http://localhost:${PORT}`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('WARNING: OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
});
