/* ==========================================
   FILE: app.js
   Chứa toàn bộ logic xử lý của ứng dụng
   ========================================== */

/* ============ STORAGE ============ */
const STORE_KEY = 'vocabmaster_v1';
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveStore(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
let store = loadStore();

// Build a lookup from word id → word object (for fast access from anywhere)
const WORD_INDEX = {};
VOCAB_DATA.forEach(t => t.words.forEach(w => { WORD_INDEX[w.id] = w; }));

// Find a word object by its English text (used by IPA/synonym lookups)
const WORD_BY_EN = {};
VOCAB_DATA.forEach(t => t.words.forEach(w => {
  WORD_BY_EN[w.en.toLowerCase().trim()] = w;
}));

function getIpaFor(wordEn) {
  const w = WORD_BY_EN[wordEn.toLowerCase().trim()];
  return w && w.ipa ? w.ipa : '';
}

function getSynonymsFor(wordEn) {
  const w = WORD_BY_EN[wordEn.toLowerCase().trim()];
  return (w && w.synonyms) || [];
}

// word record: { state: 'new'|'learning'|'review', ef, interval, reps, due, lapses }
function getRec(wid) {
  if (!store.words) store.words = {};
  if (!store.words[wid]) {
    store.words[wid] = { state: 'new', ef: 2.5, interval: 0, reps: 0, due: Date.now(), lapses: 0 };
  } else {
    const r = store.words[wid];
    if (r.state === 'review' && r.interval > 0 && r.interval < 60000) {
      r.interval = r.interval * 86400000;
      r.due = Date.now() + r.interval;
      saveStore(store);
    }
  }
  return store.words[wid];
}
function saveRec(wid, rec) {
  store.words[wid] = rec;
  saveStore(store);
}

/* ============ DAILY GOAL & STREAK ============ */
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(aStr, bStr) {
  const a = new Date(aStr + 'T00:00:00');
  const b = new Date(bStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

const DEFAULT_GOAL = { newWords: 10, reviews: 999 };

function getGoal() {
  if (!store.goal) {
    store.goal = { ...DEFAULT_GOAL };
    saveStore(store);
  }
  return store.goal;
}

function setGoal(newWords) {
  store.goal = { ...(store.goal || DEFAULT_GOAL), newWords };
  saveStore(store);
}

function getTodayProgress() {
  if (!store.today || store.today.day !== todayKey()) {
    store.today = { day: todayKey(), ratedCount: 0 };
    saveStore(store);
  }
  return store.today;
}

function getStreak() {
  if (!store.streak) {
    store.streak = { current: 0, longest: 0, lastStudyDay: null };
    saveStore(store);
  }
  return store.streak;
}

function recordStudyAction() {
  const today = todayKey();
  const progress = getTodayProgress();
  progress.ratedCount += 1;
  store.today = progress;

  const streak = getStreak();
  if (streak.lastStudyDay !== today) {
    if (streak.lastStudyDay === null) {
      streak.current = 1;
    } else {
      const gap = daysBetween(streak.lastStudyDay, today);
      if (gap === 1) streak.current += 1;
      else if (gap === 0) {/* already counted */}
      else streak.current = 1;
    }
    streak.longest = Math.max(streak.longest, streak.current);
    streak.lastStudyDay = today;
    store.streak = streak;
  }
  saveStore(store);
}

/* ============ SRS ============ */
const GRAD_INTERVAL_MS = {
  0: 10 * 60 * 1000,
  1: 1 * 24 * 3600 * 1000,
  2: 3 * 24 * 3600 * 1000,
  3: 7 * 24 * 3600 * 1000,
};

function applySrs(rec, rating) {
  const now = Date.now();
  const DAY = 86400000;

  if (rating === 0) {
    rec.state = 'learning';
    rec.interval = GRAD_INTERVAL_MS[0];
    rec.reps = 0;
    rec.lapses = (rec.lapses || 0) + 1;
    rec.ef = Math.max(1.3, (rec.ef || 2.5) - 0.2);
  } else if (rec.state !== 'review') {
    rec.state = 'review';
    rec.reps = 1;
    rec.interval = GRAD_INTERVAL_MS[rating];
    if (rating === 1) rec.ef = Math.max(1.3, (rec.ef || 2.5) - 0.15);
    else if (rating === 3) rec.ef = (rec.ef || 2.5) + 0.15;
  } else {
    rec.reps = (rec.reps || 1) + 1;
    const ef = rec.ef || 2.5;
    let multiplier;
    if (rating === 1) multiplier = 1.2;
    else if (rating === 2) multiplier = ef;
    else multiplier = ef * 1.3;
    rec.interval = Math.round((rec.interval || DAY) * multiplier);
    rec.interval = Math.min(rec.interval, 180 * DAY);
    if (rating === 1) rec.ef = Math.max(1.3, ef - 0.15);
    else if (rating === 3) rec.ef = ef + 0.15;
  }
  rec.due = now + rec.interval;
}

function formatInterval(ms) {
  const m = ms / 60000;
  if (m < 60) return Math.round(m) + 'm';
  const h = m / 60;
  if (h < 24) return Math.round(h) + 'h';
  const d = h / 24;
  if (d < 30) return Math.round(d) + 'd';
  const mo = d / 30;
  if (mo < 12) return Math.round(mo) + 'mo';
  return (mo / 12).toFixed(1) + 'y';
}

function srsIntervalPreview(rec, rating) {
  const r = JSON.parse(JSON.stringify(rec));
  applySrs(r, rating);
  return formatInterval(r.due - Date.now());
}

/* ============ COUNTS & RENDER HOME ============ */
function getCounts(topic) {
  const now = Date.now();
  let newC = 0, learn = 0, review = 0;
  topic.words.forEach(w => {
    const r = getRec(w.id);
    if (r.state === 'new') newC++;
    else if (r.state === 'learning' || (r.state === 'review' && r.due <= now)) {
      if (r.state === 'review') review++;
      else learn++;
    }
  });
  return { newC, learn, review, total: topic.words.length, done: topic.words.filter(w => getRec(w.id).state === 'review' && getRec(w.id).due > now).length };
}

function getTotalCounts() {
  let newC = 0, learn = 0, review = 0;
  VOCAB_DATA.forEach(t => {
    const c = getCounts(t);
    newC += c.newC; learn += c.learn; review += c.review;
  });
  return { newC, learn, review };
}

const accents = [
  { bg: '#dbeafe', fg: '#2563eb' },
  { bg: '#fef3c7', fg: '#b45309' },
  { bg: '#fce7f3', fg: '#be185d' },
  { bg: '#dcfce7', fg: '#15803d' },
  { bg: '#ede9fe', fg: '#6d28d9' },
];

function renderHome() {
  const grid = document.getElementById('topicGrid');
  grid.innerHTML = '';
  VOCAB_DATA.forEach((t, i) => {
    const c = getCounts(t);
    const pct = t.words.length ? Math.round((c.done / t.words.length) * 100) : 0;
    const a = accents[i % accents.length];
    const card = document.createElement('button');
    card.className = 'topic-card';
    card.style.setProperty('--accent', a.fg);
    card.style.setProperty('--accent-soft', a.bg);
    card.innerHTML = `
      <div class="topic-icon" style="color:${a.fg}">${t.icon}</div>
      <div class="topic-name">${t.name_vi}</div>
      <div class="topic-en">${t.name_en}</div>
      <div class="topic-meta">
        <span class="topic-count">${t.words.length} từ</span>
        <span style="color:${a.fg};font-weight:700">${pct}%</span>
      </div>
      <div class="topic-progress-bar"><div class="topic-progress-fill" style="width:${pct}%"></div></div>
      <div class="topic-progress-text">
        <span style="color:var(--primary)">${c.newC} mới</span>
        <span style="color:var(--orange)">${c.review + c.learn} ôn</span>
      </div>
    `;
    card.onclick = () => openTopic(t.id);
    grid.appendChild(card);
  });
  const totals = getTotalCounts();
  document.getElementById('homeNew').textContent = totals.newC;
  document.getElementById('homeLearn').textContent = VOCAB_DATA.reduce((s,t) => s + t.words.filter(w => getRec(w.id).state !== 'new').length, 0);
  document.getElementById('homeReview').textContent = totals.review + totals.learn;

  renderDailyCard();
}

function renderDailyCard() {
  const card = document.getElementById('dailyReviewCard');
  if (!card) return;
  const streak = getStreak();
  const progress = getTodayProgress();
  const goal = getGoal();
  const totals = getTotalCounts();
  const totalDue = totals.review + totals.learn;

  const goalPct = Math.min(100, Math.round(progress.ratedCount / Math.max(1, goal.newWords) * 100));
  const goalMet = progress.ratedCount >= goal.newWords;
  const hasWork = totalDue > 0 || totals.newC > 0;
  const accentColor = goalMet ? 'var(--success)' : (hasWork ? 'var(--primary)' : 'var(--muted)');

  card.innerHTML = `
    <div style="background:white;border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;box-shadow:var(--shadow-sm);position:relative;overflow:hidden">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:20px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="font-size:28px">${streak.current >= 3 ? '🔥' : streak.current >= 1 ? '✨' : '🌱'}</div>
          <div>
            <div style="font-family:'Inter',sans-serif;font-size:24px;font-weight:800;letter-spacing:-0.02em;line-height:1">
              ${streak.current} <span style="font-size:14px;color:var(--ink-soft);font-weight:600">${streak.current === 1 ? 'ngày' : 'ngày liên tiếp'}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">
              ${streak.longest > streak.current ? `Kỷ lục: ${streak.longest} ngày` : streak.current >= 7 ? '🎉 Tuyệt vời!' : 'Giữ vững mỗi ngày'}
            </div>
          </div>
        </div>
        <div style="height:36px;width:1px;background:var(--border)"></div>
        <div style="flex:1;min-width:180px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <div style="font-size:12px;color:var(--muted);font-weight:600;letter-spacing:0.04em">MỤC TIÊU HÔM NAY</div>
            <div style="font-family:'Inter',sans-serif;font-size:13px;font-weight:700;color:${accentColor}">
              ${progress.ratedCount}/${goal.newWords} từ
            </div>
          </div>
          <div style="height:6px;background:var(--bg-soft);border-radius:999px;overflow:hidden">
            <div style="height:100%;background:${accentColor};width:${goalPct}%;transition:width .4s ease"></div>
          </div>
        </div>
        <button onclick="openGoalSettings()" style="background:var(--bg-soft);color:var(--ink-soft);padding:8px;border-radius:8px;display:grid;place-items:center" title="Đổi mục tiêu hằng ngày">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      ${hasWork ? `
      <button onclick="openMixedReview()" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px;background:linear-gradient(120deg,var(--primary),var(--violet));color:white;border-radius:14px;font-weight:700;font-size:15px;text-align:left;box-shadow:0 8px 24px rgba(37,99,235,.25);transition:transform .15s ease;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
        <div>
          <div style="font-family:'Inter',sans-serif;font-size:17px;font-weight:800;letter-spacing:-0.01em">🔀 Ôn tập tổng hợp</div>
          <div style="opacity:.9;font-weight:500;font-size:13px;margin-top:2px">
            ${totalDue > 0 ? `${totalDue} từ đến hạn ôn` : `${totals.newC} từ mới sẵn sàng`} · trộn từ mọi chủ đề
          </div>
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0"><path d="m9 18 6-6-6-6"/></svg>
      </button>
      ` : `
      <div style="padding:20px;background:var(--success-soft);color:var(--success);border-radius:14px;text-align:center;font-weight:600">
        🎉 Hôm nay không còn từ nào cần ôn — tuyệt vời!
      </div>
      `}
    </div>
  `;
}

function openGoalSettings() {
  const goal = getGoal();
  const newGoal = prompt('Số từ mới mỗi ngày (gợi ý: 5-20)?\n\nNghiên cứu cho thấy 10 từ/ngày là sweet spot cho retention dài hạn.', String(goal.newWords));
  if (newGoal === null) return;
  const n = parseInt(newGoal);
  if (isNaN(n) || n < 1 || n > 100) {
    alert('Vui lòng nhập số từ 1 và 100');
    return;
  }
  setGoal(n);
  renderDailyCard();
}

/* ============ STATE ============ */
let currentTopic = null;
let sessionQueue = [];
let currentIdx = 0;
let mainTab = 'learn';
let subTab = 'flash';
let flashFlipped = false;
let xp = 0;

// THỨ TỰ CÁC BƯỚC HỌC MỚI: Đẩy Phát Âm lên trước, Dịch câu ở cuối
const MODE_ORDER = ['flash', 'quiz', 'type', 'pron', 'translate'];

function updateSubTabStates() {
  const curIdx = MODE_ORDER.indexOf(subTab);
  document.querySelectorAll('.sub-tab').forEach(b => {
    const i = MODE_ORDER.indexOf(b.dataset.sub);
    b.classList.remove('done');
    if (i < curIdx) b.classList.add('done');
  });
}

function advanceMode() {
  const curIdx = MODE_ORDER.indexOf(subTab);
  if (curIdx < MODE_ORDER.length - 1) {
    subTab = MODE_ORDER[curIdx + 1];
    document.querySelectorAll('.sub-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.sub === subTab);
    });
    updateSubTabStates();
    const labels = { flash: '1/5: Flashcard', quiz: '2/5: Trắc nghiệm', type: '3/5: Nghe & Gõ', pron: '4/5: Phát âm', translate: '5/5: Dịch câu' };
    document.getElementById('modeLabel').textContent = 'Chế độ ' + labels[subTab];
    flashFlipped = false;
    renderCurrentCard();
  } else {
    awaitingFinalRating = true;
    renderFinalRating();
  }
}

let wordMistakes = 0;
let awaitingFinalRating = false;
let pronRevealed = false;
let isMixedSession = false;

function openTopic(id) {
  currentTopic = VOCAB_DATA.find(t => t.id === id);
  isMixedSession = false;
  buildSessionQueue();
  document.getElementById('home').style.display = 'none';
  document.getElementById('studyPage').classList.add('active');
  document.getElementById('sessionContext').innerHTML = `<span style="color:var(--muted)">Đang học chủ đề:</span> <strong style="color:var(--ink)">${currentTopic.icon} ${currentTopic.name_vi}</strong>`;
  mainTab = 'learn';
  subTab = 'flash';
  wordMistakes = 0;
  pronRevealed = false;
  awaitingFinalRating = false;
  flashFlipped = false;
  xp = 0;
  document.getElementById('xpCount').textContent = '+' + xp;
  switchMain('learn');
}

function openMixedReview() {
  const now = Date.now();
  const dueAll = [];
  const newAll = [];
  for (const t of VOCAB_DATA) {
    for (const w of t.words) {
      const r = getRec(w.id);
      if (r.state === 'new') newAll.push(w);
      else if (r.due <= now) dueAll.push(w);
    }
  }
  if (dueAll.length === 0 && newAll.length === 0) {
    alert('Hôm nay chưa có từ nào đến hạn ôn 🎉');
    return;
  }
  const queue = [
    ...dueAll.sort(() => Math.random() - 0.5),
    ...newAll.sort(() => Math.random() - 0.5).slice(0, 20),
  ];
  currentTopic = {
    id: '__mixed__',
    icon: '🔀',
    name_en: 'Mixed Review',
    name_vi: 'Ôn tập tổng hợp',
    words: VOCAB_DATA.flatMap(t => t.words),
  };
  isMixedSession = true;
  sessionQueue = queue;
  currentIdx = 0;
  document.getElementById('home').style.display = 'none';
  document.getElementById('studyPage').classList.add('active');
  document.getElementById('sessionContext').innerHTML = `<span style="background:linear-gradient(120deg,var(--primary),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700">🔀 Ôn tập tổng hợp</span> · <span style="color:var(--muted)">${queue.length} từ từ mọi chủ đề</span>`;
  mainTab = 'learn';
  subTab = 'flash';
  wordMistakes = 0;
  pronRevealed = false;
  awaitingFinalRating = false;
  flashFlipped = false;
  xp = 0;
  document.getElementById('xpCount').textContent = '+' + xp;
  switchMain('learn');
}

function backHome() {
  document.getElementById('studyPage').classList.remove('active');
  document.getElementById('home').style.display = 'block';
  renderHome();
}

function buildSessionQueue() {
  const now = Date.now();
  const due = [];
  const newW = [];
  currentTopic.words.forEach(w => {
    const r = getRec(w.id);
    if (r.state === 'new') newW.push(w);
    else if (r.due <= now) due.push(w);
  });
  sessionQueue = [...due, ...newW.slice(0, 20)];
  if (sessionQueue.length === 0) {
    sessionQueue = [...currentTopic.words];
  }
  currentIdx = 0;
}

function updateCounts() {
  const c = getCounts(currentTopic);
  document.getElementById('countNew').textContent = c.newC;
  document.getElementById('countLearn').textContent = currentTopic.words.filter(w => getRec(w.id).state !== 'new').length;
  document.getElementById('countReview').textContent = c.review + c.learn;
  const progress = currentTopic.words.length ? ((c.done) / currentTopic.words.length) * 100 : 0;
  document.getElementById('progressFill').style.width = progress + '%';
}

function switchMain(tab) {
  mainTab = tab;
  document.querySelectorAll('.mode-switcher button').forEach(b => {
    if (isMixedSession && (b.dataset.main === 'view' || b.dataset.main === 'play')) {
      b.style.display = 'none';
    } else {
      b.style.display = '';
    }
    b.classList.toggle('active', b.dataset.main === tab);
  });
  document.getElementById('learnView').style.display = tab === 'learn' ? 'block' : 'none';
  document.getElementById('viewList').style.display = tab === 'view' ? 'block' : 'none';
  document.getElementById('playView').style.display = tab === 'play' ? 'block' : 'none';
  if (tab === 'view') renderWordList();
  if (tab === 'play') showGamePicker();
  if (tab === 'learn') renderCurrentCard();
}

function switchSub(sub) {
  subTab = sub;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === sub);
  });
  updateSubTabStates();
  const labels = { flash: '1/5: Flashcard', quiz: '2/5: Trắc nghiệm', type: '3/5: Nghe & Gõ', pron: '4/5: Phát âm', translate: '5/5: Dịch câu' };
  document.getElementById('modeLabel').textContent = 'Chế độ ' + labels[sub];
  flashFlipped = false;
  renderCurrentCard();
}

