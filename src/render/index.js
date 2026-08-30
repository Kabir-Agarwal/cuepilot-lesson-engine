// Deterministic renderers. The LLM never writes HTML — it only writes lesson JSON.
// Document mode = a scrollable, web-native lesson page with live, animated blocks.

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
  flowchart: 'How it works', pro_tip: 'Pro tips', match_game: 'Matching game',
};

// A small inline-SVG icon per block type, drawn on a 20px / 1.75-stroke grid.
const ICONS = {
  hook: '<path d="M10 3v2M4.2 6.2l1.4 1.4M15.8 6.2l-1.4 1.4M6 12a4 4 0 1 1 8 0c0 1.6-1 2.3-1.4 3.2H7.4C7 14.3 6 13.6 6 12Z"/><path d="M8 17h4"/>',
  explain: '<path d="M4 4h12v9H8l-4 3z"/>',
  number_line: '<path d="M3 12h14M5 10v4M9 10v4M13 10v4M17 10v4"/>',
  bar_compare: '<path d="M4 16V9M9 16V5M14 16v-4"/><path d="M3 16h14"/>',
  sequence: '<path d="M6 4h9M6 10h9M6 16h9"/><circle cx="3.2" cy="4" r="1"/><circle cx="3.2" cy="10" r="1"/><circle cx="3.2" cy="16" r="1"/>',
  mcq: '<circle cx="10" cy="10" r="7"/><path d="M8 8.5a2 2 0 1 1 2.7 1.9c-.4.2-.7.6-.7 1.1v.3"/><path d="M10 14h.01"/>',
  activity: '<path d="M10 3v14M3 10h14M6 6l8 8M14 6l-8 8"/>',
  exit_ticket: '<path d="M4 4h9v12H4z"/><path d="M13 8h3v8H8"/><path d="M11 12h.01"/>',
  teacher_notes: '<path d="M5 3h10v14l-5-2.5L5 17z"/>',
  flowchart: '<rect x="6" y="3" width="8" height="3.5" rx="1"/><rect x="6" y="13.5" width="8" height="3.5" rx="1"/><path d="M10 6.5v7"/><path d="M8 10l2-2 2 2-2 2z"/>',
  pro_tip: '<path d="M10 3a5 5 0 0 1 3 9c-.5.4-.8 1-.8 1.6H7.8c0-.6-.3-1.2-.8-1.6A5 5 0 0 1 10 3Z"/><path d="M8 17h4"/>',
  match_game: '<circle cx="6" cy="6" r="2.2"/><circle cx="14" cy="14" r="2.2"/><path d="M8 6h4a2 2 0 0 1 2 2v3.8M12 14H8a2 2 0 0 1-2-2V8.2"/>',
};

const icon = type => `<svg class="kind-ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type] || ''}</svg>`;

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
  ${d.options.map((o, i) => `<button type="button" class="opt" data-i="${i}"><span class="opt-mark" aria-hidden="true"></span><span class="opt-text">${esc(o)}</span></button>`).join('')}
  <p class="mcq-explain" hidden>${esc(d.explanation)}</p>
</div>`,

  activity: d => `<h3>${esc(d.title)}</h3>
