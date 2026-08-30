import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import { extractText } from './src/pdf.js';
import { ingest, ragStatus } from './src/rag.js';
import { newId } from './src/schema.js';
import { save, load, list } from './src/store.js';
import { getPrefs, putPrefs } from './src/prefs.js';
import { generateLesson, editBlock, editLesson, duplicateLesson, roadmap, reorderBlocks } from './src/engine.js';
import { renderLesson, renderLessonBody, renderBlock, STYLES, SCRIPT } from './src/render/index.js';
import { renderSlides } from './src/render/slides.js';
import { provider, stats, resolveModelChain, getModelChain } from './src/llm.js';
import { withProgress } from './src/progress.js';
import { verifyEnabled } from './src/verifier.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('demo'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error('[api]', e.message);
  res.status(e.status || 500).json({ error: e.message, code: e.code });
});

// The renderer's own CSS/JS, so any host page can embed rendered lesson HTML.
app.get('/lesson.css', (_req, res) => res.type('css').send(STYLES));
app.get('/lesson.js', (_req, res) => res.type('js').send(SCRIPT));

app.get('/health', (_req, res) =>
  res.json({ ok: true, provider: provider(), modelChain: getModelChain(), verify: verifyEnabled(), llm: stats, rag: ragStatus }));

app.post('/ingest', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('no file uploaded (field name: file)'), { status: 400 });
  const name = req.file.originalname || 'material.txt';
  if (!/\.(txt|md|pdf)$/i.test(name)) throw Object.assign(new Error('only .txt, .md and .pdf are supported'), { status: 400 });

  const { teacherId, subject, board, grade } = req.body || {};
  const missing = ['teacherId', 'subject', 'board', 'grade'].filter(f => !String(req.body?.[f] || '').trim());
  if (missing.length) throw Object.assign(new Error(`missing required field(s): ${missing.join(', ')}`), { status: 400, code: 'MATERIAL_METADATA_REQUIRED' });

  const text = await extractText(req.file.buffer, name);
  if (!text.trim()) throw Object.assign(new Error('no text could be extracted from that file'), { status: 400 });

  const materialId = newId('mat');
  const attribution = req.body.attribution || `Teacher upload, ${name}`;
  const chunks = await ingest(text, {
    materialId,
    source_id: materialId,
    source_name: name,
    board, grade, subject,
    content_type: 'chapter',
    authority_level: req.body.authority_level || 'teacher_upload',
    attribution_string: attribution,
  });
  save('materials', materialId, {
    id: materialId, materialId, teacherId, subject, board, grade,
    filename: name, name, attribution, chars: text.length, uploadedAt: new Date().toISOString(), chunks,
  });
  res.json({ materialId, name, chars: text.length, chunks: chunks.length });
}));

app.get('/materials', (req, res) => {
  const { teacherId } = req.query;
  const mats = list('materials')
    .filter(m => !teacherId || m.teacherId === teacherId)
    .map(({ chunks, ...m }) => ({ ...m, chunks: chunks?.length ?? 0 }))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  res.json({ materials: mats });
});

// Server-Sent Events helper: returns an `emit(event)` bound to the response.
function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return event => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

app.post('/generate', wrap(async (req, res) => {
  const { materialId, materialIds, spec = {}, teacherId = 'default', stream } = req.body || {};

  if (!stream) {
    const lesson = await generateLesson(spec, materialId, teacherId, materialIds);
    return res.json({ lesson, html: renderLessonBody(lesson), timeFit: lesson.timeFit });
  }

  // Streaming mode: progress events, then a final done event carrying the lesson + html.
  const emit = sseStart(res);
  try {
    const lesson = await withProgress(emit, () => generateLesson(spec, materialId, teacherId, materialIds));
    emit({ step: 'rendering' });
    emit({ done: true, lessonId: lesson.id, lesson, html: renderLessonBody(lesson), timeFit: lesson.timeFit });
  } catch (e) {
    emit({ error: e.message, code: e.code });
  }
  res.end();
}));

app.post('/edit-block', wrap(async (req, res) => {
  const { lessonId, blockId, instruction, complexity, visualDemand } = req.body || {};
  const { block, timeFit } = await editBlock(lessonId, blockId, { instruction, complexity, visualDemand });
  res.json({ block, blockHtml: renderBlock(block), timeFit });
}));

app.post('/edit-lesson', wrap(async (req, res) => {
  const { lessonId, instruction, stream } = req.body || {};
  if (!stream) {
    const out = await editLesson(lessonId, instruction);
    return res.json({
      lesson: out.lesson, html: renderLessonBody(out.lesson),
      changedBlockIds: out.changedBlockIds, timeFit: out.timeFit, ops: out.ops, note: out.note,
    });
  }
  const emit = sseStart(res);
  try {
    const out = await withProgress(emit, () => editLesson(lessonId, instruction));
    emit({ done: true, lessonId: out.lesson.id, lesson: out.lesson, html: renderLessonBody(out.lesson),
      changedBlockIds: out.changedBlockIds, timeFit: out.timeFit, ops: out.ops, note: out.note });
  } catch (e) {
    emit({ error: e.message, code: e.code });
  }
  res.end();
}));

app.post('/lessons/:id/duplicate', wrap(async (req, res) =>
  res.json({ lesson: duplicateLesson(req.params.id) })));

// Teammate spec D3: persist a drag-drop reorder. No LLM.
app.post('/lessons/:id/reorder', wrap(async (req, res) => {
  const lesson = reorderBlocks(req.params.id, req.body?.blockIds);
  res.json({ lesson, html: renderLessonBody(lesson), timeFit: lesson.timeFit });
}));

app.get('/lessons', (_req, res) => res.json({
  lessons: list('lessons')
    .map(l => ({ id: l.id, title: l.title, grade: l.grade, subject: l.subject, topic: l.topic, blocks: l.blocks.length, durationMins: l.durationMins }))
}));

app.get('/lessons/:id', (req, res) => {
  const lesson = load('lessons', req.params.id);
  if (!lesson) return res.status(404).json({ error: 'lesson not found' });
  if (req.query.format === 'html') return res.type('html').send(renderLesson(lesson));
  if (req.query.format === 'slides') return res.type('html').send(renderSlides(lesson));  // stretch S1/S2
  res.json({ lesson, html: renderLessonBody(lesson), timeFit: lesson.timeFit });
});

// Stretch S3: a multi-lesson roadmap for the whole topic.
app.post('/roadmap', wrap(async (req, res) => {
  const { materialId, spec = {}, teacherId = 'default' } = req.body || {};
  res.json(await roadmap(spec, materialId, teacherId));
}));

app.get('/prefs/:teacherId', (req, res) => res.json({ prefs: getPrefs(req.params.teacherId) }));
app.put('/prefs/:teacherId', (req, res) => res.json({ prefs: putPrefs(req.params.teacherId, req.body || {}) }));

export { app };

// Only bind a port when run directly (node server.js), so tests can import the app.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Lesson engine on http://localhost:${port} (provider: ${provider()}, verify: ${verifyEnabled() ? 'on' : 'off'})`);
    if (provider() === 'gemini') resolveModelChain().catch(() => {});   // warm the model chain
  });
}
