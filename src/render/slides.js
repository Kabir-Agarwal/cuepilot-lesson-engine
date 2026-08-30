// Stretch S1/S2: slideshow mode — one block per slide, prev/next, Play reads the
// block's narration via the browser's speechSynthesis, and interactives autoplay on entry.
import { renderBlock, STYLES, esc } from './index.js';

export function renderSlides(lesson) {
  const slides = lesson.blocks.map((b, i) => `
    <section class="slide" data-i="${i}" data-narration="${esc(b.narration || '')}">
      <div class="slide-inner">${renderBlock(b)}</div>
    </section>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(lesson.title)} — slides</title>
<style>${STYLES}
  body{background:#0f1115}
  .deck{max-width:60rem;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
  .bar{position:sticky;top:0;display:flex;gap:.5rem;align-items:center;padding:.75rem 1rem;background:#0f1115;color:#e8eaee;z-index:5}
  .bar h1{font-size:1rem;margin:0;flex:1;font-weight:600}
  .bar button{background:var(--accent);border:0;color:#fff;border-radius:8px;padding:.4rem .8rem;cursor:pointer}
  .bar button.ghost{background:#222634}
  .bar .count{font-size:.85rem;color:#aeb4c0;min-width:4rem;text-align:center}
  .stage{flex:1;display:grid;place-items:center;padding:1.5rem}
  .slide{display:none;width:100%}
  .slide.on{display:block;animation:in .35s ease}
  @keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  .slide-inner .block{margin:0}
</style></head>
<body><div class="deck">
  <div class="bar">
    <h1>${esc(lesson.title)}</h1>
    <span class="count" id="count"></span>
    <button class="ghost" id="prev">‹ Prev</button>
    <button class="ghost" id="next">Next ›</button>
    <button id="play">▶ Play</button>
  </div>
  <div class="stage">${slides}</div>
</div>
<script>
const slides = [...document.querySelectorAll('.slide')];
let i = 0, playing = false;
function autoplay(slide){
  // S2: nudge the interactive on the slide so it demonstrates itself.
  const nl = slide.querySelector('.nl-mark:nth-of-type(2)'); if (nl) setTimeout(()=>nl.click(), 400);
  const step = slide.querySelector('.seq-step'); if (step) setTimeout(()=>step.click(), 400);
}
function show(n){
  i = Math.max(0, Math.min(slides.length-1, n));
  slides.forEach((s,k)=>s.classList.toggle('on', k===i));
  document.getElementById('count').textContent = (i+1)+' / '+slides.length;
  autoplay(slides[i]);
  if (playing) speak();
}
function speak(){
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const t = slides[i].dataset.narration; if (!t) return;
  const u = new SpeechSynthesisUtterance(t);
  u.onend = ()=>{ if (playing && i < slides.length-1) show(i+1); else playing=false, sync(); };
  speechSynthesis.speak(u);
}
function sync(){ document.getElementById('play').textContent = playing ? '⏸ Pause' : '▶ Play'; }
document.getElementById('prev').onclick = ()=>show(i-1);
document.getElementById('next').onclick = ()=>show(i+1);
document.getElementById('play').onclick = ()=>{ playing=!playing; sync(); if(playing) speak(); else speechSynthesis.cancel(); };
document.addEventListener('keydown', e=>{ if(e.key==='ArrowRight')show(i+1); if(e.key==='ArrowLeft')show(i-1); });
show(0);
</script></body></html>`;
}
