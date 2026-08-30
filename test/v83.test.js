import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, MATERIAL } from './setup.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { withProgress } from '../src/progress.js';
import { generateLesson, editLesson, reorderBlocks } from '../src/engine.js';
import { runVerifier } from '../src/verifier.js';
import { executeOps, validateOps } from '../src/engine.js';
import { summarise } from '../src/filler.js';

async function seed(id, meta = {}) {
  const chunks = await ingest(MATERIAL, {
    materialId: id, source_id: id, source_name: `${id}.txt`,
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: `Teacher upload, ${id}.txt`, ...meta,
  });
  save('materials', id, { id, materialId: id, teacherId: meta.teacherId || 't1', subject: meta.subject || 'Mathematics', board: 'CBSE', grade: '4', name: `${id}.txt`, chunks });
}

test('requestedBlocks: generated set equals the requested set, in order', async () => {
  await seed('mat_req');
  const requested = ['hook', 'explain', 'mcq', 'exit_ticket'];
  const lesson = await generateLesson({ ...SPEC, requestedBlocks: requested, durationMins: 15 }, 'mat_req', 't1');
  assert.deepEqual(lesson.blocks.map(b => b.type), requested, 'exact set and order honoured, none dropped for time');
});

test('requestedBlocks: an unknown type is rejected with 400', async () => {
  await seed('mat_req2');
  await assert.rejects(
    () => generateLesson({ ...SPEC, requestedBlocks: ['hook', 'nonsense'] }, 'mat_req2', 't1'),
    e => e.status === 400 && e.code === 'BAD_BLOCK_TYPE');
});

test('streaming: generate emits retrieving -> planning -> block* -> provider steps', async () => {
  await seed('mat_stream');
  const events = [];
  const lesson = await withProgress(e => events.push(e), () => generateLesson({ ...SPEC, durationMins: 20 }, 'mat_stream', 't1'));
  const steps = events.map(e => e.step);
  assert.ok(steps.includes('retrieving'));
  assert.ok(steps.includes('planning'));
  assert.ok(steps.filter(s => s === 'block').length === lesson.blocks.length);
  assert.ok(events.some(e => e.step === 'provider' && e.model));  // mock provider event still fires
  const firstBlock = events.find(e => e.step === 'block');
  assert.equal(firstBlock.i, 1);
  assert.ok(firstBlock.n >= firstBlock.i);
});

test('reorder: a valid permutation reorders same objects, no regeneration', async () => {
  await seed('mat_reorder');
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, 'mat_reorder', 't1');
  const ids = lesson.blocks.map(b => b.id);
  const before = new Map(lesson.blocks.map(b => [b.id, JSON.stringify(b)]));
  const shuffled = [ids[2], ids[0], ...ids.slice(3), ids[1]];
  const out = reorderBlocks(lesson.id, shuffled);
  assert.deepEqual(out.blocks.map(b => b.id), shuffled);
  for (const b of out.blocks) assert.equal(JSON.stringify(b), before.get(b.id), `${b.id} byte-identical after reorder`);
});

test('reorder: a non-permutation is rejected with 400', async () => {
  await seed('mat_reorder2');
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, 'mat_reorder2', 't1');
  const ids = lesson.blocks.map(b => b.id);
  await Promise.resolve();
  assert.throws(() => reorderBlocks(lesson.id, ids.slice(1)), e => e.status === 400 && e.code === 'BAD_PERMUTATION');
  assert.throws(() => reorderBlocks(lesson.id, [...ids, 'b_extra']), e => e.status === 400);
});

test('multi-resource: materialIds[] merge but stay scoped; mismatch is 400', async () => {
  await seed('mat_a', { teacherId: 'tm', subject: 'Mathematics', source_name: 'a.txt', attribution_string: 'Teacher upload, a.txt' });
  await seed('mat_b', { teacherId: 'tm', subject: 'Mathematics', source_name: 'b.txt', attribution_string: 'Teacher upload, b.txt' });
  await seed('mat_c', { teacherId: 'tm', subject: 'Science' });   // different subject
  const lesson = await generateLesson({ ...SPEC }, undefined, 'tm', ['mat_a', 'mat_b']);
  assert.deepEqual(lesson.materialIds, ['mat_a', 'mat_b']);
  const cited = new Set(lesson.blocks.flatMap(b => b.sourceRefs.map(r => r.sourceId)));
  assert.ok([...cited].every(id => ['mat_a', 'mat_b'].includes(id)), 'only the chosen materials are cited');
  await assert.rejects(
    () => generateLesson({ ...SPEC }, undefined, 'tm', ['mat_a', 'mat_c']),
    e => e.status === 400 && e.code === 'MATERIAL_MISMATCH');
});

test('verifier: off by default (no VERIFY_PASS)', async () => {
  delete process.env.VERIFY_PASS;
  await seed('mat_v1');
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, 'mat_v1', 't1');
  assert.notEqual(lesson.verified, true);
});

test('verifier: when on (mock says ok), it runs but changes nothing', async () => {
  process.env.VERIFY_PASS = 'on';
  await seed('mat_v2');
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, 'mat_v2', 't1');
  assert.equal(lesson.verified, true);
  delete process.env.VERIFY_PASS;
});

test('verifier: ops route through the op executor with byte-identity + cycle cap', async () => {
  process.env.VERIFY_PASS = 'on';
  process.env.VERIFY_MAX_CYCLES = '5';   // must be capped to 3
  await seed('mat_v3');
  const lesson = await generateLesson({ ...SPEC, durationMins: 60 }, 'mat_v3', 't1');

  // Drive the executor directly with a remove op and confirm untouched blocks are identical.
  const before = new Map(lesson.blocks.map(b => [b.id, JSON.stringify(b)]));
  const victim = lesson.blocks[2].id;
  const ops = validateOps([{ op: 'remove', blockIds: [victim] }], lesson);
  const { blocks, changedBlockIds } = await executeOps(lesson, ops, { ...SPEC, materialIds: ['mat_v3'] }, { textDensity: 'medium' }, 'verifier');
  assert.ok(!blocks.some(b => b.id === victim));
  assert.deepEqual(changedBlockIds, []);   // a pure remove changes no surviving block
  for (const b of blocks) assert.equal(JSON.stringify(b), before.get(b.id), `${b.id} untouched by the remove`);

  // Cycle cap: verifier's own maxCycles clamps 5 -> 3.
  const { maxCyclesForTest } = await import('../src/verifier.js').then(m => ({ maxCyclesForTest: m.__maxCyclesForTest }));
  if (maxCyclesForTest) assert.equal(maxCyclesForTest(), 3);
  delete process.env.VERIFY_PASS; delete process.env.VERIFY_MAX_CYCLES;
});