/* ============ FINAL RATING ============ */
function renderFinalRating() {
  const w = currentWord();
  const rec = getRec(w.id);
  const area = document.getElementById('cardArea');
  const suggestion = wordMistakes === 0 ? 'Dễ/Tốt' : wordMistakes === 1 ? 'Tốt/Khó' : 'Khó/Rất khó';
  area.innerHTML = `
    <div class="card-stage" style="padding:40px">
      <div class="pron-label" style="color:var(--success)">✓ Đã hoàn thành cả 5 chế độ</div>
      <h1 class="word-display" style="margin:6px 0 2px">${w.en}</h1>
      <div style="color:var(--ink-soft);font-size:18px;margin-bottom:8px">${w.vi.split(/[;,]/)[0].trim()}</div>
      <div style="color:var(--muted);font-size:13px;margin-bottom:24px">
        ${wordMistakes === 0 ? '🎯 Không sai lần nào' : `⚠️ Sai ${wordMistakes} lần trong phiên này`} · Gợi ý: <strong>${suggestion}</strong>
      </div>

      <div class="two-row" id="finalButtons" style="width:100%;max-width:500px">
        <button class="btn-outline-success" onclick="showFinalSrsOptions()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
          Đã thuộc
        </button>
        <button class="btn-primary" onclick="repeatWord()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="margin-right:6px;vertical-align:-2px"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
          Học tiếp
        </button>
      </div>

      <div class="srs-row" id="finalSrsRow" style="display:none;width:100%;max-width:680px">
        <button class="srs-btn srs-again" onclick="finalRate(0)">
          <span>Rất khó</span>
          <span class="interval">${srsIntervalPreview(rec, 0)}</span>
        </button>
        <button class="srs-btn srs-hard" onclick="finalRate(1)">
          <span>Khó</span>
          <span class="interval">${srsIntervalPreview(rec, 1)}</span>
        </button>
        <button class="srs-btn srs-good" onclick="finalRate(2)">
          <span>Tốt</span>
          <span class="interval">${srsIntervalPreview(rec, 2)}</span>
        </button>
        <button class="srs-btn srs-easy" onclick="finalRate(3)">
          <span>Dễ</span>
          <span class="interval">${srsIntervalPreview(rec, 3)}</span>
        </button>
      </div>

      <div class="kb-hint" id="finalKbHint" style="margin-top:18px">
        <kbd>Tab</kbd>: Đã thuộc · <kbd>Enter</kbd>: Học tiếp (lặp lại)
      </div>
    </div>
  `;
}

