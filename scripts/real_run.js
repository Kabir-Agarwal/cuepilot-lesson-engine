// One real end-to-end run against Gemini, saving fixtures/real-run.json with latency+token notes.
// Empty key => prints SKIP and how to run later. Run: npm run realrun
import 'dotenv/config';
import fs from 'node:fs';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { newId } from '../src/schema.js';
import { generateLesson, editBlock, editLesson } from '../src/engine.js';
import { stats } from '../src/llm.js';

if (!process.env.GEMINI_API_KEY) {
  console.log('SKIP — GEMINI_API_KEY is empty.');
  console.log('To run later: paste GEMINI_API_KEY into .env, keep LLM_PROVIDER=gemini, then `npm run realrun`.');
  process.exit(0);
}

const snap = () => ({ calls: stats.calls, ms: stats.ms, promptChars: stats.promptChars, completionChars: stats.completionChars });
const delta = (a, b) => ({ calls: b.calls - a.calls, ms: b.ms - a.ms, approxPromptTokens: Math.round((b.promptChars - a.promptChars) / 4), approxCompletionTokens: Math.round((b.completionChars - a.completionChars) / 4) });

const text = fs.readFileSync('fixtures/fractions.txt', 'utf8');
const materialId = newId('mat');
const chunks = await ingest(text, {
  materialId, source_id: materialId, source_name: 'fractions.txt',
  board: 'CBSE', grade: '4', subject: 'Mathematics',
  authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
});
save('materials', materialId, { id: materialId, materialId, teacherId: 'demo-teacher', subject: 'Mathematics', board: 'CBSE', grade: '4', filename: 'fractions.txt', uploadedAt: new Date().toISOString(), chunks });

const report = {};
let s = snap();
let lesson;
try {
  lesson = await generateLesson(
  { board: 'CBSE', grade: '4', subject: 'Mathematics', topic: 'Fractions', nLessons: 3, lessonIndex: 1, durationMins: 40, defaultComplexity: 3, instructions: '' },
  materialId, 'demo-teacher');
} catch (e) {
  console.log(`SKIP — live run could not complete: ${e.message}`);
  console.log('Likely a transient 429/503 (model overloaded). Retry later with `npm run realrun`. The server itself degrades to mock, so the demo is unaffected.');
  process.exit(0);
}
report.generate = delta(s, snap());
console.log('generate:', report.generate, '| blocks:', lesson.blocks.length, '| timeFit:', lesson.timeFit);

const explain = lesson.blocks.find(b => b.type === 'explain') || lesson.blocks[1];
s = snap();
await editBlock(lesson.id, explain.id, { complexity: 1 });   // slider 3 -> 1
report.editBlock = delta(s, snap());
console.log('editBlock (slider 3->1):', report.editBlock);

s = snap();
const el = await editLesson(lesson.id, 'add an assessment at the end');
report.editLesson = delta(s, snap());
console.log('editLesson (add assessment):', report.editLesson, '| changed:', el.changedBlockIds);

fs.writeFileSync('fixtures/real-run.json', JSON.stringify({ ranAt: new Date().toISOString(), report, lesson: el.lesson }, null, 2));
console.log('saved fixtures/real-run.json  (token counts are approximate: chars/4)');
