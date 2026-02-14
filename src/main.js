// ================================
// Paperly — Main (Dashboard Edition)
// ================================

import './style.css';
import { renderMarkdown } from './markdown-renderer.js';
import { downloadNotebook } from './notebook-generator.js';
import { runCell, ensurePyodide } from './pyodide-runner.js';

const state = {
  paperText: '', paperTitle: '',
  results: { summary: null, explanation: null, notebook: null, notebookParsed: null },
  tasks: [],
  activeTask: null,
  execCount: 0,
  pipelineRunning: false,
};
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// API base URL — empty in dev (Vite proxy), set to backend URL in production
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

document.addEventListener('DOMContentLoaded', () => {
  initGrid();
  initTabs();
  initDrop();
  initUrl();
  initResTabs();
  initReveal();
  initNewPaperBtns();
  restoreSession();

  // Logo = home (clear session, start fresh)
  const logo = document.querySelector('.logo');
  if (logo) logo.addEventListener('click', (e) => { e.preventDefault(); startNewPaper(); });
});

// ═══════════════════════════════════════════════════════
// ── 3D Dot Grid — Brighter with Wave Sweep ───────────
// ═══════════════════════════════════════════════════════

function initGrid() {
  const c = $('#gridCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  let w, h, mx = -999, my = -999;

  function resize() { w = c.width = window.innerWidth; h = c.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; });

  const gap = 30;
  const baseR = 1.2;
  const maxR = 2.8;
  const mouseInf = 160;

  function draw(time) {
    ctx.clearRect(0, 0, w, h);

    // Wave sweep: a bright band that moves left-to-right continuously
    const waveSpeed = 0.00012;   // slower = wider wave
    const waveWidth = 300;       // px width of the bright band
    const waveX = ((time * waveSpeed * w) % (w + waveWidth * 2)) - waveWidth;

    for (let x = gap; x < w; x += gap) {
      for (let y = gap; y < h; y += gap) {
        // Mouse influence
        const mdx = x - mx, mdy = y - my;
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
        const mT = Math.max(0, 1 - mDist / mouseInf);

        // Wave influence
        const waveDist = Math.abs(x - waveX);
        const wT = Math.max(0, 1 - waveDist / waveWidth);
        const waveCurve = wT * wT * (3 - 2 * wT); // smoothstep

        // Combine both influences (take max so they don't cancel)
        const t = Math.min(1, Math.max(mT, waveCurve * 0.7));

        const r = baseR + (maxR - baseR) * t;
        const a = 0.12 + 0.55 * t; // brighter base (0.12) and peak (0.67)

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ═══════════════════════════════════════════════════════
// ── Upload Tabs / Dropzone / URL ─────────────────────
// ═══════════════════════════════════════════════════════

function initTabs() {
  const fBtn = $('#fileTabBtn'), uBtn = $('#urlTabBtn');
  const fP = $('#fileUploadPanel'), uP = $('#urlUploadPanel');
  fBtn.addEventListener('click', () => { fBtn.classList.add('on'); uBtn.classList.remove('on'); fP.classList.remove('hidden'); uP.classList.add('hidden'); });
  uBtn.addEventListener('click', () => { uBtn.classList.add('on'); fBtn.classList.remove('on'); uP.classList.remove('hidden'); fP.classList.add('hidden'); });
}

function initDrop() {
  const dz = $('#dropzone'), inp = $('#fileInput');
  dz.addEventListener('click', () => inp.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.type === 'application/pdf') pick(f); });
  inp.addEventListener('change', (e) => { if (e.target.files[0]) pick(e.target.files[0]); });
}

function pick(file) {
  $('#fileName').textContent = file.name;
  $('#fileSize').textContent = fmtSize(file.size);
  $('#filePreview').classList.remove('hidden');
  state.paperTitle = file.name.replace('.pdf', '');
  $('#analyzeBtn').onclick = async () => {
    await readPDF(file);
    if (state.paperText) run();
  };
}

function initUrl() {
  const btn = $('#fetchUrlBtn'), inp = $('#paperUrlInput');
  btn.addEventListener('click', () => {
    const u = inp.value.trim();
    if (!u) { shake(inp); return; }
    state.paperTitle = titleFromUrl(u);
    state.paperText = `[Paper URL: ${u}]\nAnalyze the research paper at this URL. Title hint: ${state.paperTitle}`;
    run();
  });
}

// ── PDF Read ───────────────────────────────────────────

async function readPDF(file) {
  try {
    if (!window.pdfjsLib) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      document.head.appendChild(s);
      await new Promise((ok, no) => { s.onload = ok; s.onerror = no; });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let t = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const c = await pg.getTextContent();
      t += c.items.map((x) => x.str).join(' ') + '\n\n';
    }
    state.paperText = t.trim();
    if (state.paperText.length < 100) alert('Not enough text extracted.');
  } catch (e) { console.error(e); alert('Failed to read PDF.'); }
}

// ── API ────────────────────────────────────────────────

async function api(endpoint, paperText, maxRetries = 2) {
  let lastErr;
  let wasRateLimited = false;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${API_BASE}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paperText }),
      });
      if (res.status === 429) {
        wasRateLimited = true;
        const data = await res.json().catch(() => ({}));
        const wait = Math.min(data.retryAfter || 15, 30);
        await countdown(`All providers busy — retrying in`, wait);
        continue;
      }
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Error ${res.status}`); }
      return (await res.json()).result;
    } catch (e) {
      lastErr = e;
      if (e.message?.includes('Failed to fetch')) {
        await countdown('Server unreachable — retrying in', 5);
        continue;
      }
      if (e.message?.includes('429') || e.message?.includes('rate') || e.message?.includes('quota')) {
        wasRateLimited = true;
        await countdown('Rate limited — retrying in', 15);
        continue;
      }
      throw e;
    }
  }
  const err = lastErr || new Error('Request failed.');
  if (wasRateLimited) err.rateLimited = true;
  throw err;
}

async function countdown(label, seconds) {
  for (let s = seconds; s > 0; s--) {
    msg(`${label} ${s}s…`);
    await sleep(1000);
  }
}

// ── Pipeline ───────────────────────────────────────────

async function run() {
  if (state.pipelineRunning) return;
  state.pipelineRunning = true;
  hide('uploadArea'); show('pipelineSection'); hide('resultsSection');
  resetPipeline();
  try {
    step('Parse', 'active'); msg('Parsing…'); await sleep(400); step('Parse', 'done');
    step('Extract', 'active'); msg('Extracting key ideas…');
    state.results.summary = await api('summarize', state.paperText);
    step('Extract', 'done');
    step('Explain', 'active'); msg('Writing explanation…');
    state.results.explanation = await api('explain', state.paperText);
    step('Explain', 'done');
    step('Notebook', 'active'); msg('Generating notebook…');
    state.results.notebook = await api('notebook', state.paperText);
    step('Notebook', 'done');
    msg('Done ✓'); await sleep(500);
    saveSession();
    hide('pipelineSection'); show('resultsSection');
    renderResults();
  } catch (err) {
    console.error('Pipeline error:', err);
    msg('');
    const msgEl = $('#pipelineStatusText');
    if (msgEl) {
      if (err.rateLimited) {
        msgEl.innerHTML = `
          <div style="text-align:center;padding:12px 0">
            <div style="font-size:1.1rem;color:var(--t1);margin-bottom:8px">⏳ Rate Limited</div>
            <div style="color:var(--t2);font-size:.85rem;max-width:360px;margin:0 auto;line-height:1.6">
              All AI providers are temporarily rate-limited. This usually resolves within 1–2 minutes on free tiers.
            </div>
            <a href="#" id="retryLink" style="display:inline-block;margin-top:12px;padding:8px 20px;background:var(--ac);color:#000;border-radius:6px;font-weight:600;font-size:.82rem;text-decoration:none">Retry Now</a>
          </div>`;
      } else {
        msgEl.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span><br/><a href="#" id="retryLink" style="color:var(--t1);text-decoration:underline;font-size:.82rem">Retry →</a>`;
      }
      const retryLink = $('#retryLink');
      if (retryLink) retryLink.onclick = (e) => { e.preventDefault(); state.pipelineRunning = false; resetPipeline(); run(); };
    }
  } finally {
    state.pipelineRunning = false;
  }
}