function repeatWord() {
  awaitingFinalRating = false;
  subTab = 'flash';
  flashFlipped = false;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === 'flash');
  });
  updateSubTabStates();
  document.getElementById('modeLabel').textContent = 'Chế độ 1/5: Flashcard';
  renderCurrentCard();
}

function showFinalSrsOptions() {
  document.getElementById('finalButtons').style.display = 'none';
  document.getElementById('finalSrsRow').style.display = 'grid';
  document.getElementById('finalKbHint').innerHTML = '<kbd>1</kbd> Rất khó · <kbd>2</kbd> Khó · <kbd>3</kbd> Tốt · <kbd>4</kbd> Dễ';
}

function finalRate(rating) {
  const w = currentWord();
  const rec = getRec(w.id);
  applySrs(rec, rating);
  saveRec(w.id, rec);
  recordStudyAction();
  xp += rating === 0 ? 1 : (rating + 1) * 3;
  document.getElementById('xpCount').textContent = '+' + xp;
  currentIdx++;
  subTab = 'flash';
  flashFlipped = false;
  wordMistakes = 0;
  pronRevealed = false;
  awaitingFinalRating = false;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === 'flash');
  });
  updateSubTabStates();
  document.getElementById('modeLabel').textContent = 'Chế độ 1/5: Flashcard';
  renderCurrentCard();
}

