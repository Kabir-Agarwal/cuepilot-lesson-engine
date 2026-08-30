import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, MATERIAL } from './setup.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { validateLesson } from '../src/schema.js';
import { getLastPrompt } from '../src/llm.js';
import { generateLesson, editBlock, editLesson, duplicateLesson } from '../src/engine.js';

const MAT = 'mat_test01';

async function seedMaterial() {
  const chunks = await ingest(MATERIAL, {
    materialId: MAT, source_id: MAT, source_name: 'fractions.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
  });
  save('materials', MAT, { materialId: MAT, name: 'fractions.txt', chars: MATERIAL.length, chunks });
}

test('generate: mock provider produces a valid, deterministic, cited lesson', async () => {
  await seedMaterial();
  const a = await generateLesson(SPEC, MAT, 'default');
  const b = await generateLesson(SPEC, MAT, 'default');

  assert.equal(validateLesson(a).ok, true, validateLesson(a).errors.join('; '));
  assert.ok(a.blocks.length >= 5);
  assert.equal(a.blocks[0].type, 'hook');
  assert.ok(a.blocks.every(bl => bl.sourceRefs.length > 0), 'every block is cited');
  assert.ok(a.timeFit.plannedMins > 0);

  // deterministic apart from generated ids
  const strip = l => JSON.stringify(l.blocks.map(({ id, ...rest }) => rest));
  assert.equal(strip(a), strip(b));
});

test('generate: without a materialId is refused with 400 MATERIAL_REQUIRED', async () => {
  await assert.rejects(
    () => generateLesson(SPEC, undefined, 'default'),
    e => e.status === 400 && e.code === 'MATERIAL_REQUIRED');
  await assert.rejects(
    () => generateLesson(SPEC, 'mat_ghost', 'default'),
    e => e.status === 400 && e.code === 'MATERIAL_REQUIRED');
});

test('rag scoping: a lesson built from material A never cites material B', async () => {
  const { ingest } = await import('../src/rag.js');
  const A = 'mat_scopeA', B = 'mat_scopeB';
  const chunksA = await ingest('Photosynthesis lets plants make food from sunlight and water in the leaf.', {
    materialId: A, source_id: A, source_name: 'bio.txt', board: 'CBSE', grade: '4', subject: 'Science',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, bio.txt',
  });
  const chunksB = await ingest('Fractions break a whole into equal parts with a numerator and denominator.', {
    materialId: B, source_id: B, source_name: 'frac.txt', board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, frac.txt',
  });
  save('materials', A, { id: A, materialId: A, name: 'bio.txt', chunks: chunksA });
  save('materials', B, { id: B, materialId: B, name: 'frac.txt', chunks: chunksB });

  const lesson = await generateLesson({ ...SPEC, subject: 'Science', topic: 'Photosynthesis' }, A, 'default');
  const cited = new Set(lesson.blocks.flatMap(b => b.sourceRefs.map(r => r.sourceId)));
  assert.ok(cited.has(A) || cited.size === 0);
  assert.ok(!cited.has(B), 'material B must never be cited in a material-A lesson');
});

test('generate: the complexity directive reaches the model prompt', async () => {
  await seedMaterial();
  await generateLesson({ ...SPEC, defaultComplexity: 5 }, MAT, 'default');
  const p = getLastPrompt();
  assert.match(p, /COMPLEXITY 5\/5/);
  assert.match(p, /advanced: abstraction, edge cases/);
  assert.match(p, /TEACHER PREFERENCES/);
});