function step(id, s) {
  const el = $(`#step${id}`); if (!el) return;
  el.classList.remove('active', 'done'); el.classList.add(s);
  if (s === 'done') { const all = [...$$('.dot-step')], lines = [...$$('.pipe-line')]; const i = all.indexOf(el); if (lines[i]) lines[i].classList.add('active'); }
}
function resetPipeline() { $$('.dot-step').forEach(e => e.classList.remove('active', 'done')); $$('.pipe-line').forEach(e => e.classList.remove('active')); }
function msg(t) { const el = $('#pipelineStatusText'); if (el) el.textContent = t; }

// ═══════════════════════════════════════════════════════
// ── Results (Summary / Explanation / →Dashboard) ─────
// ═══════════════════════════════════════════════════════

function renderResults() {
  $('#summaryContent').innerHTML = renderMarkdown(state.results.summary || '');
  $('#explanationContent').innerHTML = renderMarkdown(state.results.explanation || '');
  parseNotebookToTasks(state.results.notebook);
}

// ── Session Persistence (localStorage) ─────────────────

function saveSession() {
  try {
    const data = {
      paperTitle: state.paperTitle,
      results: state.results,
      tasks: state.tasks.map(t => ({ name: t.name, description: t.description, code: t.code, done: t.done, outputHtml: t.outputHtml || '' })),
      savedAt: Date.now(),
    };
    localStorage.setItem('paperly_session', JSON.stringify(data));
    console.log('  💾 Session saved');
  } catch (e) {
    console.warn('Could not save session:', e);
  }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem('paperly_session');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.results?.summary) return;

    // Show the resume card on the home page
    const card = $('#resumeCard');
    const titleEl = $('#resumeTitle');
    if (card && titleEl) {
      titleEl.textContent = data.paperTitle || 'Previous Paper';
      card.classList.remove('hidden');
      $('#resumeBtn').onclick = () => resumeSession(data);
    }
  } catch (e) {
    console.warn('Could not restore session:', e);
    localStorage.removeItem('paperly_session');
  }
}

