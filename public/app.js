const micButton = document.getElementById('micButton');
const captureHint = document.getElementById('captureHint');
const liveTranscript = document.getElementById('liveTranscript');
const resultsPanel = document.getElementById('resultsPanel');
const resultsList = document.getElementById('resultsList');
const profilePill = document.getElementById('profilePill');

let recognizing = false;
let recognition = null;

const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionAPI) {
  captureHint.textContent = 'Voice capture needs a Chromium-based browser (Chrome, Edge, Brave). You can still browse tasks below.';
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
  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    if (!res.ok) {
      captureHint.textContent = `Something went wrong: ${data.error || 'unknown error'}`;
      return;
    }
    showResults(data.parsed);
    updateProfilePill(data.profile);
    refreshAllPanels();
    captureHint.textContent = 'Got it. Tap to capture another note.';
  } catch (err) {
    captureHint.textContent = 'Could not reach the server. Is it running?';
    console.error(err);
  }
}

function showResults(parsed) {
  resultsList.innerHTML = '';
  const items = [
    ...(parsed.tasks || []).map((t) => ({ tag: 'task', label: t.title, meta: t.due })),
    ...(parsed.events || []).map((e) => ({ tag: 'event', label: e.title, meta: e.start })),
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
    fetch('/api/tasks').then((r) => r.json()),
    fetch('/api/events').then((r) => r.json()),
    fetch('/api/notes').then((r) => r.json()),
    fetch('/api/profile').then((r) => r.json()),
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
        await fetch(`/api/tasks/${item.id}/toggle`, { method: 'PATCH' });
        refreshAllPanels();
      });
    } else {
      el.addEventListener('click', async () => {
        await fetch(`/api/tasks/${item.id}`, { method: 'DELETE' });
        refreshAllPanels();
      });
    }
  });

  card.querySelectorAll('[data-kind="event"]').forEach((el) => {
    el.addEventListener('click', async () => {
      await fetch(`/api/events/${item.id}`, { method: 'DELETE' });
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

// Support the PWA "Quick capture" shortcut: /?listen=1 jumps straight into recording.
if (new URLSearchParams(location.search).get('listen') === '1' && recognition) {
  window.addEventListener('load', () => startListening());
}

refreshAllPanels();
