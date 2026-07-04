const micButton = document.getElementById('micButton');
const captureHint = document.getElementById('captureHint');
const liveTranscript = document.getElementById('liveTranscript');
const resultsPanel = document.getElementById('resultsPanel');
const resultsList = document.getElementById('resultsList');
const profilePill = document.getElementById('profilePill');
const textForm = document.getElementById('textForm');
const textInput = document.getElementById('textInput');
const textSubmit = document.getElementById('textSubmit');

// Auth-related elements
const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('appRoot');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginSubmit = document.getElementById('loginSubmit');
const loginStatus = document.getElementById('loginStatus');
const logoutBtn = document.getElementById('logoutBtn');
const codeForm = document.getElementById('codeForm');
const loginCode = document.getElementById('loginCode');
const codeSubmit = document.getElementById('codeSubmit');

let sb = null; // Supabase browser client (login only)

// ---------- Auth ----------
async function initAuth() {
  try {
    // Grab the public login config from our server (URL + anon key — both safe in the browser).
    let config;
    try {
      config = await fetch('/api/config').then((r) => r.json());
    } catch {
      loginScreen.hidden = false;
      loginStatus.textContent = 'Could not reach the server. Is it running?';
      return;
    }

    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      loginScreen.hidden = false;
      loginStatus.textContent = 'Login is not configured yet (missing Supabase settings).';
      return;
    }

    if (!window.supabase || !window.supabase.createClient) {
      loginScreen.hidden = false;
      loginStatus.textContent = 'Login library failed to load — check your connection and refresh.';
      return;
    }

    sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        flowType: 'implicit',
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    });

    // If Supabase sent back an error in the URL, show it instead of silently bouncing to login.
    const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(location.search || '');
    const urlError = hashParams.get('error_description') || queryParams.get('error_description');
    if (urlError) {
      showLogin();
      loginStatus.textContent = 'Login error: ' + urlError.replace(/\+/g, ' ');
      return;
    }

    // Only react to EXPLICIT sign-in/sign-out. The old code treated any event with a
    // null session (cross-tab noise, INITIAL_SESSION, refresh hiccups) as "logged out"
    // and bounced the user back to the login screen even after a successful login.
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) showApp();
      if (event === 'SIGNED_OUT') showLogin();
    });

    // Decide the initial screen based on any existing session.
    const { data, error } = await sb.auth.getSession();
    if (error) console.error('getSession error:', error.message);
    if (data.session) showApp();
    else showLogin();
  } catch (err) {
    // NEVER fail silently — a startup crash previously left users staring at a dead page.
    loginScreen.hidden = false;
    loginStatus.textContent = 'Startup error: ' + (err.message || err);
  }
}

function showLogin() {
  appRoot.hidden = true;
  loginScreen.hidden = false;
  // Reset back to the "enter email" step so a fresh login always starts clean.
  codeForm.hidden = true;
  loginForm.hidden = false;
}

let appShown = false;
function showApp() {
  loginScreen.hidden = true;
  appRoot.hidden = false;
  if (!appShown) {
    appShown = true;
    refreshAllPanels();
  }
}

// Step 1: request a 6-digit code by email. No link, no redirect — nothing to bounce or expire
// silently. This sidesteps the whole class of magic-link problems (email scanners consuming
// the link before the user clicks it, browsers stripping the URL, PWA redirect quirks, etc).
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail.value.trim();
  if (!email || !sb) return;
  loginSubmit.disabled = true;
  loginStatus.textContent = 'Sending…';
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  loginSubmit.disabled = false;
  if (error) {
    loginStatus.textContent = error.message || 'Something went wrong — try again.';
    return;
  }
  loginForm.hidden = true;
  codeForm.hidden = false;
  loginCode.focus();
  loginStatus.textContent = '✓ Code sent! Use the code from the NEWEST email — requesting a new code kills all older ones.';
});

// Step 2: type the code back in. This calls Supabase directly and gets a session
// immediately — no URL involved at all.
codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = loginEmail.value.trim();
  const token = loginCode.value.replace(/\D/g, ''); // strip spaces/dashes people paste from email
  if (!email) { loginStatus.textContent = 'Email is missing — refresh and start again.'; return; }
  if (!token) { loginStatus.textContent = 'Type the number code from the email.'; return; }
  if (!sb) { loginStatus.textContent = 'Login library not ready — refresh the page.'; return; }
  codeSubmit.disabled = true;
  loginStatus.textContent = 'Verifying…';
  try {
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      loginStatus.textContent = 'Login failed: ' + error.message + ' — request a fresh code and use the NEWEST email.';
      return;
    }
    if (!data || !data.session) {
      // Should never happen; if it does, we want to SEE it, not stare at a dead screen.
      loginStatus.textContent = 'Verified, but no session came back. Screenshot this and report it.';
      return;
    }
    loginStatus.textContent = 'Logged in ✓';
    // Switch screens immediately with the session we just received — never wait on the
    // async auth event, which is exactly what left users stuck on login after success.
    showApp();
  } catch (err) {
    loginStatus.textContent = 'Unexpected error: ' + (err.message || err);
  } finally {
    codeSubmit.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  if (sb) await sb.auth.signOut();
  appShown = false;
  showLogin();
});