/* ============ AUDIO / TTS ============ */
const PALI_TTS_OVERRIDES = {
  'sila': 'seelah',
  'metta': 'mettah',
};

function applyPaliPronunciation(text) {
  let result = text;
  for (const [pali, phonetic] of Object.entries(PALI_TTS_OVERRIDES)) {
    const re = new RegExp('\\b' + pali + '\\b', 'gi');
    result = result.replace(re, phonetic);
  }
  return result;
}

function speak(text, lang = 'en-US') {
  try {
    const speakText = lang.startsWith('en') ? applyPaliPronunciation(text) : text;
    const u = new SpeechSynthesisUtterance(speakText);
    u.lang = lang;
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}

function phoneticize(word) {
  return '/' + word.toLowerCase()
    .replace(/tion/g, 'ʃən')
    .replace(/ph/g, 'f')
    .replace(/th/g, 'θ')
    .replace(/ee/g, 'iː')
    .replace(/oo/g, 'uː')
    .replace(/ai|ay/g, 'eɪ')
    .replace(/ou|ow/g, 'aʊ')
    .replace(/igh/g, 'aɪ')
    .replace(/oi|oy/g, 'ɔɪ')
    + '/';
}

/* ============ RENDER CARD ============ */
function renderCurrentCard() {
  const area = document.getElementById('cardArea');
  updateCounts();
  if (sessionQueue.length === 0) {
    area.innerHTML = `<div class="done-state">
      <div class="done-emoji">🎉</div>
      <h2 class="done-title">Chưa có từ nào cần học!</h2>
      <p class="done-subtitle">Hãy quay lại sau khi các từ đến hạn ôn tập.</p>
      <button class="btn-primary" style="max-width:200px;margin:0 auto" onclick="backHome()">Về trang chủ</button>
    </div>`;
    return;
  }
  if (currentIdx >= sessionQueue.length) {
    const streak = getStreak();
    const progress = getTodayProgress();
    const goal = getGoal();
    const goalMet = progress.ratedCount >= goal.newWords;
    area.innerHTML = `<div class="done-state">
      <div class="done-emoji">${goalMet ? '🏆' : '✨'}</div>
      <h2 class="done-title">${goalMet ? 'Đã đạt mục tiêu hôm nay!' : 'Tuyệt vời! Đã xong phiên học'}</h2>
      <p class="done-subtitle">
        Đã học ${sessionQueue.length} từ trong phiên này · ${progress.ratedCount}/${goal.newWords} từ hôm nay
        ${streak.current >= 1 ? `<br>🔥 Chuỗi ${streak.current} ngày liên tiếp` : ''}
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        ${isMixedSession ? `
          <button class="btn-primary" style="max-width:220px" onclick="backHome()">Về trang chủ</button>
        ` : `
          <button class="btn-outline-success" style="max-width:200px" onclick="buildSessionQueue(); renderCurrentCard()">Học lại</button>
          <button class="btn-primary" style="max-width:200px" onclick="backHome()">Về trang chủ</button>
        `}
      </div>
    </div>`;
    return;
  }
  if (awaitingFinalRating) {
    renderFinalRating();
    return;
  }
  if (subTab === 'flash') renderFlash();
  else if (subTab === 'quiz') renderQuiz();
  else if (subTab === 'type') renderType();
  else if (subTab === 'pron') renderPron();
  else if (subTab === 'translate') renderTranslate();
}

function currentWord() { return sessionQueue[currentIdx]; }

/* ============ FLASHCARD ============ */
function renderFlash() {
  const w = currentWord();
  const rec = getRec(w.id);
  const phon = getIpaFor(w.en);
  const area = document.getElementById('cardArea');

  if (!flashFlipped) {
    area.innerHTML = `
      <div class="card-stage" onclick="flipCard()" style="cursor:pointer">
        <h1 class="word-display">${w.en}</h1>
        <div class="phonetic-row" onclick="event.stopPropagation()">
          <button class="phonetic-btn" onclick="speak('${w.en.replace(/'/g,"\\'")}','en-US')">
            <span class="flag us">US</span> ${phon || phoneticize(w.en)}
          </button>
        </div>
        <div class="card-hint">Nhấn để xem nghĩa</div>
      </div>
    `;
  } else {
    const vi = w.vi;
    const parts = vi.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const primary = parts[0];
    const synonyms = getSynonymsFor(w.en);
    area.innerHTML = `
      <div class="card-stage flipped">
        <h2 class="meaning-primary">${primary}</h2>
        ${w.ex_en ? `
        <div class="example-box">
          <div class="example-en">"${w.ex_en}"</div>
          ${w.ex_vi ? `<div class="example-vi">${w.ex_vi}</div>` : ''}
        </div>` : ''}
        ${parts.length > 1 ? `
        <div class="tag-row">
          ${parts.slice(1, 3).map(p => `<span class="chip">${p}</span>`).join('')}
        </div>` : ''}
        ${synonyms.length > 0 ? `
        <div class="tag-row" style="margin-top:14px">
          <span class="syn-label">Từ liên quan:</span>
          ${synonyms.slice(0, 4).map(s => `<span class="chip synonym">${s}</span>`).join('')}
        </div>` : ''}

        <div style="width:100%;max-width:420px;margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button class="btn-secondary" onclick="markKnownFromFlash()" style="background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;font-weight:700">✓ Đã thuộc</button>
          <button class="btn-primary" onclick="rateFlash(null)">Học tiếp →</button>
        </div>
        <div class="kb-hint" id="flashKbHint"><kbd>K</kbd>: Đã thuộc · <kbd>Enter</kbd>/<kbd>Space</kbd>: Học tiếp</div>
      </div>
    `;
  }
}

function flipCard() {
  flashFlipped = true;
  speak(currentWord().en, 'en-US');
  renderFlash();
}

function rateFlash(rating) {
  xp += 2;
  document.getElementById('xpCount').textContent = '+' + xp;
  advanceMode();
}

function markKnownFromFlash() {
  const w = currentWord();
  const rec = getRec(w.id);
  applySrs(rec, 2); 
  saveRec(w.id, rec);
  recordStudyAction();
  xp += 5;
  document.getElementById('xpCount').textContent = '+' + xp;
  currentIdx++;
  subTab = 'flash';
  flashFlipped = false;
  wordMistakes = 0;
  pronRevealed = false;
  awaitingFinalRating = false;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === 'flash');
  });
  updateSubTabStates();
  document.getElementById('modeLabel').textContent = 'Chế độ 1/5: Flashcard';
  renderCurrentCard();
}

