// Deterministic renderers. The LLM never writes HTML — it only writes lesson JSON.
// Document mode = a scrollable, web-native lesson page with live blocks.

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const attr = esc; // same rules, named for readability at call sites

const BLOCK_LABEL = {
  hook: 'Hook', explain: 'Explanation', number_line: 'Number line', bar_compare: 'Compare',
  sequence: 'Steps', mcq: 'Check understanding', activity: 'Activity',
  exit_ticket: 'Exit ticket', teacher_notes: 'Teacher notes',
};

const BODY = {
  hook: d => `<p class="lead">${esc(d.text)}</p>`,

  explain: d => `<h3>${esc(d.heading)}</h3>${d.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}`,

  number_line: (d) => {
    const span = d.max - d.min || 1;
    const marks = (d.marks || []).map((m, i) => {
      const pct = ((m.value - d.min) / span) * 100;
      return `<button type="button" class="nl-mark" data-i="${i}" style="left:${pct.toFixed(3)}%" aria-label="${attr(m.label)}"><span class="nl-dot"></span><span class="nl-lbl">${esc(m.label)}</span></button>`;
    }).join('');
    return `<p class="q">${esc(d.question)}</p>
<div class="number-line" data-min="${attr(d.min)}" data-max="${attr(d.max)}" data-step="${attr(d.step)}">
  <div class="nl-track"><div class="nl-hopper" aria-hidden="true"></div>${marks}</div>
  <p class="nl-readout" role="status">Tap a mark to hop along the line.</p>
</div>`;
  },

  bar_compare: (d) => {
    const items = d.items.map((it) => {
      const pct = Math.max(0, Math.min(100, (it.numerator / it.denominator) * 100));
      return `<div class="bar-row">
  <span class="bar-label">${esc(it.label)}</span>
  <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(2)}%"></span></span>
  <span class="bar-frac">${esc(it.numerator)}/${esc(it.denominator)}</span>
</div>`;
    }).join('');
    return `<div class="bars">${items}</div><p class="caption">${esc(d.caption)}</p>`;
  },

  sequence: d => `<ol class="sequence">${d.steps.map(s =>
    `<li class="seq-step" tabindex="0"><strong>${esc(s.title)}</strong><span>${esc(s.text)}</span></li>`).join('')}</ol>`,

  mcq: d => `<p class="q">${esc(d.question)}</p>
<div class="mcq" data-answer="${attr(d.answerIndex)}">
  ${d.options.map((o, i) => `<button type="button" class="opt" data-i="${i}">${esc(o)}</button>`).join('')}
  <p class="mcq-explain" hidden>${esc(d.explanation)}</p>
</div>`,

  activity: d => `<h3>${esc(d.title)}</h3>
${d.materials?.length ? `<p class="materials"><strong>You need:</strong> ${d.materials.map(esc).join(', ')}</p>` : ''}
<ol class="instructions">${d.instructions.map(i => `<li>${esc(i)}</li>`).join('')}</ol>`,

  exit_ticket: d => `<ol class="exit">${d.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>`,

  teacher_notes: d => `<ul class="notes">${d.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`,
};

export function renderBlock(block) {
  const body = BODY[block.type] ? BODY[block.type](block.data) : `<pre>${esc(JSON.stringify(block.data))}</pre>`;
  const sources = (block.sourceRefs || []).map(r => esc(r.attribution)).filter(Boolean);
  const footer = sources.length
    ? `<footer class="src">Source: ${sources.join(' · ')}</footer>`
    : `<footer class="src src-none">Source: teacher material (unmatched)</footer>`;
  return `<article class="block block--${attr(block.type)}" data-block-id="${attr(block.id)}" data-type="${attr(block.type)}">
  <header class="block-head">
    <span class="kind">${esc(BLOCK_LABEL[block.type] || block.type)}</span>
    <span class="badges"><span class="badge" title="Complexity level">C${attr(block.complexity)}</span><span class="badge badge--time">${attr(block.estMinutes)} min</span></span>
  </header>
  <div class="block-body">${body}</div>
  ${footer}
</article>`;
}