function resumeSession(data) {
  state.paperTitle = data.paperTitle || '';
  state.results = data.results;
  if (data.tasks?.length) state.tasks = data.tasks;

  hide('uploadArea');
  hide('pipelineSection');
  hide('resumeCard');
  show('resultsSection');
  renderResults();
  console.log('  ♻️ Session restored');
}

function startNewPaper() {
  // Go home — keep session so resume card appears
  location.reload();
}

function clearAndNewPaper() {
  localStorage.removeItem('paperly_session');
  location.reload();
}

function initNewPaperBtns() {
  const btn1 = $('#newPaperBtn');
  const btn2 = $('#dashNewPaperBtn');
  if (btn1) btn1.onclick = clearAndNewPaper;
  if (btn2) btn2.onclick = clearAndNewPaper;
}

function initResTabs() {
  const tabs = $$('.rtab');
  const panels = { summary: $('#summaryPanel'), explanation: $('#explanationPanel') };
  tabs.forEach(t => t.addEventListener('click', () => {
    const key = t.dataset.result;
    if (!key) return; // new-paper button
    if (key === 'notebook') {
      // Switch to full dashboard
      openDashboard();
      return;
    }
    tabs.forEach(x => x.classList.remove('on')); t.classList.add('on');
    Object.values(panels).forEach(x => x.classList.add('hidden'));
    if (panels[key]) panels[key].classList.remove('hidden');
  }));
}

// ═══════════════════════════════════════════════════════
// ── Notebook → Tasks Parser ──────────────────────────
// ═══════════════════════════════════════════════════════