/* ============ QUIZ ============ */
function renderQuiz() {
  const w = currentWord();
  const direction = Math.random() < 0.5 ? 'en2vi' : 'vi2en';
  const enText = w.en;
  const viText = w.vi.split(/[;,]/)[0].trim();
  const correct = direction === 'en2vi' ? viText : enText;
  const promptText = direction === 'en2vi' ? enText : viText;
  const phon = getIpaFor(w.en) || phoneticize(w.en);

  const pool = [...currentTopic.words].filter(x => x.id !== w.id);
  const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 3);
  const distractors = direction === 'en2vi'
    ? shuffled.map(x => x.vi.split(/[;,]/)[0].trim())
    : shuffled.map(x => x.en);
  const options = [correct, ...distractors].sort(() => Math.random() - 0.5);

  const badge = direction === 'en2vi'
    ? '<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:var(--primary-soft);color:var(--primary);font-size:12px;font-weight:600;letter-spacing:0.04em;margin-bottom:14px">EN → VI · Chọn nghĩa tiếng Việt</span>'
    : '<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:var(--violet-soft);color:var(--violet);font-size:12px;font-weight:600;letter-spacing:0.04em;margin-bottom:14px">VI → EN · Chọn từ tiếng Anh</span>';

  const area = document.getElementById('cardArea');
  area.innerHTML = `
    <div class="card-stage" style="padding:40px">
      ${badge}
      <h1 class="word-display">${promptText}</h1>
      ${direction === 'en2vi' ? `
      <div class="phonetic-row">
        <button class="phonetic-btn" onclick="speak('${w.en.replace(/'/g,"\\'")}','en-US')">
          <span class="flag us">US</span> ${phon}
        </button>
      </div>` : ''}
      <div style="width:100%;max-width:560px;margin-top:20px" id="quizOpts">
        ${options.map((opt, i) => `
          <button class="quiz-option" data-correct="${opt === correct}" onclick="answerQuiz(this,'${correct.replace(/'/g,"\\'")}')">
            <span class="num">${i+1}</span>
            <span>${opt}</span>
          </button>
        `).join('')}
      </div>
      <div class="kb-hint"><kbd>1</kbd> · <kbd>2</kbd> · <kbd>3</kbd> · <kbd>4</kbd> để chọn</div>
    </div>
  `;
  if (direction === 'en2vi') speak(w.en, 'en-US');
}

function answerQuiz(btn, correct) {
  const isRight = btn.dataset.correct === 'true';
  document.querySelectorAll('.quiz-option').forEach(b => {
    b.disabled = true;
    if (b.dataset.correct === 'true') b.classList.add('correct');
    else if (b === btn && !isRight) b.classList.add('wrong');
  });
  if (!isRight) wordMistakes++;
  xp += isRight ? 5 : 1;
  document.getElementById('xpCount').textContent = '+' + xp;
  setTimeout(advanceMode, 1100);
}

/* ============ TYPING ============ */
function renderType() {
  const w = currentWord();
  const area = document.getElementById('cardArea');
  area.innerHTML = `
    <div class="card-stage" style="padding:50px">
      <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:var(--primary-soft);color:var(--primary);font-size:12px;font-weight:600;letter-spacing:0.04em;margin-bottom:18px">NGHE & GÕ TỪ</span>

      <button onclick="speakType('normal')" style="
        width:96px;height:96px;border-radius:50%;
        background:var(--primary);color:white;
        display:grid;place-items:center;
        margin:6px auto 12px;
        box-shadow:0 10px 30px rgba(37,99,235,.3);
        transition:transform .15s ease;
      " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'" title="Nghe lại">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
      </button>

      <div style="display:flex;gap:8px;justify-content:center;align-items:center;margin-bottom:24px">
        <button onclick="speakType('slow')" style="padding:6px 14px;border-radius:999px;background:var(--bg-soft);color:var(--ink-soft);font-size:13px;font-weight:600;display:flex;align-items:center;gap:4px">
          <span>🐢</span> Đọc chậm
        </button>
        <button onclick="speakType('normal')" style="padding:6px 14px;border-radius:999px;background:var(--bg-soft);color:var(--ink-soft);font-size:13px;font-weight:600;display:flex;align-items:center;gap:4px">
          <span>▶</span> Nghe lại
        </button>
      </div>

      <div class="type-input-wrap">
        <button class="type-hint-btn" onclick="typeHint()" title="Gợi ý chữ cái">💡</button>
        <input type="text" class="type-input" id="typeInput" placeholder="Gõ từ bạn vừa nghe..." autocomplete="off" onkeydown="if(event.key==='Enter') checkType()">
      </div>
      <button class="btn-primary" style="max-width:220px;margin:16px auto 0" onclick="checkType()">Kiểm tra</button>
      <div class="type-answer" id="typeAnswer"></div>
      <div class="kb-hint">Enter kiểm tra · 💡 lộ chữ cái · 🐢 đọc chậm</div>
    </div>
  `;
  setTimeout(() => {
    speakType('normal');
    document.getElementById('typeInput').focus();
  }, 200);
}