test('editBlock: only the targeted block changes, siblings stay byte-identical', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const before = lesson.blocks.map(b => JSON.stringify(b));
  const target = lesson.blocks[1];

  const { block, timeFit } = await editBlock(lesson.id, target.id, { instruction: 'use a cricket example instead' });

  assert.equal(block.id, target.id, 'block id is preserved');
  assert.equal(block.type, target.type, 'block type is preserved');
  assert.notEqual(JSON.stringify(block), before[1], 'the targeted block did change');
  assert.ok(timeFit.plannedMins > 0);

  const { default: fs } = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(`${process.env.DATA_DIR}/lessons/${lesson.id}.json`, 'utf8'));
  saved.blocks.forEach((b, i) => {
    if (i === 1) return;
    assert.equal(JSON.stringify(b), before[i], `sibling ${i} (${b.id}) must be byte-identical`);
  });
});

test('editBlock: the slider alone re-levels a block and is reflected in the prompt', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const target = lesson.blocks[1];
  const { block } = await editBlock(lesson.id, target.id, { complexity: 5 });
  assert.equal(block.complexity, 5);
  assert.match(getLastPrompt(), /COMPLEXITY 5\/5/);
  await assert.rejects(() => editBlock(lesson.id, target.id, {}), /at least one/);
});

test('editLesson: add-at-end + remove leave every unnamed block byte-identical', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const before = new Map(lesson.blocks.map(b => [b.id, JSON.stringify(b)]));
  const doomed = [lesson.blocks[2].id, lesson.blocks[3].id];

  const out = await editLesson(lesson.id, `remove ${doomed.join(' and ')} and add an assessment at the end`);

  assert.ok(out.ops.some(o => o.op === 'remove'));
  assert.ok(out.ops.some(o => o.op === 'add'));
  for (const id of doomed) assert.ok(!out.lesson.blocks.some(b => b.id === id), `${id} was removed`);

  const added = out.lesson.blocks.at(-1);
  assert.ok(!before.has(added.id), 'a new block was appended at the end');
  assert.equal(added.type, 'mcq');
  assert.deepEqual(out.changedBlockIds, [added.id]);

  for (const b of out.lesson.blocks) {
    if (b.id === added.id) continue;
    assert.equal(JSON.stringify(b), before.get(b.id), `untouched block ${b.id} must be byte-identical`);
  }
  assert.equal(validateLesson(out.lesson).ok, true);
});

test('editLesson: removing one block by id never removes extra blocks (hex-digit ordinal trap)', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const n = lesson.blocks.length;
  const victim = lesson.blocks[2].id;   // ids contain hex digits that must NOT be read as ordinals
  const out = await editLesson(lesson.id, `remove ${victim}`);
  assert.equal(out.lesson.blocks.length, n - 1, 'exactly one block removed');
  assert.ok(!out.lesson.blocks.some(b => b.id === victim));
  assert.equal(out.lesson.blocks[0].type, 'hook', 'the hook was not collaterally removed');
});

test('editLesson: a global re-grade regenerates every block and re-runs fitCheck', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const ids = lesson.blocks.map(b => b.id);
  const out = await editLesson(lesson.id, 'make this suitable for Grade 2');
  assert.deepEqual(out.changedBlockIds.sort(), ids.sort());
  assert.equal(out.lesson.blocks.length, ids.length, 'no block was added or dropped');
  assert.ok('plannedMins' in out.timeFit);
});

test('editLesson: an unusable instruction changes nothing', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const before = JSON.stringify(lesson.blocks);
  const out = await editLesson(lesson.id, 'remove block b_does_not_exist');
  assert.deepEqual(out.changedBlockIds, []);
  assert.equal(JSON.stringify(out.lesson.blocks), before);
});

test('duplicate: copies the lesson with fresh ids and leaves the original alone', async () => {
  await seedMaterial();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const copy = duplicateLesson(lesson.id);
  assert.notEqual(copy.id, lesson.id);
  assert.match(copy.title, /\(copy\)$/);
  assert.equal(copy.blocks.length, lesson.blocks.length);
  assert.ok(copy.blocks.every((b, i) => b.id !== lesson.blocks[i].id));
  assert.equal(JSON.stringify(copy.blocks.map(b => b.data)), JSON.stringify(lesson.blocks.map(b => b.data)));
});