// Every call to our own API carries the logged-in user's token so the server knows who's asking.
async function authedFetch(url, opts = {}) {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    // Session expired — bounce back to login.
    appShown = false;
    showLogin();
  }
  return res;
}

// ---------- Voice capture ----------
let recognizing = false;
let recognition = null;

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionAPI) {
  captureHint.textContent = 'Voice needs Chrome, Edge, or Brave — but you can type your note below instead.';
  micButton.disabled = true;
} else {
  recognition = new SpeechRecognitionAPI();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    liveTranscript.textContent = transcript;
  };

  recognition.onend = () => {
    if (recognizing) {
      // Auto-restart if the browser cut it off mid-recording while user is still holding the session.
      recognition.start();
    }
  };

  micButton.addEventListener('click', () => {
    if (!recognizing) {
      startListening();
    } else {
      stopListening();
    }
  });
}

function startListening() {
  recognizing = true;
  liveTranscript.textContent = '';
  micButton.classList.add('listening');
  captureHint.textContent = 'Listening — tap again when you\'re done.';
  recognition.start();
}

function stopListening() {
  recognizing = false;
  micButton.classList.remove('listening');
  recognition.stop();
  const transcript = liveTranscript.textContent.trim();
  if (transcript) {
    captureHint.textContent = 'Working on it...';
    processTranscript(transcript);
  } else {
    captureHint.textContent = 'Tap to say what\'s on your mind — a task, a plan, how training\'s going, anything.';
  }
}

async function processTranscript(transcript) {
  textSubmit.disabled = true;
  try {
    const res = await authedFetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        // Positive = ahead of UTC (e.g. India = +330). Lets the server resolve
        // "tomorrow at 7am" in YOUR timezone, not the server's.
        tz_offset_minutes: -new Date().getTimezoneOffset(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      captureHint.textContent = data.error || 'Something went wrong — try again.';
      return;
    }
    showResults(data.parsed);
    updateProfilePill(data.profile);
    refreshAllPanels();
    captureHint.textContent = 'Got it. Capture another whenever you like.';
  } catch (err) {
    captureHint.textContent = 'Could not reach the server. Is it running?';
    console.error(err);
  } finally {
    textSubmit.disabled = false;
  }
}

// Typed capture — works in every browser (Safari, Firefox, desktop) and when voice mishears.
textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  captureHint.textContent = 'Working on it...';
  processTranscript(text);
});

function showResults(parsed) {
  resultsList.innerHTML = '';
  const items = [
    ...(parsed.tasks || []).map((t) => ({ tag: 'task', label: t.title, meta: t.due || t.due_phrase })),
    ...(parsed.events || []).map((e) => ({ tag: 'event', label: e.title, meta: e.start || e.start_phrase })),
    ...(parsed.notes || []).map((n) => ({ tag: 'note', label: n, meta: null })),
  ];

  if (items.length === 0) {
    resultsPanel.hidden = true;
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'result-item';
    row.innerHTML = `<span class="result-tag ${item.tag}">${item.tag}</span><span>${escapeHtml(item.label)}${item.meta ? ` · ${formatDate(item.meta)}` : ''}</span>`;
    resultsList.appendChild(row);
  });
  resultsPanel.hidden = false;
}

function updateProfilePill(profileSummary) {
  profilePill.textContent = profileSummary
    ? (profileSummary.length > 60 ? profileSummary.slice(0, 60) + '…' : profileSummary)
    : 'Still getting to know you';
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).hidden = false;
  });
});

// ---------- Data panels ----------
async function refreshAllPanels() {
  const [tasks, events, notes, profile] = await Promise.all([
    authedFetch('/api/tasks').then((r) => r.json()),
    authedFetch('/api/events').then((r) => r.json()),
    authedFetch('/api/notes').then((r) => r.json()),
    authedFetch('/api/profile').then((r) => r.json()),
  ]);

  renderTasks(tasks);
  renderEvents(events);
  renderNotes(notes);
  renderProfile(profile);
  renderToday(tasks, events);
  updateProfilePill(profile.summary);
}

