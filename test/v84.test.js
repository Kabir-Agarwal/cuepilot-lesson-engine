import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, MATERIAL } from './setup.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { getLastPrompt } from '../src/llm.js';
import { generateLesson, editBlock } from '../src/engine.js';
import { plan } from '../src/planner.js';
import { VISUAL_TYPES } from '../src/visual.js';

const MAT = 'mat_v84';
async function seed() {
  const chunks = await ingest(MATERIAL, {
    materialId: MAT, source_id: MAT, source_name: 'fractions.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
  });
  save('materials', MAT, { id: MAT, materialId: MAT, teacherId: 'default', subject: 'Mathematics', name: 'fractions.txt', chunks });
}
const countVisual = lesson => lesson.blocks.filter(b => VISUAL_TYPES.includes(b.type)).length;

test('visualDemand: directive reaches the planner prompt', async () => {
  await seed();
  const spec = { ...SPEC, visualDemand: 1, materialIds: [MAT] };
  await plan(spec, [{ attribution_string: 'x', content: 'fractions equal parts' }], { textDensity: 'medium' });
  assert.match(getLastPrompt(), /VISUAL DEMAND 1\/5/);
  assert.match(getLastPrompt(), /text-first/);
});

test('visualDemand: directive also reaches the filler prompt, alongside complexity', async () => {
  await seed();
  await generateLesson({ ...SPEC, visualDemand: 5, defaultComplexity: 4, durationMins: 60 }, MAT, 'default');
  const p = getLastPrompt();
  assert.match(p, /VISUAL DEMAND 5\/5/);
  assert.match(p, /COMPLEXITY 4\/5/);   // the two axes are independent and both present
});

test('visualDemand: mock planner mix shifts from text-first (1) to visual-first (5)', async () => {
  await seed();
  const low = await generateLesson({ ...SPEC, visualDemand: 1, durationMins: 90 }, MAT, 'default');
  const high = await generateLesson({ ...SPEC, visualDemand: 5, durationMins: 90 }, MAT, 'default');
  assert.ok(countVisual(high) > countVisual(low),
    `visual blocks should rise with demand (v1=${countVisual(low)} < v5=${countVisual(high)})`);
  assert.ok(low.blocks.filter(b => b.type === 'explain').length >= high.blocks.filter(b => b.type === 'explain').length);
  assert.equal(low.visualDemand, 1);
  assert.equal(high.visualDemand, 5);
});

test('editBlock: visualDemand alone is a valid edit and keeps siblings byte-identical', async () => {
  await seed();
  const lesson = await generateLesson({ ...SPEC, visualDemand: 3, durationMins: 60 }, MAT, 'default');
  const before = lesson.blocks.map(b => JSON.stringify(b));
  const target = lesson.blocks.find(b => b.type === 'explain');
  const targetIdx = lesson.blocks.findIndex(b => b.id === target.id);

  const { block } = await editBlock(lesson.id, target.id, { visualDemand: 5 });
  assert.equal(block.id, target.id, 'id preserved');

  const { default: fs } = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/lessons/${lesson.id}.json`, 'utf8'));
  saved.blocks.forEach((b, i) => {
    if (i === targetIdx) return;
    assert.equal(JSON.stringify(b), before[i], `sibling ${i} (${b.id}) must stay byte-identical`);
  });
});

test('editBlock: high visualDemand may retype a prose block to a representation', async () => {
  await seed();
  const lesson = await generateLesson({ ...SPEC, visualDemand: 3, durationMins: 60 }, MAT, 'default');
  const explain = lesson.blocks.find(b => b.type === 'explain');
  const { block } = await editBlock(lesson.id, explain.id, { visualDemand: 5 });
  assert.equal(block.id, explain.id);
  assert.ok(VISUAL_TYPES.includes(block.type), `explain retyped to a visual type, got ${block.type}`);
});

test('editBlock: still requires at least one of the three params', async () => {
  await seed();
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, MAT, 'default');
  await assert.rejects(() => editBlock(lesson.id, lesson.blocks[0].id, {}), /at least one/);
});