function speakType(speed) {
  const text = currentWord().en;
  try {
    const u = new SpeechSynthesisUtterance(applyPaliPronunciation(text));
    u.lang = 'en-US';
    u.rate = speed === 'slow' ? 0.6 : 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}

function typeHint() {
  const inp = document.getElementById('typeInput');
  const expected = currentWord().en;
  const cur = inp.value.trim();
  if (cur.length < expected.length) {
    inp.value = expected.slice(0, cur.length + 1);
  }
  inp.focus();
}

function checkType() {
  const inp = document.getElementById('typeInput');
  const val = inp.value.trim().toLowerCase();
  const w = currentWord();
  const expected = w.en.toLowerCase();
  let ok = val === expected;
  if (!ok && expected.length >= 5 && val.length >= 4) {
    if (levenshtein(val, expected) <= 1) ok = true;
  }
  const ansDiv = document.getElementById('typeAnswer');
  if (ok) {
    inp.classList.add('correct');
    ansDiv.innerHTML = '✓ Chính xác: <strong>' + w.en + '</strong>';
    ansDiv.classList.add('show');
    ansDiv.style.background = 'var(--success-soft)';
    ansDiv.style.color = 'var(--success)';
    xp += 5;
  } else {
    inp.classList.add('wrong');
    ansDiv.innerHTML = '✗ Đúng là: <strong>' + w.en + '</strong>';
    ansDiv.classList.add('show');
    ansDiv.style.background = 'var(--danger-soft)';
    ansDiv.style.color = 'var(--danger)';
    wordMistakes++;
    xp += 1;
  }
  document.getElementById('xpCount').textContent = '+' + xp;
  setTimeout(advanceMode, 1400);
}

/* ============ PRONUNCIATION ============ */
let recognizer = null;
function renderPron() {
  const w = currentWord();
  const viFirst = w.vi.split(/[;,]/)[0].trim();
  const phon = getIpaFor(w.en) || phoneticize(w.en);
  const area = document.getElementById('cardArea');

  const wordDisplay = pronRevealed
    ? `<h1 class="word-display" style="margin-bottom:0">${w.en}</h1>`
    : `<div style="font-size:48px;letter-spacing:8px;color:var(--muted);font-family:'Inter',sans-serif;font-weight:800;margin:8px 0">? ? ?</div>`;

  const revealBtn = pronRevealed ? '' : `
    <button class="phonetic-btn" onclick="revealPronWord()" style="background:transparent;border:1px dashed var(--muted);color:var(--ink-soft)">
      👁 Hiện đáp án
    </button>
  `;

  area.innerHTML = `
    <div class="card-stage" style="padding:40px">
      <div class="pron-label">PHÁT ÂM TỪ NÀY</div>
      <div style="color:var(--muted);font-size:18px;margin-bottom:12px;font-weight:600">${viFirst}</div>
      ${wordDisplay}
      <div style="font-size:18px;color:var(--ink-soft);margin-top:8px;font-family:monospace">${phon}</div>
      <div class="phonetic-row" style="gap:10px;flex-wrap:wrap;justify-content:center">
        <button class="phonetic-btn" onclick="speak('${w.en.replace(/'/g,"\\'")}','en-US')">
          <span class="flag us">US</span> Nghe mẫu
        </button>
        ${revealBtn}
      </div>
      <button class="mic-btn" id="micBtn" onclick="toggleRecord()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 18v4"/></svg>
      </button>
      <div class="pron-status" id="pronStatus">${pronRevealed ? 'Đã hiện đáp án — luyện đọc theo' : 'Nhấn loa để nghe, sau đó nhấn micro để thử nói'}</div>
      <div class="pron-feedback" id="pronFeedback"></div>
      <div style="display:flex;gap:12px;margin-top:24px;justify-content:center;flex-wrap:wrap">
        <button class="btn-primary" style="min-width:180px" onclick="advanceMode()">Tiếp tục →</button>
      </div>
      <div class="kb-hint" style="margin-top:14px">Bấm <kbd>Space</kbd> để thu âm · <kbd>Enter</kbd> để tiếp tục${pronRevealed ? '' : ' · <kbd>R</kbd> để hiện đáp án'}</div>
    </div>
  `;
}

function revealPronWord() {
  pronRevealed = true;
  renderPron();
}

function toggleRecord() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('pronStatus').textContent = 'Trình duyệt không hỗ trợ. Hãy thử Chrome/Edge.';
    return;
  }
  const btn = document.getElementById('micBtn');
  const status = document.getElementById('pronStatus');
  const fb = document.getElementById('pronFeedback');
  if (btn.classList.contains('recording')) {
    recognizer && recognizer.stop();
    return;
  }
  recognizer = new SpeechRecognition();
  recognizer.lang = 'en-US';
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 5;
  btn.classList.add('recording');
  status.textContent = 'Đang nghe...';
  fb.classList.remove('show');
  
  recognizer.onresult = (ev) => {
    const alts = [];
    for (let i = 0; i < ev.results[0].length; i++) {
      alts.push(ev.results[0][i].transcript.trim());
    }
    const targetRaw = currentWord().en;
    let bestMatch = null;
    let bestHeard = alts[0] || '';
    for (const h of alts) {
      const m = matchPronunciation(h, targetRaw);
      if (m.ok) { bestMatch = m; bestHeard = h; break; }
    }
    const ok = !!bestMatch;

    if (ok) {
      pronRevealed = true;
      renderPron();
      const fb2 = document.getElementById('pronFeedback');
      fb2.innerHTML = `✓ Tuyệt vời! Bạn đã nói: <strong>"${bestHeard}"</strong>`;
      fb2.className = 'pron-feedback show good';
      xp += 5;
      document.getElementById('xpCount').textContent = '+' + xp;
      setTimeout(advanceMode, 1500);
    } else {
      pronRevealed = true;
      renderPron();
      const fb2 = document.getElementById('pronFeedback');
      const altList = alts.length > 1
        ? `<div style="font-size:12px;margin-top:6px;opacity:.8">Các khả năng: ${alts.map(a => `"${a}"`).join(', ')}</div>`
        : '';
      fb2.innerHTML = `
        <div>Hệ thống nghe thành: <strong>"${bestHeard}"</strong></div>
        <div style="font-size:13px;margin-top:4px;opacity:.9">Cần đọc: <strong>"${targetRaw}"</strong></div>
        ${altList}
        <div style="font-size:12px;margin-top:8px;opacity:.75">Nếu bạn đã đọc đúng, nhấn <strong>"Tiếp tục"</strong> bên dưới</div>
      `;
      fb2.className = 'pron-feedback show bad';
      wordMistakes++;
      xp += 1;
      document.getElementById('xpCount').textContent = '+' + xp;
    }
  };
  
  recognizer.onerror = (e) => {
    status.textContent = 'Có lỗi: ' + (e.error || 'không nhận được âm thanh');
    btn.classList.remove('recording');
  };
  recognizer.onend = () => {
    btn.classList.remove('recording');
    status.textContent = 'Nhấn để nói';
  };
  recognizer.start();
}

function normalizePron(s) {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[\(\)\[\]"'`,.!?;:]/g, ' ').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function pronAlternatives(target) {
  if (target.includes('/')) return target.split('/').map(s => normalizePron(s)).filter(Boolean);
  return [normalizePron(target)];
}

function tokenMatches(a, b) {
  if (a === b) return true;
  const d = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 3) return d <= 1;
  if (maxLen <= 6) return d <= 2;
  return d <= Math.floor(maxLen * 0.35);
}

const PRON_STOPWORDS = new Set(['and', 'the', 'a', 'an', 'of', 'or']);

function matchPronunciation(heardRaw, targetRaw) {
  const heard = normalizePron(heardRaw);
  const alternatives = pronAlternatives(targetRaw);

  for (const target of alternatives) {
    if (heard === target || heard.includes(target) || target.includes(heard)) return { ok: true };
    const tTokens = target.split(' ').filter(Boolean);
    const hTokens = heard.split(' ').filter(Boolean);
    if (tTokens.length === 1) {
      if (tokenMatches(heard.replace(/\s/g, ''), target)) return { ok: true };
      continue;
    }
    const coreTokens = tTokens.filter(t => !PRON_STOPWORDS.has(t));
    const tokensToCheck = coreTokens.length > 0 ? coreTokens : tTokens;
    let found = 0;
    for (const t of tokensToCheck) {
      if (hTokens.some(h => tokenMatches(h, t))) found++;
    }
    if (found / tokensToCheck.length >= 0.8) return { ok: true };
  }
  return { ok: false };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  }
  return dp[m][n];
}

/* ============ TRANSLATE (DỊCH CÂU) ============ */
function renderTranslate() {
  const w = currentWord();
  const area = document.getElementById('cardArea');

  // Bỏ qua nếu từ này không có đủ câu ví dụ song ngữ
  if (!w.ex_en || !w.ex_vi) {
    area.innerHTML = `
      <div class="card-stage" style="padding:40px">
        <div style="font-size:48px;margin-bottom:14px">⏭</div>
        <h2 style="font-family:'Inter',sans-serif;font-weight:700;font-size:22px;margin:0 0 8px">Từ này không đủ ví dụ</h2>
        <p style="color:var(--ink-soft);margin:0 0 24px">Bỏ qua phần dịch câu.</p>
        <button class="btn-primary" style="max-width:200px" onclick="advanceMode()">Tiếp tục →</button>
      </div>
    `;
    setTimeout(advanceMode, 800);
    return;
  }

  // Random 50% Dịch EN->VI hoặc VI->EN
  const isEnToVi = Math.random() < 0.5;
  const promptBadge = isEnToVi ? "DỊCH SANG TIẾNG VIỆT" : "DỊCH SANG TIẾNG ANH";
  const promptText = isEnToVi ? w.ex_en : w.ex_vi;
  const targetText = isEnToVi ? w.ex_vi : w.ex_en;

  area.innerHTML = `
    <div class="card-stage" style="padding:40px">
      <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:var(--violet-soft);color:var(--violet);font-size:12px;font-weight:600;letter-spacing:0.04em;margin-bottom:18px">${promptBadge}</span>
      
      <div class="example-box" style="text-align:center;font-size:19px;border-left-color:var(--violet);max-width:680px;line-height:1.7; margin: 0 auto 20px;">
        ${promptText}
      </div>

      <div class="type-input-wrap" style="width:100%; max-width:600px; margin-top:0;">
        <textarea class="type-input" id="translateInput" rows="3" placeholder="Nhập bản dịch của bạn vào đây..." style="resize:none; padding:16px; font-size:16px; border-radius:var(--radius);" onkeydown="if(event.key==='Enter' && !event.shiftKey) { event.preventDefault(); showTranslateAnswer('${targetText.replace(/'/g, "\\'")}'); }"></textarea>
      </div>
      
      <button id="translateCheckBtn" class="btn-primary" style="max-width:220px;margin:20px auto 0" onclick="showTranslateAnswer('${targetText.replace(/'/g, "\\'")}')">Xem đáp án</button>

      <div id="translateAnswerArea" style="display:none; margin-top: 24px; width: 100%; max-width: 600px;">
        <div style="text-align:left; background:var(--success-soft); color:#065f46; padding:18px; border-radius:12px; font-size:16px; line-height: 1.5;">
          <div style="font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--success); margin-bottom:8px;">ĐÁP ÁN THAM KHẢO</div>
          <em>${targetText}</em>
        </div>
        <button class="btn-primary" id="translateNextBtn" style="max-width:220px;margin:20px auto 0" onclick="completeTranslate()">Tiếp tục →</button>
      </div>

      <div class="kb-hint" id="translateKbHint">Nhấn <kbd>Enter</kbd> để xem đáp án (Shift+Enter để xuống dòng)</div>
    </div>
  `;
  setTimeout(() => document.getElementById('translateInput').focus(), 100);
}