export const STYLES = `
:root{
  --ink:#1b1d21; --muted:#5f6672; --line:#e4e6eb; --paper:#ffffff; --wash:#f6f7f9;
  --accent:#3b5bdb; --accent-soft:#e8edfd; --radius:14px;
  --font: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--wash);line-height:1.6;-webkit-font-smoothing:antialiased}
.lesson{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 5rem}
.lesson-head{margin:0 0 1.25rem}
.lesson-head h1{font-size:1.9rem;line-height:1.2;margin:0 0 .35rem;letter-spacing:-.01em}
.lesson-meta{color:var(--muted);font-size:.9rem;margin:0}
.timefit{margin:1rem 0 1.5rem;padding:.75rem 1rem;border-radius:var(--radius);font-size:.9rem;border:1px solid var(--line);background:var(--paper)}
.timefit.ok{border-color:#cfe6d4;background:#f2fbf4}
.timefit.over{border-color:#f2d3a6;background:#fff8ec}
.block{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:1.15rem 1.25rem;margin:0 0 1rem}
.block-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.6rem}
.kind{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.badges{display:flex;gap:.35rem}
.badge{font-size:.7rem;padding:.15rem .45rem;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:600}
.badge--time{background:var(--wash);color:var(--muted)}
.block-body>*:first-child{margin-top:0}
.block-body>*:last-child{margin-bottom:0}
.block-body h3{font-size:1.1rem;margin:0 0 .5rem}
.lead{font-size:1.15rem;color:var(--ink)}
.q{font-weight:600}
.caption,.materials{color:var(--muted);font-size:.9rem}
.src{margin-top:.9rem;padding-top:.6rem;border-top:1px dashed var(--line);font-size:.78rem;color:var(--muted)}
.src-none{opacity:.7}
.number-line{margin:1.5rem 0 .5rem}
.nl-track{position:relative;height:4px;background:var(--line);border-radius:2px;margin:2.5rem 1rem}
.nl-hopper{position:absolute;top:-9px;left:0;width:22px;height:22px;margin-left:-11px;border-radius:50%;background:var(--accent);opacity:0;transition:left .45s cubic-bezier(.34,1.4,.5,1),opacity .2s}
.nl-hopper.on{opacity:1}
.nl-mark{position:absolute;top:-10px;transform:translateX(-50%);background:none;border:0;cursor:pointer;padding:0;font:inherit;color:var(--muted)}
.nl-dot{display:block;width:10px;height:10px;margin:6px auto;border-radius:50%;background:#fff;border:2px solid var(--muted)}
.nl-mark[aria-current="true"] .nl-dot{background:var(--accent);border-color:var(--accent)}
.nl-lbl{display:block;font-size:.78rem;white-space:nowrap}
.nl-readout{font-size:.9rem;color:var(--muted);margin:2.2rem 0 0}
.bars{display:grid;gap:.55rem}
.bar-row{display:grid;grid-template-columns:6.5rem 1fr 3rem;align-items:center;gap:.6rem}
.bar-label{font-size:.9rem}
.bar-track{background:var(--wash);border:1px solid var(--line);border-radius:6px;height:20px;overflow:hidden}
.bar-fill{display:block;height:100%;background:var(--accent);border-radius:5px 0 0 5px}
.bar-frac{font-size:.85rem;color:var(--muted);text-align:right}
.sequence{padding-left:1.1rem;display:grid;gap:.5rem}
.seq-step{border-radius:10px;padding:.5rem .6rem;cursor:pointer;transition:background .15s,box-shadow .15s;outline:none}
.seq-step strong{display:block}
.seq-step span{color:var(--muted)}
.seq-step.active{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.mcq{display:grid;gap:.45rem;margin-top:.6rem}
.opt{text-align:left;font:inherit;padding:.6rem .75rem;border-radius:10px;border:1px solid var(--line);background:var(--paper);cursor:pointer}
.opt:hover{border-color:var(--accent)}
.opt.correct{border-color:#2f9e44;background:#ebfbee}
.opt.wrong{border-color:#e03131;background:#fff5f5}
.mcq-explain{margin:.5rem 0 0;font-size:.9rem;color:var(--muted)}
.instructions,.exit,.notes{padding-left:1.1rem;display:grid;gap:.35rem;margin:0}
.block--teacher_notes{background:#fffdf5;border-style:dashed}
`;

// Progressive enhancement only — the page reads fine with JS off.
export const SCRIPT = `
document.addEventListener('click', function (e) {
  var mark = e.target.closest && e.target.closest('.nl-mark');
  if (mark) {
    var line = mark.closest('.number-line');
    var hopper = line.querySelector('.nl-hopper');
    line.querySelectorAll('.nl-mark').forEach(function (m) { m.removeAttribute('aria-current'); });
    mark.setAttribute('aria-current', 'true');
    hopper.classList.add('on');
    hopper.style.left = mark.style.left;
    line.querySelector('.nl-readout').textContent = 'Hopped to ' + mark.textContent.trim() + '.';
    return;
  }
  var opt = e.target.closest && e.target.closest('.mcq .opt');
  if (opt) {
    var mcq = opt.closest('.mcq');
    var ans = Number(mcq.dataset.answer);
    mcq.querySelectorAll('.opt').forEach(function (o, i) {
      o.classList.toggle('correct', i === ans);
      o.classList.toggle('wrong', o === opt && i !== ans);
    });
    mcq.querySelector('.mcq-explain').hidden = false;
    return;
  }
  var step = e.target.closest && e.target.closest('.seq-step');
  if (step) {
    step.parentElement.querySelectorAll('.seq-step').forEach(function (s) { s.classList.remove('active'); });
    step.classList.add('active');
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var step = e.target.closest && e.target.closest('.seq-step');
  if (step) { e.preventDefault(); step.click(); }
});
`;

export function renderTimeFit(timeFit, durationMins) {
  if (!timeFit) return '';
  const cls = timeFit.ok ? 'ok' : 'over';
  const msg = timeFit.ok
    ? `Fits: about ${esc(timeFit.plannedMins)} min of ${esc(durationMins)} min.`
    : esc(timeFit.suggestion);
  return `<p class="timefit ${cls}">${msg}</p>`;
}

/** Body-only HTML — what the UI teammate embeds. */
export function renderLessonBody(lesson) {
  return `<section class="lesson" data-lesson-id="${attr(lesson.id)}">
  <header class="lesson-head">
    <h1>${esc(lesson.title)}</h1>
    <p class="lesson-meta">${esc(lesson.board)} · Grade ${esc(lesson.grade)} · ${esc(lesson.subject)} · Lesson ${esc(lesson.lessonIndex)} of ${esc(lesson.nLessons)} · ${esc(lesson.durationMins)} min</p>
  </header>
  ${renderTimeFit(lesson.timeFit, lesson.durationMins)}
  <div class="blocks">${lesson.blocks.map(renderBlock).join('\n')}</div>
</section>`;
}

/** Standalone page — what /generate returns as `html`. */
export function renderLesson(lesson) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(lesson.title)}</title><style>${STYLES}</style></head>
<body>${renderLessonBody(lesson)}<script>${SCRIPT}</script></body></html>`;
}