${d.materials?.length ? `<p class="materials"><strong>You need:</strong> ${d.materials.map(m => `<span class="chip">${esc(m)}</span>`).join(' ')}</p>` : ''}
<ol class="instructions">${d.instructions.map(i => `<li>${esc(i)}</li>`).join('')}</ol>`,

  exit_ticket: d => `<ol class="exit">${d.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>`,

  teacher_notes: d => `<ul class="notes">${d.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`,

  flowchart: (d) => {
    const nodes = (d.nodes || []).map((n, i) => {
      const last = i === d.nodes.length - 1;
      const branch = n.type === 'decision' && (n.yes || n.no)
        ? `<div class="flow-branch"><span class="flow-yes">${esc(n.yes || 'Yes')}</span><span class="flow-no">${esc(n.no || 'No')}</span></div>`
        : '';
      const arrow = last ? '' : '<div class="flow-arrow" aria-hidden="true"></div>';
      return `<li class="flow-node flow-${attr(n.type)}"><span class="flow-box">${n.type === 'decision' ? '<span class="flow-q" aria-hidden="true">?</span>' : ''}${esc(n.text)}</span>${branch}</li>${arrow}`;
    }).join('');
    return `${d.title ? `<h3 class="flow-title">${esc(d.title)}</h3>` : ''}<ol class="flow">${nodes}</ol>`;
  },

  pro_tip: d => `<div class="protip">
  <div class="protip-head">${icon('pro_tip')}<strong>${esc(d.label || 'Pro tips')}</strong></div>
  <ul class="protip-list">${d.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
</div>`,

  match_game: (d) => {
    const rights = d.pairs.map((p, i) => ({ i, right: p.right }))
      .sort((a, b) => a.right.localeCompare(b.right) || a.i - b.i);
    const left = d.pairs.map((p, i) =>
      `<button type="button" class="match-card" data-key="${i}">${esc(p.left)}</button>`).join('');
    const right = rights.map(r =>
      `<button type="button" class="match-card" data-key="${r.i}">${esc(r.right)}</button>`).join('');
    return `<p class="q">${esc(d.prompt)}</p>
<div class="match" data-total="${d.pairs.length}">
  <div class="match-col">${left}</div>
  <div class="match-col">${right}</div>
</div>
<p class="match-readout" role="status">Tap a card on the left, then its match on the right.</p>`;
  },
};

export function renderBlock(block) {
  const body = BODY[block.type] ? BODY[block.type](block.data) : `<pre>${esc(JSON.stringify(block.data))}</pre>`;
  const sources = (block.sourceRefs || []).map(r => esc(r.attribution)).filter(Boolean);
  const footer = sources.length
    ? `<footer class="src">Source: ${sources.join(' · ')}</footer>`
    : `<footer class="src src-none">Source: teacher material (unmatched)</footer>`;
  return `<article class="block block--${attr(block.type)}" data-block-id="${attr(block.id)}" data-type="${attr(block.type)}">
  <header class="block-head">
    <span class="kind">${icon(block.type)}${esc(BLOCK_LABEL[block.type] || block.type)}</span>
    <span class="badges"><span class="badge" title="Complexity level">C${attr(block.complexity)}</span><span class="badge badge--time">${attr(block.estMinutes)} min</span></span>
  </header>
  <div class="block-body">${body}</div>
  ${footer}
</article>`;
}

export const STYLES = `
:root{
  --ink:#14161a; --muted:#5f6672; --line:#e6e8ee; --paper:#ffffff; --wash:#f4f6fb;
  --accent:#3b5bdb; --accent-soft:#e8edfd; --ok:#2f9e44; --ok-soft:#ebfbee;
  --warn:#e8590c; --warn-soft:#fff4e6; --bad:#e03131; --bad-soft:#fff5f5;
  --radius:16px; --shadow:0 1px 2px rgba(20,22,26,.04),0 6px 20px rgba(20,22,26,.06);
  --font: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);color:var(--ink);background:var(--wash);line-height:1.6;-webkit-font-smoothing:antialiased}
.lesson{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 5rem}
.lesson-head{margin:0 0 1.25rem}
.lesson-head h1{font-size:2rem;line-height:1.15;margin:0 0 .35rem;letter-spacing:-.02em}
.lesson-meta{color:var(--muted);font-size:.9rem;margin:0}
.timefit{margin:1rem 0 1.5rem;padding:.75rem 1rem;border-radius:var(--radius);font-size:.9rem;border:1px solid var(--line);background:var(--paper)}
.timefit.ok{border-color:#cfe6d4;background:var(--ok-soft)}
.timefit.over{border-color:#f2d3a6;background:var(--warn-soft)}

/* Blocks carry a per-kind accent stripe + tinted icon chip. */
.block{position:relative;background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.25rem 1.35rem;margin:0 0 1.1rem;box-shadow:var(--shadow);overflow:hidden}
.block::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--k,var(--accent))}
.block-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.75rem}
.kind{display:inline-flex;align-items:center;gap:.5rem;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--k,var(--accent));font-weight:700}
.kind-ico{width:1.15rem;height:1.15rem;padding:.28rem;box-sizing:content-box;border-radius:8px;background:var(--k-soft,var(--accent-soft));color:var(--k,var(--accent));flex:none}
.badges{display:flex;gap:.35rem}
.badge{font-size:.7rem;padding:.18rem .5rem;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-weight:700}
.badge--time{background:var(--wash);color:var(--muted)}
.block-body>*:first-child{margin-top:0}
.block-body>*:last-child{margin-bottom:0}
.block-body h3{font-size:1.15rem;margin:0 0 .5rem;letter-spacing:-.01em}
.lead{font-size:1.2rem;line-height:1.5;color:var(--ink);font-weight:500}
.q{font-weight:650}
.caption,.materials{color:var(--muted);font-size:.9rem}
.chip{display:inline-block;background:var(--wash);border:1px solid var(--line);border-radius:999px;padding:.1rem .55rem;font-size:.82rem;color:var(--ink)}
.src{margin-top:1rem;padding-top:.65rem;border-top:1px dashed var(--line);font-size:.78rem;color:var(--muted)}
.src-none{opacity:.7}

