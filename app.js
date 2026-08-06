/* Blind Score — client-side PDF composer-guessing quiz
   Everything runs in the browser. No file ever leaves the machine. */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const EXCERPT_PAGE_COUNT = 5;
const MIDDLE_LOWER = 0.15;   // start of the "middle 70%" window
const MIDDLE_UPPER = 0.85;   // end of the "middle 70%" window

// ---------- state ----------
const state = {
  files: [],          // File objects, in shuffled order once the round starts
  index: -1,           // which file we're currently on
  currentPdf: null,    // pdf.js document proxy for the current file
  currentRange: null,  // { start, count } chosen for this file
  score: { correct: 0, wrong: 0 },
  marked: null,        // 'right' | 'wrong' | null for the current excerpt
};

// ---------- element refs ----------
const el = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  fileList: document.getElementById('file-list'),
  fileCount: document.getElementById('file-count'),
  btnStart: document.getElementById('btn-start'),

  progressIndicator: document.getElementById('progress-indicator'),
  progressText: document.getElementById('progress-text'),
  scoreText: document.getElementById('score-text'),

  screens: {
    upload: document.getElementById('screen-upload'),
    loading: document.getElementById('screen-loading'),
    quiz: document.getElementById('screen-quiz'),
    reveal: document.getElementById('screen-reveal'),
    summary: document.getElementById('screen-summary'),
  },
  loadingText: document.getElementById('loading-text'),

  excerptNote: document.getElementById('excerpt-note'),
  filmstrip: document.getElementById('filmstrip'),
  guessForm: document.getElementById('guess-form'),
  inputComposer: document.getElementById('input-composer'),
  inputTitle: document.getElementById('input-title'),

  revealFilename: document.getElementById('reveal-filename'),
  yourGuess: document.getElementById('your-guess'),
  revealCanvas: document.getElementById('reveal-canvas'),
  btnNext: document.getElementById('btn-next'),
  markButtons: document.getElementById('mark-buttons'),

  summaryHeadline: document.getElementById('summary-headline'),
  summaryScore: document.getElementById('summary-score'),
  btnRestart: document.getElementById('btn-restart'),
};

// ---------- small utilities ----------
function showScreen(name) {
  Object.values(el.screens).forEach(s => s.classList.remove('active'));
  el.screens[name].classList.add('active');
}

function randInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function prettyName(file) {
  return file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
}

// picks a window of EXCERPT_PAGE_COUNT consecutive pages inside the middle
// 70% of the document; falls back to the whole document if it's too short
// for the window to fit inside that middle band.
function pickPageRange(numPages) {
  const want = EXCERPT_PAGE_COUNT;
  if (numPages <= want) {
    return { start: 1, count: numPages };
  }
  let lower = Math.floor(numPages * MIDDLE_LOWER) + 1;      // 1-indexed
  let upper = Math.ceil(numPages * MIDDLE_UPPER);           // 1-indexed, inclusive
  let latestStart = upper - want + 1;
  if (latestStart < lower) {
    // middle band too narrow for a 5-page window — use the full document instead
    lower = 1;
    latestStart = numPages - want + 1;
  }
  const start = randInt(lower, latestStart);
  return { start, count: want };
}

// ---------- file intake ----------
function addFiles(fileListLike) {
  const incoming = Array.from(fileListLike).filter(f =>
    f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
  );
  state.files.push(...incoming);
  renderFileList();
}

function renderFileList() {
  el.fileList.innerHTML = '';
  state.files.forEach((f, i) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'fname';
    span.textContent = f.name;
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Remove ${f.name}`);
    btn.textContent = '\u2715';
    btn.addEventListener('click', () => {
      state.files.splice(i, 1);
      renderFileList();
    });
    li.appendChild(span);
    li.appendChild(btn);
    el.fileList.appendChild(li);
  });
  el.fileCount.textContent = state.files.length
    ? `${state.files.length} file${state.files.length === 1 ? '' : 's'} loaded`
    : '';
  el.btnStart.disabled = state.files.length === 0;
}

el.dropzone.addEventListener('click', (e) => {
  // label already triggers the input; guard against double-firing on some browsers
});
el.fileInput.addEventListener('change', (e) => addFiles(e.target.files));

['dragenter', 'dragover'].forEach(evt =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach(evt =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag-over');
  })
);
el.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ---------- round control ----------
el.btnStart.addEventListener('click', () => {
  state.files = shuffle(state.files);
  state.index = -1;
  state.score = { correct: 0, wrong: 0 };
  el.progressIndicator.classList.remove('hidden');
  advanceToNextFile();
});

async function advanceToNextFile() {
  state.index += 1;
  if (state.index >= state.files.length) {
    showSummary();
    return;
  }
  state.marked = null;
  updateProgress();
  showScreen('loading');
  el.loadingText.textContent = `Opening “${state.files[state.index].name}”…`;

  try {
    const file = state.files[state.index];
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    state.currentPdf = pdf;
    state.currentRange = pickPageRange(pdf.numPages);
    await showQuiz();
  } catch (err) {
    console.error(err);
    el.loadingText.textContent =
      `Couldn't read "${state.files[state.index].name}" — skipping it.`;
    setTimeout(advanceToNextFile, 1400);
  }
}