function parseNotebookToTasks(raw) {
  let nb;
  try {
    if (typeof raw === 'string') {
      const m = raw.match(/```json\n?([\s\S]*?)\n?```/) || raw.match(/```\n?([\s\S]*?)\n?```/);
      nb = JSON.parse(m ? m[1] : raw);
    } else nb = raw;
  } catch { nb = null; }

  state.results.notebookParsed = nb;
  state.tasks = [];

  if (!nb || !nb.cells) return;

  const cells = nb.cells;
  let pendingMd = '';

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const src = Array.isArray(c.source) ? c.source.join('') : c.source;

    if (c.cell_type === 'markdown') {
      pendingMd += (pendingMd ? '\n\n' : '') + src;
    } else if (c.cell_type === 'code') {
      // Extract name from preceding markdown
      let name = `Code Block ${state.tasks.length + 1}`;
      const heading = pendingMd.match(/^#+\s+(.+)/m);
      if (heading) name = heading[1].trim();

      state.tasks.push({
        name,
        description: pendingMd,
        code: src,
        outputHtml: '',
        done: false,
        cellIndex: i,
      });
      pendingMd = '';
    }
  }

  // If there's trailing markdown with no code, add it as an info task
  if (pendingMd.trim()) {
    state.tasks.push({
      name: 'Summary',
      description: pendingMd,
      code: '',
      outputHtml: '',
      done: false,
      cellIndex: -1,
    });
  }
}

// ═══════════════════════════════════════════════════════
// ── Dashboard ────────────────────────────────────────
// ═══════════════════════════════════════════════════════

function openDashboard() {
  // Hide landing, show dashboard
  $('#landingContent').classList.add('hidden');
  $('#navbar').style.maxWidth = '100%';
  const dash = $('#dashboardView');
  dash.classList.remove('hidden');

  // Populate header
  $('#dashTitle').textContent = state.paperTitle || 'Research Paper';
  $('#dashMeta').innerHTML = `
    <span class="meta-tag">AI Generated</span>
    <span class="meta-tag">${state.tasks.length} code blocks</span>
  `;

  // First line of summary as description
  const summaryFirst = (state.results.summary || '').split('\n').find(l => l.trim() && !l.startsWith('#'));
  $('#dashDesc').textContent = summaryFirst ? summaryFirst.replace(/[*_#]/g, '').trim().slice(0, 200) : '';

  $('#trackBadge').textContent = `${state.tasks.length} Tasks`;

  // Render task list
  renderTaskList();

  // Wire back button → goes back to results (not landing)
  $('#dashBackBtn').onclick = closeDashboard;

  // Wire new paper
  $('#dashNewPaperBtn').onclick = startNewPaper;

  // Wire download
  $('#dashDlBtn').onclick = () => {
    const nb = state.results.notebookParsed;
    if (nb) downloadNotebook(nb, state.paperTitle);
  };

  // Show task list, hide detail
  show('taskListView');
  hide('taskDetailView');
}

function closeDashboard() {
  $('#dashboardView').classList.add('hidden');
  // Show parent container + results
  $('#landingContent').classList.remove('hidden');
  show('resultsSection');
  hide('uploadArea');
  $('#navbar').style.maxWidth = '820px';
}

function renderTaskList() {
  const list = $('#taskList');
  list.innerHTML = state.tasks.map((task, i) => {
    const num = String(i + 1).padStart(2, '0');
    const isCode = task.code.trim().length > 0;
    const diffTag = getDifficultyTag(task.code);
    return `<div class="task-card" data-task="${i}">
      <div class="task-num-block">
        <div class="task-label">TASK</div>
        <div class="task-num">${num}</div>
      </div>
      <div class="task-info">
        <div class="task-name">${esc(task.name)}</div>
        <div class="task-desc">${esc(getFirstLine(task.description))}</div>
      </div>
      <div class="task-tags">
        ${isCode ? '<span class="task-tag tag-code">Code</span>' : ''}
        ${diffTag}
      </div>
      <div class="task-status ${task.done ? 'done' : ''}" id="taskStatus${i}"></div>
    </div>`;
  }).join('');

  // Click handlers
  list.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => openTask(parseInt(card.dataset.task)));
  });
}