/* Per-kind hues */
.block--hook{--k:#e8590c;--k-soft:#fff4e6}
.block--explain{--k:#3b5bdb;--k-soft:#e8edfd}
.block--number_line{--k:#0c8599;--k-soft:#e3fafc}
.block--bar_compare{--k:#1971c2;--k-soft:#e7f5ff}
.block--sequence{--k:#5f3dc4;--k-soft:#f3f0ff}
.block--mcq{--k:#2f9e44;--k-soft:#ebfbee}
.block--activity{--k:#e64980;--k-soft:#fff0f6}
.block--exit_ticket{--k:#1098ad;--k-soft:#e3fafc}
.block--teacher_notes{--k:#f08c00;--k-soft:#fff9db}
.block--flowchart{--k:#4263eb;--k-soft:#edf2ff}
.block--pro_tip{--k:#f59f00;--k-soft:#fff9db}
.block--match_game{--k:#ae3ec9;--k-soft:#f8f0fc}
.block--hook .lead{font-size:1.35rem}
.block--teacher_notes{background:#fffdf5}

/* number line */
.number-line{margin:1.6rem 0 .5rem}
.nl-track{position:relative;height:5px;background:linear-gradient(90deg,var(--line),#d7dbe6);border-radius:3px;margin:2.6rem 1rem}
.nl-hopper{position:absolute;top:-10px;left:0;width:24px;height:24px;margin-left:-12px;border-radius:50%;background:var(--k,var(--accent));box-shadow:0 4px 10px rgba(12,133,153,.4);opacity:0;transition:left .45s cubic-bezier(.34,1.4,.5,1),opacity .2s}
.nl-hopper.on{opacity:1}
.nl-mark{position:absolute;top:-10px;transform:translateX(-50%);background:none;border:0;cursor:pointer;padding:0;font:inherit;color:var(--muted)}
.nl-dot{display:block;width:11px;height:11px;margin:6px auto;border-radius:50%;background:#fff;border:2px solid var(--muted);transition:transform .15s,background .15s,border-color .15s}
.nl-mark:hover .nl-dot{transform:scale(1.25)}
.nl-mark[aria-current="true"] .nl-dot{background:var(--k,var(--accent));border-color:var(--k,var(--accent))}
.nl-lbl{display:block;font-size:.78rem;white-space:nowrap}
.nl-readout{font-size:.9rem;color:var(--muted);margin:2.2rem 0 0}

/* bars */
.bars{display:grid;gap:.6rem}
.bar-row{display:grid;grid-template-columns:7rem 1fr 3rem;align-items:center;gap:.6rem}
.bar-label{font-size:.9rem}
.bar-track{background:var(--wash);border:1px solid var(--line);border-radius:8px;height:22px;overflow:hidden}
.bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--k,var(--accent)),color-mix(in srgb,var(--k,var(--accent)) 65%,#fff));border-radius:7px 0 0 7px;transform-origin:left}
.bar-frac{font-size:.85rem;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}

/* sequence as a connected timeline */
.sequence{list-style:none;padding:0;margin:0;display:grid;gap:.1rem}
.seq-step{position:relative;padding:.55rem .6rem .55rem 1.9rem;border-radius:10px;cursor:pointer;transition:background .15s;outline:none}
.seq-step::before{content:"";position:absolute;left:.55rem;top:1.1rem;width:11px;height:11px;border-radius:50%;background:#fff;border:2px solid var(--k,var(--accent))}
.seq-step:not(:last-child)::after{content:"";position:absolute;left:1rem;top:1.7rem;bottom:-.3rem;width:2px;background:var(--line)}
.seq-step strong{display:block}
.seq-step span{color:var(--muted)}
.seq-step.active{background:var(--k-soft,var(--accent-soft))}
.seq-step.active::before{background:var(--k,var(--accent))}

/* mcq */
.mcq{display:grid;gap:.5rem;margin-top:.7rem}
.opt{display:flex;align-items:center;gap:.6rem;text-align:left;font:inherit;padding:.65rem .8rem;border-radius:12px;border:1.5px solid var(--line);background:var(--paper);cursor:pointer;transition:border-color .15s,background .15s,transform .1s}
.opt:hover{border-color:var(--k,var(--accent))}
.opt:active{transform:scale(.99)}
.opt-mark{flex:none;width:1.15rem;height:1.15rem;border-radius:50%;border:2px solid var(--line)}
.opt.correct{border-color:var(--ok);background:var(--ok-soft)}
.opt.correct .opt-mark{border-color:var(--ok);background:var(--ok);box-shadow:inset 0 0 0 2px #fff}
.opt.wrong{border-color:var(--bad);background:var(--bad-soft)}
.opt.wrong .opt-mark{border-color:var(--bad);background:var(--bad);box-shadow:inset 0 0 0 2px #fff}
.mcq-explain{margin:.55rem 0 0;padding:.6rem .8rem;border-radius:10px;background:var(--ok-soft);font-size:.9rem;color:#256b33}

/* lists */
.instructions,.exit{padding-left:1.15rem;display:grid;gap:.4rem;margin:0}
.exit li{list-style:none;background:var(--wash);border:1px solid var(--line);border-radius:10px;padding:.5rem .7rem;margin-left:-1.15rem}
.notes{padding-left:1.1rem;display:grid;gap:.35rem;margin:0}

/* flowchart */
.flow-title{margin:0 0 .8rem}
.flow{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;align-items:center}
.flow-node{width:100%;max-width:26rem;display:flex;flex-direction:column;align-items:center}
.flow-box{position:relative;width:100%;text-align:center;padding:.7rem 1rem;border-radius:12px;border:1.5px solid var(--line);background:var(--paper);font-weight:550;box-shadow:var(--shadow)}
.flow-start .flow-box,.flow-end .flow-box{border-radius:999px;background:var(--k-soft,var(--accent-soft));border-color:transparent;color:var(--k,var(--accent));font-weight:700}
.flow-decision .flow-box{background:var(--warn-soft);border-color:#f6c99a;padding-left:2.2rem}
.flow-q{position:absolute;left:.7rem;top:50%;transform:translateY(-50%);width:1.4rem;height:1.4rem;display:grid;place-items:center;border-radius:50%;background:var(--warn);color:#fff;font-weight:800;font-size:.85rem}
.flow-arrow{width:2px;height:1.5rem;background:var(--line);position:relative}
.flow-arrow::after{content:"";position:absolute;left:50%;bottom:-1px;transform:translateX(-50%);border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid var(--muted)}
.flow-branch{display:flex;gap:.5rem;margin:.5rem 0 .2rem}
.flow-yes,.flow-no{font-size:.75rem;font-weight:700;padding:.15rem .6rem;border-radius:999px}
.flow-yes{background:var(--ok-soft);color:#256b33}
.flow-no{background:var(--bad-soft);color:#a12}

/* pro tip callout */
.protip{border:1.5px solid #ffe08a;background:linear-gradient(180deg,#fffdf3,#fff9db);border-radius:14px;padding:1rem 1.1rem}
.protip-head{display:flex;align-items:center;gap:.5rem;font-weight:800;color:#a5730a;margin-bottom:.5rem}
.protip-head .kind-ico{background:#ffe8a3;color:#a5730a}
.protip-list{margin:0;padding-left:1.2rem;display:grid;gap:.35rem}
.protip-list li{color:#5c4708}

/* matching game */
.match{display:grid;grid-template-columns:1fr 1fr;gap:.6rem 1rem;margin-top:.7rem}
.match-col{display:grid;gap:.5rem;align-content:start}
.match-card{font:inherit;text-align:center;padding:.6rem .7rem;border-radius:12px;border:1.5px solid var(--line);background:var(--paper);cursor:pointer;transition:border-color .15s,background .15s,transform .1s}
.match-card:hover{border-color:var(--k,var(--accent))}
.match-card.sel{border-color:var(--k,var(--accent));background:var(--k-soft,var(--accent-soft))}
.match-card.done{border-color:var(--ok);background:var(--ok-soft);color:#256b33;cursor:default}
.match-card.miss{border-color:var(--bad);background:var(--bad-soft);animation:shake .3s}
.match-readout{font-size:.9rem;color:var(--muted);margin:.7rem 0 0}
@keyframes shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}

/* Entrance animation — only when the viewer hasn't asked for reduced motion. */
@media (prefers-reduced-motion: no-preference){
  .blocks .block{opacity:0;animation:rise .55s cubic-bezier(.2,.7,.3,1) both}
  .blocks .block:nth-child(1){animation-delay:.03s}
  .blocks .block:nth-child(2){animation-delay:.09s}
  .blocks .block:nth-child(3){animation-delay:.15s}
  .blocks .block:nth-child(4){animation-delay:.21s}
  .blocks .block:nth-child(5){animation-delay:.27s}
  .blocks .block:nth-child(6){animation-delay:.33s}
  .blocks .block:nth-child(7){animation-delay:.39s}
  .blocks .block:nth-child(8){animation-delay:.45s}
  .blocks .block:nth-child(n+9){animation-delay:.5s}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
  .bar-fill{animation:grow .9s cubic-bezier(.2,.7,.3,1) both}
  @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
}
`;

// Progressive enhancement only — the page reads fine (and correct) with JS off.
export const SCRIPT = `
document.addEventListener('click', function (e) {
  var t = e.target;
  var mark = t.closest && t.closest('.nl-mark');
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
  var opt = t.closest && t.closest('.mcq .opt');
  if (opt) {
    var mcq = opt.closest('.mcq');
    if (mcq.dataset.done) return;
    mcq.dataset.done = '1';
    var ans = Number(mcq.dataset.answer);
    mcq.querySelectorAll('.opt').forEach(function (o, i) {
      o.classList.toggle('correct', i === ans);
      o.classList.toggle('wrong', o === opt && i !== ans);
    });
    mcq.querySelector('.mcq-explain').hidden = false;
    return;
  }
  var step = t.closest && t.closest('.seq-step');
  if (step) {
    step.parentElement.querySelectorAll('.seq-step').forEach(function (s) { s.classList.remove('active'); });
    step.classList.add('active');
    return;
  }
  var card = t.closest && t.closest('.match-card');
  if (card) { onMatch(card); return; }
});

function onMatch(card) {
  if (card.classList.contains('done')) return;
  var game = card.closest('.match');
  var readout = game.parentElement.querySelector('.match-readout');
  var sel = game.querySelector('.match-card.sel');
  if (!sel) { card.classList.add('sel'); return; }
  if (sel === card) { card.classList.remove('sel'); return; }
  if (sel.parentElement === card.parentElement) {   // two from the same column: move selection
    sel.classList.remove('sel'); card.classList.add('sel'); return;
  }
  sel.classList.remove('sel');
  if (sel.dataset.key === card.dataset.key) {
    sel.classList.add('done'); card.classList.add('done');
    var done = game.querySelectorAll('.match-card.done').length / 2;
    var total = Number(game.dataset.total);
    if (readout) readout.textContent = done >= total ? 'All matched — nice work!' : (done + ' of ' + total + ' matched.');
  } else {
    [sel, card].forEach(function (el) {
      el.classList.add('miss');
      setTimeout(function () { el.classList.remove('miss'); }, 320);
    });
    if (readout) readout.textContent = 'Not a match — try again.';
  }
}

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target.closest && e.target.closest('.seq-step, .match-card, .opt, .nl-mark');
  if (el) { e.preventDefault(); el.click(); }
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
