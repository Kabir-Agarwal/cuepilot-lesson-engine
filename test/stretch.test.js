import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SPEC, MATERIAL } from './setup.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';
import { generateLesson, roadmap } from '../src/engine.js';
import { renderSlides } from '../src/render/slides.js';

const MAT = 'mat_stretch01';
async function seed() {
  const chunks = await ingest(MATERIAL, {
    materialId: MAT, source_id: MAT, source_name: 'fractions.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
  });
  save('materials', MAT, { id: MAT, materialId: MAT, name: 'fractions.txt', chunks });
}

test('slideshow: one slide per block, carries narration and stays XSS-safe', async () => {
  await seed();
  const lesson = await generateLesson(SPEC, MAT, 'default');
  const html = renderSlides(lesson);
  assert.equal((html.match(/class="slide"/g) || []).length, lesson.blocks.length);
  assert.match(html, /speechSynthesis/);
  assert.match(html, /data-narration=/);
  assert.ok(!html.includes('<script>alert'));
});

test('roadmap: returns exactly nLessons ordered entries', async () => {
  await seed();
  const rm = await roadmap({ ...SPEC, nLessons: 3 }, MAT, 'default');
  assert.equal(rm.lessons.length, 3);
  assert.deepEqual(rm.lessons.map(l => l.lessonIndex), [1, 2, 3]);
  assert.ok(rm.lessons.every(l => l.title && l.focus));
});