function showTranslateAnswer(answerText) {
  document.getElementById('translateInput').disabled = true;
  document.getElementById('translateCheckBtn').style.display = 'none';
  document.getElementById('translateAnswerArea').style.display = 'block';
  document.getElementById('translateKbHint').innerHTML = 'Nhấn <kbd>Enter</kbd> để tiếp tục';
  
  const nextBtn = document.getElementById('translateNextBtn');
  nextBtn.focus();
}

function completeTranslate() {
  xp += 5; 
  document.getElementById('xpCount').textContent = '+' + xp;
  advanceMode(); 
}

/* ============ WORD LIST VIEW ============ */
function renderWordList() {
  const list = document.getElementById('wordList');
  document.getElementById('listCount').textContent = `(${currentTopic.words.length})`;
  list.innerHTML = currentTopic.words.map(w => {
    const ipa = w.ipa || '';
    const synonyms = w.synonyms || [];
    return `
      <div class="word-item">
        <div>
          <div class="word-item-en">
            <span>${w.en}</span>
            <button class="sound-btn" onclick="speak('${w.en.replace(/'/g,"\\'")}','en-US')" title="Phát âm US">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            </button>
          </div>
          ${ipa ? `<div class="word-item-phonetic">
            <span class="flag us" style="display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--danger);color:white;font-size:9px;font-weight:800;vertical-align:middle;margin-right:6px">US</span>
            <span>${ipa}</span>
          </div>` : ''}
          ${w.ex_en ? `
          <div style="margin-top:10px;padding:10px 14px;background:var(--bg-soft);border-left:3px solid var(--primary);border-radius:8px">
            <div style="font-style:italic;color:var(--ink);font-size:14px;line-height:1.5">"${w.ex_en}"</div>
            ${w.ex_vi ? `<div style="color:var(--ink-soft);font-size:13px;line-height:1.5;margin-top:4px">${w.ex_vi}</div>` : ''}
          </div>` : ''}
          ${synonyms.length > 0 ? `
          <div class="tag-row" style="margin-top:10px;justify-content:flex-start">
            <span class="syn-label">Từ liên quan:</span>
            ${synonyms.slice(0, 5).map(s => `<span class="chip synonym">${s}</span>`).join('')}
          </div>` : ''}
        </div>
        <div>
          <div class="word-item-vi">${w.vi}</div>
        </div>
      </div>
    `;
  }).join('');
}

/* ============ GAME: MATCH ============ */
let gameState = null;
let gameMode = null; 

function showGamePicker() {
  gameMode = null;
  document.getElementById('gamePicker').style.display = 'block';
  document.getElementById('gameBoard').style.display = 'none';
  document.getElementById('gameEmpty').style.display = 'none';
  if (gameState && gameState.timer) clearInterval(gameState.timer);
  gameState = null;
  if (currentTopic) {
    const total = currentTopic.words.length;
    const viEl = document.getElementById('game-vi-count');
    if (viEl) viEl.textContent = total + ' từ khả dụng';
  }
}

function startGameMode(mode) {
  gameMode = mode;
  const candidates = [...currentTopic.words];
  if (candidates.length < 6) {
    document.getElementById('gamePicker').style.display = 'none';
    document.getElementById('gameBoard').style.display = 'none';
    document.getElementById('gameEmpty').style.display = 'block';
    return;
  }
  document.getElementById('gamePicker').style.display = 'none';
  document.getElementById('gameEmpty').style.display = 'none';
  document.getElementById('gameBoard').style.display = 'block';
  restartCurrentGame();
}

function restartCurrentGame() {
  if (gameState && gameState.timer) clearInterval(gameState.timer);
  const candidates = [...currentTopic.words].sort(() => Math.random() - 0.5).slice(0, 6);
  const tiles = [];
  candidates.forEach(w => {
    tiles.push({ text: w.en, matchId: w.id, side: 'en' });
    let tText = w.vi.split(/[;,]/)[0].trim();
    if (tText.length > 30) tText = tText.substring(0, 27) + '...';
    tiles.push({ text: tText, matchId: w.id, side: 'vi' });
  });
  tiles.sort(() => Math.random() - 0.5);
  gameState = { tiles, selectedIdx: null, matches: 0, startTime: Date.now(), timer: null, points: 0, totalPairs: 6 };
  document.getElementById('gameProgress').textContent = `0/6`;
  document.getElementById('gamePts').textContent = `0 pts`;
  document.getElementById('gameTimer').textContent = `0:00`;
  renderGameBoard();
  gameState.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - gameState.startTime) / 1000);
    document.getElementById('gameTimer').textContent = formatTime(sec);
  }, 1000);
}

