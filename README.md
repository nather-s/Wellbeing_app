# Loop — Voice Life OS

Speak a thought out loud, and it becomes a task, a calendar event, or a note —
automatically sorted, with due dates resolved from natural language. Over time
it builds a short profile of how you think and like to be reminded, and uses
that to make its output feel like it actually knows you.

This is a **working local prototype**, not just a mockup. It runs on your
machine right now. The second half of this file explains what to change to
turn it into something you could put on the app stores.

---

## 1. What's actually in this folder

```
voice-life-os/
  server.js          → backend: receives transcript, calls Claude, stores data
  package.json
  .env.example        → copy to .env and add your API key
  public/
    index.html         → the widget UI
    style.css
    app.js              → mic capture (Web Speech API) + rendering
    manifest.json       → makes it installable as a PWA with a quick-capture shortcut
    icon.svg
  data/store.json     → created automatically the first time you run it
```

## 2. Exact setup steps

**Prerequisites:** Node.js 18 or newer installed on your computer. This
version calls Claude-alternative free models through **OpenRouter**, so it
costs nothing to run — no credit needed on the account at all.

1. Download/unzip this folder anywhere on your computer, e.g. `~/Projects/voice-life-os`.
2. Open a terminal in that folder.
3. Install dependencies:
   ```
   npm install
   ```
4. Your API key is already in `.env` (I put it there for you — see the
   security note below). Nothing else to configure; free models work at $0
   balance.
5. Start it:
   ```
   npm start
   ```
6. Open **http://localhost:3000** in **Chrome or Edge** (voice capture needs
   the Web Speech API, which Safari and Firefox don't support yet).
7. Tap the mic button, say something like *"Remind me to email my coach
   tomorrow at 6pm about the meet schedule, and I've got a chem test Friday
   I'm dreading"* — tap again to stop. You'll see it get split into a task,
   an event, and a note, all with resolved dates.
8. Talk to it a few more times about different things (school, training,
   whatever) — after about 5 notes, check the **About you** tab. That's the
   personality profile forming.

That's the whole local prototype. Everything is stored in `data/store.json`
on your machine — nothing leaves except the transcript text sent to
OpenRouter to be processed.

**Security note on the key:** it's sitting in plaintext in `.env`, which is
listed in `.gitignore` so it won't get committed if you push this to GitHub —
double check that before your first commit. Since you also pasted this key
directly into a chat, treat it as semi-exposed: if you ever share this
project folder, this chat log, or a screenshot of it with anyone, rotate the
key at openrouter.ai/settings/keys first and swap in the new one.

## 3. Why it's built this way (so you can extend it)

- **Runs entirely on free models** — `openai/gpt-oss-20b:free` for every voice
  note, and the larger `openai/gpt-oss-120b:free` for the occasional profile
  rewrite. Zero cost, no credits needed, works with a $0 OpenRouter balance.
  If one of them gets rate-limited or rotated out of the free tier (OpenRouter's
  free list changes — check openrouter.ai/models), the app automatically
  retries once against `openrouter/free`, a router that picks *some* working
  free model for you.
- **The catch with free**: OpenRouter's free tier is capped around 20
  requests/minute and 200/day combined across all free models, and quality is
  a notch below Claude on trickier extractions (nested dates, ambiguous
  phrasing). That's the right tradeoff for an MVP you're testing on yourself.
  When you're ready to charge or ship to real users, swap `MODEL_EXTRACT` and
  `MODEL_CONSOLIDATE` in `server.js` back to a paid Claude model
  (`anthropic/claude-haiku-4.5` / `anthropic/claude-sonnet-5`) — same code,
  same API, just remove the `:free` and add credit to the account.
- **The API key never touches the browser.** It lives in `.env` on the
  server, and the frontend only ever talks to your own `/api/...` routes.
  This is a real security requirement, not a style choice — anyone could
  read a key embedded in frontend JavaScript and rack up charges on it.
- **Storage is a flat JSON file** on purpose, so you can open
  `data/store.json` and literally see what the app knows, with zero setup.
  Swap this for a real database once you have more than one user (see below).

## 4. Turning this into a real, shippable product

This prototype proves the concept. Here's what changes at each stage of making
it a real multi-user product:

### Stage 1 — Multi-user web app
- **Auth**: add an auth provider (Clerk, Auth0, or Supabase Auth) so each
  person has their own account instead of one shared `store.json`.
- **Database**: move from the JSON file to Postgres (Supabase or Railway both
  give you this instantly, minimal config change from what's here).
- **Hosting**: deploy `server.js` as-is to Render, Railway, or Fly.io — all
  have free tiers and a `git push` deploy flow.

### Stage 2 — True mobile app with a home-screen widget
The web version can be installed via "Add to Home Screen" today (that's what
`manifest.json` does), but that's a shortcut, not a real OS widget. A widget
like Shazam's needs native code:
- Wrap this app with **Capacitor** (capacitorjs.com) to ship it as a real iOS
  and Android app from the same JS/HTML you already have — this gets you 90%
  of the way with almost no rewrite.
- For the actual home-screen widget: Android uses **Jetpack Glance**
  (Kotlin), iOS uses **WidgetKit** (Swift). Both are small, separate native
  modules that just need to read the same task/event data — they don't
  require rewriting the whole app, just a thin native layer that talks to
  your backend.
- **Push notifications for reminders**: web notifications only fire while a
  tab is open. Real "it's time" reminders need Firebase Cloud Messaging
  (Android/web) and APNs (iOS) — this is the single most important upgrade
  for the app to feel alive rather than passive.

### Stage 3 — Cross-browser, more robust voice capture
Web Speech API is Chrome/Edge-only and needs an internet connection. For a
real product, record audio with `MediaRecorder` and send it to a
speech-to-text API (Whisper via OpenAI, or Anthropic doesn't currently offer
STT directly) — this also means voice quality no longer depends on the
browser the person happens to be using.

### Privacy note worth taking seriously
Voice transcripts and the personality profile are sensitive by nature —
they'll contain health, academic, and emotional information. Before this
touches real users: encrypt `data` at rest, never log raw transcripts in
production, and give people a clear way to delete their profile entirely.

---

## 5. If you want this to serve a broad audience, not just yourself

The prompts in `server.js` are already written generically (students,
professionals, parents, freelancers) rather than swim/school-specific — the
personalization happens automatically per-user through the evolving profile,
not through hardcoded categories. The one thing worth deciding early is your
wedge: pick one use case (e.g. "the fastest way to brain-dump your day by
voice") to nail first, get a few real people using it daily, and let the
profile/personalization feature be the thing that makes them stick around
rather than the headline feature you lead with.
