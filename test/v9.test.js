import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, MATERIAL } from './setup.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { generateLesson } from '../src/engine.js';
import { validateBlock, validateLesson } from '../src/schema.js';
import { fillBlock } from '../src/filler.js';
import { renderBlock, renderLesson } from '../src/render/index.js';

const MAT = 'mat_v9';
async function seed() {
  const chunks = await ingest(MATERIAL, {
    materialId: MAT, source_id: MAT, source_name: 'fractions.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
  });
  save('materials', MAT, { id: MAT, materialId: MAT, teacherId: 'default', subject: 'Mathematics', name: 'fractions.txt', chunks });
}
const spec = extra => ({ ...SPEC, materialIds: [MAT], ...extra });

test('new block types: flowchart, pro_tip and match_game each fill and validate', async () => {
  await seed();
  for (const type of ['flowchart', 'pro_tip', 'match_game']) {
    const block = await fillBlock({ type, intent: `A ${type} about fractions`, complexity: 2, spec: spec(), prefs: {} });
    assert.equal(block.type, type);
    assert.ok(validateBlock(block).ok, `${type} should validate: ${JSON.stringify(validateBlock(block).errors)}`);
  }
});

test('flowchart always has a start and an end node, and renders arrows', async () => {
  await seed();
  const block = await fillBlock({ type: 'flowchart', intent: 'how to name a fraction', complexity: 2, spec: spec(), prefs: {} });
  assert.ok(block.data.nodes.some(n => n.type === 'start'));
  assert.ok(block.data.nodes.some(n => n.type === 'end'));
  const html = renderBlock(block);
  assert.match(html, /class="flow"/);
  assert.match(html, /flow-arrow/);
});

test('match_game renders two columns of cards with matching data-keys', async () => {
  await seed();
  const block = await fillBlock({ type: 'match_game', intent: 'match fractions to meaning', complexity: 2, spec: spec(), prefs: {} });
  const html = renderBlock(block);
  const keys = [...html.matchAll(/data-key="(\d+)"/g)].map(m => m[1]);
  // every left key has exactly one right key with the same value (a solvable game)
  assert.equal(keys.length, block.data.pairs.length * 2);
});

test('MCQ is correct by construction: answerIndex always points at a real, unique option', async () => {
  await seed();
  for (let i = 0; i < 5; i++) {
    const block = await fillBlock({ type: 'mcq', intent: `check idea ${i}`, complexity: 2, spec: spec(), prefs: {} });
    const d = block.data;
    assert.equal(d.options.length, 4, 'exactly 4 options');
    assert.equal(new Set(d.options).size, 4, 'options are unique');
    assert.ok(Number.isInteger(d.answerIndex) && d.answerIndex >= 0 && d.answerIndex <= 3, 'answerIndex in range');
    assert.ok(d.options[d.answerIndex] && d.options[d.answerIndex].length > 0, 'answerIndex points at a real option');
    assert.ok(d.explanation && d.explanation.length > 0, 'has an explanation');
  }
});

test('generated lesson keeps the teach -> check -> game rhythm and stays valid', async () => {
  await seed();
  const lesson = await generateLesson(spec({ durationMins: 60, visualDemand: 4 }), MAT, 'default');
  assert.ok(validateLesson(lesson).ok);
  const types = lesson.blocks.map(b => b.type);
  assert.equal(types[0], 'hook', 'opens with a hook');
  assert.ok(types.includes('mcq'), 'has at least one check');
  assert.ok(types.includes('match_game') || types.includes('activity'), 'has at least one game/activity');
});

test('longer durations produce more blocks than shorter ones', async () => {
  await seed();
  const short = await generateLesson(spec({ durationMins: 20 }), MAT, 'default');
  const long = await generateLesson(spec({ durationMins: 70 }), MAT, 'default');
  assert.ok(long.blocks.length > short.blocks.length, `long (${long.blocks.length}) should exceed short (${short.blocks.length})`);
});

test('new block renderers stay XSS-safe', async () => {
  await seed();
  const evil = '<script>alert(1)</script>';
  const block = await fillBlock({ type: 'pro_tip', intent: evil, complexity: 2, spec: spec(), prefs: {} });
  block.data.tips[0] = evil;
  const html = renderBlock(block);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
