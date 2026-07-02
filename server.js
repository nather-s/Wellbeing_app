import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'store.json');
const MODEL_EXTRACT = 'openai/gpt-oss-20b:free'; // free tier, runs on every voice note
const MODEL_CONSOLIDATE = 'openai/gpt-oss-120b:free'; // free tier, runs occasionally for higher quality
const MODEL_FALLBACK = 'openrouter/free'; // auto-picks *some* free model if the primary one is down/rate-limited

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
  "tasks": [{"title": string, "due": string|null, "priority": "low"|"medium"|"high"}],
  "events": [{"title": string, "start": string|null, "duration_minutes": number|null}],
  "notes": [string],
  "mood_signal": string|null,
  "profile_update": string|null
}

Rules:
- Resolve relative dates/times ("tomorrow", "next Friday at 6") into ISO 8601 using the current date/time given below. If no date is mentioned, use null.
- "tasks" are things to do. "events" are things at a specific time. "notes" are anything reflective, emotional, or worth remembering that isn't a task or event.
- "profile_update": one short sentence capturing something durable and specific you learned about how this person thinks, works, trains, or likes to be reminded — never a summary of what they just said. Return null if nothing new was learned.
- If a category is empty, return an empty array.
- Never invent details that weren't said or clearly implied.`;

const CONSOLIDATE_SYSTEM_PROMPT = `Condense the following list of observations about one person into a single short paragraph (max 80 words) describing how they think, work, and like to be reminded or supported. Be specific and concrete, not generic. Return only the paragraph, nothing else.`;

async function callClaude({ model, system, userContent, maxTokens }) {
  const attempt = async (m) => {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        // These two headers are optional but OpenRouter uses them for its public leaderboards/rankings.
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Loop - Voice Life OS',
      },
      body: JSON.stringify({
        model: m,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenRouter API error (${resp.status}) for ${m}: ${errText}`);
    }
    const result = await resp.json();
    return (result.choices?.[0]?.message?.content || '').trim();
  };

  try {
    return await attempt(model);
  } catch (err) {
    // Free models get rate-limited (429) or occasionally rotated out — fall back to the free router once.
    console.warn(`Primary model failed, retrying with fallback: ${err.message}`);
    return await attempt(MODEL_FALLBACK);
  }
}

async function consolidateProfile(profile) {
  // Only spend a real model call every 5 new observations; otherwise just append cheaply.
  if (profile.log.length % 5 !== 0) {
    return [profile.summary, profile.log[profile.log.length - 1].text].filter(Boolean).join(' ');
  }
  try {
    const text = await callClaude({
      model: MODEL_CONSOLIDATE,
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
    const { transcript } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Empty transcript' });
    }

    const data = loadData();
    const now = new Date().toISOString();

    const userContent = `Current date/time: ${now}
Known profile so far: ${data.profile.summary || '(none yet)'}

Voice note transcript:
"""${transcript}"""`;

    let rawText;
    try {
      rawText = await callClaude({
        model: MODEL_EXTRACT,
        system: EXTRACT_SYSTEM_PROMPT,
        userContent,
        maxTokens: 1024,
      });
    } catch (err) {
      console.error(err.message);
      return res.status(502).json({ error: 'Model call failed', detail: err.message });
    }

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model JSON:', rawText);
      return res.status(502).json({ error: 'Model returned unparseable response' });
    }

    for (const t of parsed.tasks || []) {
      data.tasks.push({ id: randomUUID(), title: t.title, due: t.due, priority: t.priority || 'medium', done: false, createdAt: now });
    }
    for (const e of parsed.events || []) {
      data.events.push({ id: randomUUID(), title: e.title, start: e.start, duration_minutes: e.duration_minutes, createdAt: now });
    }
    for (const n of parsed.notes || []) {
      data.notes.push({ id: randomUUID(), text: n, mood: parsed.mood_signal || null, createdAt: now });
    }

    if (parsed.profile_update) {
      data.profile.log.push({ text: parsed.profile_update, at: now });
      data.profile.summary = await consolidateProfile(data.profile);
    }

    saveData(data);
    res.json({
      transcript,
      parsed,
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