function exitGame() {
  if (gameState && gameState.timer) clearInterval(gameState.timer);
  showGamePicker();
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function renderGameBoard() {
  const grid = document.getElementById('gameGrid');
  grid.innerHTML = gameState.tiles.map((t, i) => `
    <div class="game-tile ${t.matched ? 'matched' : ''} ${t.side === 'en' ? 'side-en' : ''}" 
         id="gtile-${i}" 
         onclick="handleTileClick(${i})">
      ${t.text}
    </div>
  `).join('');
}

function handleTileClick(idx) {
  const t = gameState.tiles[idx];
  if (t.matched) return;
  const el = document.getElementById('gtile-' + idx);
  if (gameState.selectedIdx === null) {
    gameState.selectedIdx = idx;
    el.classList.add('selected');
    if (t.side === 'en') speak(t.text, 'en-US');
  } else {
    if (gameState.selectedIdx === idx) {
      gameState.selectedIdx = null;
      el.classList.remove('selected');
      return;
    }
    const prevIdx = gameState.selectedIdx;
    const prevT = gameState.tiles[prevIdx];
    const prevEl = document.getElementById('gtile-' + prevIdx);
    if (prevT.side === 'en' && t.side === 'en') {
      speak(t.text, 'en-US');
      prevEl.classList.remove('selected');
      gameState.selectedIdx = idx;
      el.classList.add('selected');
      return;
    }
    if (t.side === 'en') speak(t.text, 'en-US');
    if (t.matchId === prevT.matchId && t.side !== prevT.side) {
      t.matched = true; prevT.matched = true;
      gameState.matches++;
      gameState.points += 10;
      el.classList.add('matched'); prevEl.classList.add('matched');
      el.classList.remove('selected'); prevEl.classList.remove('selected');
      document.getElementById('gameProgress').textContent = `${gameState.matches}/6`;
      document.getElementById('gamePts').textContent = `${gameState.points} pts`;
      if (gameState.matches === gameState.totalPairs) {
        clearInterval(gameState.timer);
        setTimeout(() => alert(`Hoàn thành! Bạn đạt ${gameState.points} điểm trong ${formatTime(Math.floor((Date.now() - gameState.startTime)/1000))}.`), 300);
      }
    } else {
      el.classList.add('wrong'); prevEl.classList.add('wrong');
      gameState.points = Math.max(0, gameState.points - 2);
      document.getElementById('gamePts').textContent = `${gameState.points} pts`;
      setTimeout(() => {
        el.classList.remove('wrong'); prevEl.classList.remove('wrong');
        el.classList.remove('selected'); prevEl.classList.remove('selected');
      }, 400);
    }
    gameState.selectedIdx = null;
  }
}

/* ============ ONBOARDING ============ */
const ONBOARD_STEPS = [
  { icon: '👋', title: 'Chào mừng bạn!', body: '<p class="onboard-text"><strong>VocabMaster</strong> là công cụ giúp bạn ghi nhớ từ vựng tiếng Anh phục vụ cho các khóa thiền Vipassana.</p><p class="onboard-text">Ứng dụng hoạt động <strong>hoàn toàn offline</strong>, không cần mạng, giúp bạn tập trung tối đa.</p>' },
  { icon: '🧠', title: 'Spaced Repetition', body: '<p class="onboard-text">Thay vì học vẹt, ứng dụng tự động tính toán thời điểm hoàn hảo để ôn tập lại một từ trước khi bạn kịp quên nó.</p><div class="onboard-features"><div class="onboard-feat"><div class="onboard-feat-icon" style="color:var(--primary)">🌱</div><div class="onboard-feat-text"><strong>Từ mới</strong>Học lần đầu, ôn lại ngay sau 10 phút.</div></div><div class="onboard-feat"><div class="onboard-feat-icon" style="color:var(--orange)">🔄</div><div class="onboard-feat-text"><strong>Ôn tập</strong>Khoảng cách ôn tập tăng dần (1 ngày, 3 ngày, 1 tuần...).</div></div></div>' },
  { icon: '🎯', title: '5 Chế độ Học', body: '<p class="onboard-text">Mỗi từ vựng bạn sẽ trải qua 5 bước để đảm bảo nhớ sâu mọi khía cạnh:</p><div class="onboard-features" style="grid-template-columns:1fr 1fr"><div class="onboard-feat"><div class="onboard-feat-icon">🃏</div><div class="onboard-feat-text"><strong>1. Flashcard</strong>Ghi nhớ nghĩa</div></div><div class="onboard-feat"><div class="onboard-feat-icon">✅</div><div class="onboard-feat-text"><strong>2. Quiz</strong>Trắc nghiệm</div></div><div class="onboard-feat"><div class="onboard-feat-icon">⌨️</div><div class="onboard-feat-text"><strong>3. Nghe & Gõ</strong>Nhớ chính tả</div></div><div class="onboard-feat"><div class="onboard-feat-icon">🎙️</div><div class="onboard-feat-text"><strong>4. Phát âm</strong>Luyện nói chuẩn</div></div><div class="onboard-feat" style="grid-column: span 2;"><div class="onboard-feat-icon">📝</div><div class="onboard-feat-text"><strong>5. Dịch câu</strong>Hiểu ngữ cảnh thực tế</div></div></div>' },
  { icon: '🔥', title: 'Mục tiêu mỗi ngày', isLast: true, body: '<p class="onboard-text">Chìa khóa của phương pháp này là <strong>sự kiên trì</strong>. Hãy duy trì chuỗi ngày học của bạn (Streak).</p><p class="onboard-text">Mỗi ngày, hãy đảm bảo bạn hoàn thành mục tiêu <strong style="color:var(--primary)">10 từ mới</strong> hoặc ôn tập hết các từ đến hạn nhé.</p>' }
];

let onboardStep = 0;

function showOnboard() {
  onboardStep = 0;
  renderOnboardStep();
  document.getElementById('onboardOverlay').classList.add('show');
}

function renderOnboardStep() {
  const step = ONBOARD_STEPS[onboardStep];
  const bodyEl = document.getElementById('onboardBody');
  bodyEl.innerHTML = `
    <div class="onboard-icon">${step.icon}</div>
    <h2 class="onboard-title">${step.title}</h2>
    ${step.body}
  `;
  document.querySelectorAll('.onboard-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === onboardStep);
    dot.classList.toggle('done', i < onboardStep);
  });
  document.getElementById('onboardBackBtn').style.display = onboardStep > 0 ? 'block' : 'none';
  document.getElementById('onboardNextBtn').textContent = step.isLast ? 'Bắt đầu học →' : 'Tiếp tục →';
}

function onboardNext() {
  if (onboardStep < ONBOARD_STEPS.length - 1) {
    onboardStep++;
    renderOnboardStep();
  } else {
    finishOnboard();
  }
}

function onboardPrev() {
  if (onboardStep > 0) {
    onboardStep--;
    renderOnboardStep();
  }
}

function finishOnboard() {
  document.getElementById('onboardOverlay').classList.remove('show');
  store.onboarded = true;
  saveStore(store);
}

function maybeShowOnboard() {
  const hasProgress = store.words && Object.keys(store.words).length > 0;
  if (!store.onboarded && !hasProgress) {
    showOnboard();
  }
}

/* ============ KEYBOARD SHORTCUTS & INIT ============ */
document.addEventListener('keydown', (e) => {
  if (document.getElementById('onboardOverlay').classList.contains('show')) {
    if (e.key === 'Enter') onboardNext();
    return;
  }
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
  if (mainTab !== 'learn' || !document.getElementById('studyPage').classList.contains('active')) return;

  if (awaitingFinalRating) {
    if (document.getElementById('finalButtons').style.display !== 'none') {
      if (e.key === 'Enter') repeatWord();
      else if (e.key === 'Tab') { e.preventDefault(); showFinalSrsOptions(); }
    } else {
      if (e.key === '1') finalRate(0);
      else if (e.key === '2') finalRate(1);
      else if (e.key === '3') finalRate(2);
      else if (e.key === '4') finalRate(3);
    }
    return;
  }
  if (subTab === 'flash') {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!flashFlipped) flipCard(); else rateFlash(null);
    }
    if (e.key.toLowerCase() === 'k' && flashFlipped) markKnownFromFlash();
  } else if (subTab === 'quiz') {
    if (['1', '2', '3', '4'].includes(e.key)) {
      const btns = document.querySelectorAll('.quiz-option');
      if (btns[parseInt(e.key) - 1] && !btns[0].disabled) {
        btns[parseInt(e.key) - 1].click();
      }
    }
  } else if (subTab === 'pron') {
    if (e.key === ' ' && document.activeElement.tagName !== 'BUTTON') {
      e.preventDefault(); toggleRecord();
    } else if (e.key === 'Enter' && !document.getElementById('micBtn').classList.contains('recording')) {
      advanceMode();
    } else if (e.key.toLowerCase() === 'r' && !pronRevealed) {
      revealPronWord();
    }
  }
});

// Update network status indicator
function updateOnlineStatus() {
  const el = document.getElementById('netStatus');
  if (el) el.style.background = navigator.onLine ? 'var(--success)' : 'var(--danger)';
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// INIT
document.addEventListener('DOMContentLoaded', () => {
  renderHome();
  updateOnlineStatus();
  maybeShowOnboard();
  
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