function updateProgress() {
  el.progressText.textContent = `Excerpt ${state.index + 1} of ${state.files.length}`;
  const total = state.score.correct + state.score.wrong;
  el.scoreText.textContent = total
    ? `${state.score.correct} / ${total} marked correct`
    : '';
}

// ---------- rendering ----------
async function renderPageToCanvas(pdf, pageNumber, canvas, targetWidth) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = targetWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  await page.render({ canvasContext: ctx, viewport, transform }).promise;
}

async function showQuiz() {
  const { start, count } = state.currentRange;
  el.excerptNote.textContent = count < EXCERPT_PAGE_COUNT
    ? `This piece is short, so all ${count} of its pages are shown below.`
    : `${count} consecutive pages, pulled from the middle of the piece — no title page, no clues.`;

  el.filmstrip.innerHTML = '';
  el.inputComposer.value = '';
  el.inputTitle.value = '';
  showScreen('quiz');

  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'page-card';
    const canvas = document.createElement('canvas');
    card.appendChild(canvas);
    const tag = document.createElement('div');
    tag.className = 'page-tag';
    tag.textContent = `${i + 1} of ${count}`;
    card.appendChild(tag);
    el.filmstrip.appendChild(card);
    // render sequentially so pages appear in order without hammering the CPU at once
    await renderPageToCanvas(state.currentPdf, start + i, canvas, 260);
  }
  el.inputComposer.focus();
}

el.guessForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await showReveal();
});

async function showReveal() {
  const composerGuess = el.inputComposer.value.trim();
  const titleGuess = el.inputTitle.value.trim();
  const file = state.files[state.index];

  el.revealFilename.textContent = prettyName(file);
  if (composerGuess || titleGuess) {
    el.yourGuess.innerHTML =
      `Your guess — Composer: <b>${escapeHtml(composerGuess || '(blank)')}</b>` +
      ` &middot; Title: <b>${escapeHtml(titleGuess || '(blank)')}</b>`;
  } else {
    el.yourGuess.textContent = 'You submitted without a guess.';
  }

  state.marked = null;
  [...el.markButtons.children].forEach(b => b.classList.remove('active'));

  showScreen('reveal');
  await renderPageToCanvas(state.currentPdf, 1, el.revealCanvas, 380);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

el.markButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mark]');
  if (!btn) return;
  const mark = btn.dataset.mark;

  if (state.marked === mark) {
    // toggle off
    if (mark === 'right') state.score.correct -= 1; else state.score.wrong -= 1;
    state.marked = null;
  } else {
    if (state.marked === 'right') state.score.correct -= 1;
    if (state.marked === 'wrong') state.score.wrong -= 1;
    if (mark === 'right') state.score.correct += 1; else state.score.wrong += 1;
    state.marked = mark;
  }
  [...el.markButtons.children].forEach(b =>
    b.classList.toggle('active', b.dataset.mark === state.marked)
  );
  updateProgress();
});

el.btnNext.addEventListener('click', () => {
  advanceToNextFile();
});

function showSummary() {
  el.progressIndicator.classList.add('hidden');
  const total = state.score.correct + state.score.wrong;
  el.summaryHeadline.textContent = state.files.length
    ? `You made it through all ${state.files.length} scores.`
    : 'No scores to show.';
  el.summaryScore.textContent = total
    ? `Marked correct on ${state.score.correct} of ${total}.`
    : 'You didn\'t mark any excerpts right or wrong — that\'s fine too.';
  showScreen('summary');
}

el.btnRestart.addEventListener('click', () => {
  state.index = -1;
  state.currentPdf = null;
  state.currentRange = null;
  state.score = { correct: 0, wrong: 0 };
  state.marked = null;
  el.progressIndicator.classList.add('hidden');
  renderFileList();
  showScreen('upload');
});