function getDifficultyTag(code) {
  const lines = code.split('\n').filter(l => l.trim()).length;
  if (lines <= 5) return '<span class="task-tag tag-easy">Easy</span>';
  if (lines <= 20) return '<span class="task-tag tag-medium">Medium</span>';
  return '<span class="task-tag tag-micro">Complex</span>';
}

function getFirstLine(md) {
  const lines = md.split('\n');
  for (const l of lines) {
    const clean = l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
    if (clean && clean.length > 5) return clean.slice(0, 100);
  }
  return '';
}

// ═══════════════════════════════════════════════════════
// ── Task Detail (Split View) ─────────────────────────
// ═══════════════════════════════════════════════════════

function openTask(idx) {
  state.activeTask = idx;
  const task = state.tasks[idx];

  hide('taskListView');
  show('taskDetailView');

  // Topbar
  $('#detailName').textContent = task.name;

  // Description panel — always visible on left
  const descContent = isRichDescription(task.description)
    ? task.description
    : enrichDescription(task);
  $('#detailDesc').innerHTML = renderMarkdown(descContent);

  // Code editor
  const editor = $('#detailCodeEditor');
  editor.value = task.code;
  editor.style.display = task.code ? 'block' : 'none';

  // Output (below code on right)
  const outputArea = $('#detailOutputArea');
  outputArea.innerHTML = task.outputHtml || '<span class="out-empty">Run the code to see output here</span>';

  // Wire back
  $('#detailBackBtn').onclick = () => {
    task.code = editor.value;
    hide('taskDetailView');
    show('taskListView');
    renderTaskList();
  };

  // Wire run
  const runBtn = $('#detailRunBtn');
  runBtn.disabled = !task.code.trim();
  runBtn.onclick = () => runCurrentTask();

  // Keyboard shortcut: Ctrl+Enter to run
  editor.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runCurrentTask();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editor.selectionStart, end = editor.selectionEnd;
      editor.value = editor.value.substring(0, s) + '    ' + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = s + 4;
    }
  };
}