function renderToday(tasks, events) {
  const panel = document.getElementById('panel-today');
  const todayStr = new Date().toDateString();
  const todaysTasks = tasks.filter((t) => !t.done && (!t.due || new Date(t.due).toDateString() === todayStr));
  const todaysEvents = events.filter((e) => !e.start || new Date(e.start).toDateString() === todayStr);

  panel.innerHTML = '';
  if (todaysTasks.length === 0 && todaysEvents.length === 0) {
    panel.innerHTML = '<div class="empty-state">Nothing captured yet. Tap the mic above to get started.</div>';
    return;
  }
  todaysEvents.forEach((e) => panel.appendChild(buildCard(e, 'event')));
  todaysTasks.forEach((t) => panel.appendChild(buildCard(t, 'task')));
}

function renderTasks(tasks) {
  const panel = document.getElementById('panel-tasks');
  panel.innerHTML = '';
  if (tasks.length === 0) {
    panel.innerHTML = '<div class="empty-state">No tasks yet.</div>';
    return;
  }
  tasks
    .slice()
    .reverse()
    .forEach((t) => panel.appendChild(buildCard(t, 'task')));
}

function renderEvents(events) {
  const panel = document.getElementById('panel-events');
  panel.innerHTML = '';
  if (events.length === 0) {
    panel.innerHTML = '<div class="empty-state">No events yet.</div>';
    return;
  }
  events
    .slice()
    .reverse()
    .forEach((e) => panel.appendChild(buildCard(e, 'event')));
}

function renderNotes(notes) {
  const panel = document.getElementById('panel-notes');
  panel.innerHTML = '';
  if (notes.length === 0) {
    panel.innerHTML = '<div class="empty-state">No notes yet.</div>';
    return;
  }
  notes
    .slice()
    .reverse()
    .forEach((n) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-body"><p class="card-title">${escapeHtml(n.text)}</p><div class="card-meta">${n.mood ? `<span>mood: ${escapeHtml(n.mood)}</span>` : ''}<span>${formatDate(n.createdAt)}</span></div></div>`;
      panel.appendChild(card);
    });
}

function renderProfile(profile) {
  const panel = document.getElementById('panel-profile');
  panel.innerHTML = `
    <div class="profile-card">
      <h3>What Loop has learned</h3>
      ${profile.summary ? `<p>${escapeHtml(profile.summary)}</p>` : '<p class="profile-empty">Keep capturing voice notes — Loop builds this picture over time and uses it to tune how it phrases tasks and reminders for you.</p>'}
    </div>
  `;
}

function buildCard(item, type) {
  const card = document.createElement('div');
  card.className = 'card';

  if (type === 'task') {
    card.innerHTML = `
      <button class="card-checkbox ${item.done ? 'done' : ''}" data-id="${item.id}" data-kind="task"></button>
      <div class="card-body">
        <p class="card-title ${item.done ? 'done' : ''}">${escapeHtml(item.title)}</p>
        <div class="card-meta">
          ${item.due ? `<span>${formatDate(item.due)}</span>` : ''}
          <span class="priority-${item.priority}">${item.priority}</span>
        </div>
      </div>
      <button class="card-delete" data-id="${item.id}" data-kind="task">×</button>
    `;
  } else {
    card.innerHTML = `
      <div class="card-body">
        <p class="card-title">${escapeHtml(item.title)}</p>
        <div class="card-meta">
          ${item.start ? `<span>${formatDate(item.start)}</span>` : '<span>No time set</span>'}
          ${item.duration_minutes ? `<span>${item.duration_minutes} min</span>` : ''}
        </div>
      </div>
      <button class="card-delete" data-id="${item.id}" data-kind="event">×</button>
    `;
  }

  card.querySelectorAll('[data-kind="task"]').forEach((el) => {
    if (el.classList.contains('card-checkbox')) {
      el.addEventListener('click', async () => {
        await authedFetch(`/api/tasks/${item.id}/toggle`, { method: 'PATCH' });
        refreshAllPanels();
      });
    } else {
      el.addEventListener('click', async () => {
        await authedFetch(`/api/tasks/${item.id}`, { method: 'DELETE' });
        refreshAllPanels();
      });
    }
  });

  card.querySelectorAll('[data-kind="event"]').forEach((el) => {
    el.addEventListener('click', async () => {
      await authedFetch(`/api/events/${item.id}`, { method: 'DELETE' });
      refreshAllPanels();
    });
  });

  return card;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Support the PWA "Quick capture" shortcut: /?listen=1 jumps straight into recording (once logged in).
if (new URLSearchParams(location.search).get('listen') === '1' && recognition) {
  window.addEventListener('load', () => {
    if (!appRoot.hidden) startListening();
  });
}

// Kick everything off.
initAuth();