// Check if description has real content (not just a heading)
function isRichDescription(md) {
  if (!md || !md.trim()) return false;
  const lines = md.split('\n').map(l => l.trim()).filter(Boolean);
  // Filter out heading-only lines
  const contentLines = lines.filter(l => !l.startsWith('#'));
  // Need at least 2 lines of actual content
  const totalContent = contentLines.join(' ').replace(/[*_`]/g, '').trim();
  return totalContent.length > 80;
}

function enrichDescription(task) {
  let md = '';

  // Start with existing markdown if any
  if (task.description.trim()) {
    md += task.description.trim() + '\n\n';
  } else {
    md += `## ${task.name}\n\n`;
  }

  // Mine context from the code
  const lines = task.code.split('\n');
  const comments = lines.filter(l => l.trim().startsWith('#'))
    .map(l => l.replace(/^\s*#+\s*/, '').trim()).filter(c => c.length > 3);
  const funcs = lines.filter(l => /^\s*def\s+/.test(l))
    .map(l => l.match(/def\s+(\w+)/)?.[1]).filter(Boolean);
  const imports = lines.filter(l => /^\s*(import|from)\s+/.test(l))
    .map(l => l.trim());

  if (comments.length) {
    md += '**What this code does:**\n';
    // Deduplicate similar comments
    const unique = [...new Set(comments)].slice(0, 8);
    md += unique.map(c => `- ${c}`).join('\n') + '\n\n';
  }

  if (funcs.length) {
    md += `**Functions:** ${funcs.map(f => '`' + f + '()`').join(', ')}\n\n`;
  }

  if (imports.length) {
    const pkgs = imports.map(i => {
      const m = i.match(/(?:import|from)\s+(\w+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    const uniquePkgs = [...new Set(pkgs)];
    if (uniquePkgs.length) {
      md += `**Libraries:** ${uniquePkgs.map(p => '`' + p + '`').join(', ')}\n\n`;
    }
  }

  // Try to find a relevant paragraph from the paper's explanation
  const explanation = state.results.explanation || '';
  if (explanation && task.name) {
    const keywords = task.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    if (keywords.length) {
      const paragraphs = explanation.split(/\n\n+/).filter(p => p.trim().length > 60);
      for (const para of paragraphs) {
        const lower = para.toLowerCase();
        const matches = keywords.filter(kw => lower.includes(kw));
        if (matches.length >= Math.min(2, keywords.length)) {
          // Clean markdown artifacts and add as context
          const clean = para.replace(/^#+\s*.*$/gm, '').trim();
          if (clean.length > 40) {
            md += '---\n\n**From the paper:**\n\n' + clean.slice(0, 500) + '\n';
            break;
          }
        }
      }
    }
  }

  if (md.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')).length < 2) {
    md += '\n*Click **Run** to execute this code and see the results below.*\n';
  }

  return md;
}

async function runCurrentTask() {
  const idx = state.activeTask;
  if (idx === null) return;
  const task = state.tasks[idx];
  const editor = $('#detailCodeEditor');
  task.code = editor.value;
  const code = task.code.trim();
  if (!code) return;

  const runBtn = $('#detailRunBtn');
  const outputArea = $('#detailOutputArea');
  const pyStatus = $('#pyStatus');

  // UI: running
  runBtn.disabled = true;
  runBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="20"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite"/></circle></svg> Running…';
  outputArea.innerHTML = '<span class="out-empty">Executing…</span>';

  try {
    const result = await runCell(code, (status) => { pyStatus.textContent = status; });
    pyStatus.textContent = 'Python ready';
    state.execCount++;

    let html = '';
    if (result.stdout) html += `<div class="out-text">${esc(result.stdout)}</div>`;
    if (result.plots?.length) {
      for (const plot of result.plots) {
        html += `<div class="out-plot"><img src="data:image/png;base64,${plot}" alt="Plot"/></div>`;
      }
    }
    if (result.error) html += `<div class="out-error">${esc(result.error)}</div>`;
    if (result.stderr && !result.error) html += `<div class="out-error">${esc(result.stderr)}</div>`;

    outputArea.innerHTML = html || '<span class="out-empty">✓ Completed (no output)</span>';
    task.outputHtml = outputArea.innerHTML;
    task.done = true;

    const statusEl = $(`#taskStatus${idx}`);
    if (statusEl) statusEl.classList.add('done');

  } catch (err) {
    outputArea.innerHTML = `<div class="out-error">${esc(err.message)}</div>`;
    task.outputHtml = outputArea.innerHTML;
  }

  // Restore button
  runBtn.disabled = false;
  runBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 2l10 6-10 6V2z" fill="currentColor"/></svg> Run`;
}

// ── Scroll Reveal ──────────────────────────────────────

function initReveal() {
  const obs = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('vis'); }), { threshold: 0.08 });
  $$('.f, .s').forEach((el, i) => { el.style.transitionDelay = `${i * 50}ms`; obs.observe(el); });
}

// ═══════════════════════════════════════════════════════
// ── Utils ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function show(id) { $(`#${id}`)?.classList.remove('hidden'); }
function hide(id) { $(`#${id}`)?.classList.add('hidden'); }
function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
function titleFromUrl(u) { try { const p = new URL(u).pathname.split('/'); return p[p.length - 1].replace('.pdf', '').replace(/[-_]/g, ' ') || 'Paper'; } catch { return 'Paper'; } }
function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function dl(c, n, t) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([c], { type: t })); a.download = n; a.click(); }
function shake(el) { el.style.animation = 'shake .35s ease'; el.addEventListener('animationend', () => { el.style.animation = ''; }, { once: true }); }

const _s = document.createElement('style');
_s.textContent = '@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}50%{transform:translateX(5px)}75%{transform:translateX(-3px)}}';
document.head.appendChild(_s);
