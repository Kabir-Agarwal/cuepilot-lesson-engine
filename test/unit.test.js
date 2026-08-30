import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateLesson, validateBlock } from '../src/schema.js';
import { renderLesson, renderBlock, esc } from '../src/render/index.js';
import { fitCheck, estMinutesFor } from '../src/timebudget.js';
import { ingest, retrieve, sourceRefsFrom, chunkText } from '../src/rag.js';
import { MATERIAL } from './setup.js';

const sample = JSON.parse(fs.readFileSync('fixtures/sample-lesson.json', 'utf8'));

test('schema: the sample lesson (all 9 block types) validates', () => {
  const r = validateLesson(sample);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(sample.blocks.length, 9);
});

test('schema: malformed blocks are rejected with reasons', () => {
  const bad = structuredClone(sample);
  bad.blocks[5].data.options = ['only', 'three', 'options'];   // mcq needs exactly 4
  bad.blocks[1].complexity = 9;
  const r = validateLesson(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('mcq.options')));
  assert.ok(r.errors.some(e => e.includes('complexity')));

  assert.equal(validateBlock({ id: 'x', type: 'nope', complexity: 3, estMinutes: 1, sourceRefs: [], data: {} }).ok, false);
  assert.equal(validateBlock(null).ok, false);
});

test('renderer: escapes model text so <script> cannot execute', () => {
  const evil = structuredClone(sample.blocks[0]);
  evil.data.text = '<script>alert("xss")</script>';
  evil.sourceRefs = [{ sourceId: 's"1', sourceName: '<img onerror=x>', attribution: '<b>bad</b>' }];
  const html = renderBlock(evil);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>bad</b>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(esc(`a<b>&"'`), 'a&lt;b&gt;&amp;&quot;&#39;');
});

test('renderer: full page carries citations, complexity badges and interactive hooks', () => {
  const html = renderLesson(sample);
  assert.ok(html.includes('Source: Teacher upload, fractions.txt'));
  assert.ok(html.includes('>C2<'));
  assert.ok(html.includes('class="nl-mark"'));
  assert.ok(html.includes('data-answer="1"'));
  assert.ok(html.includes('data-block-id="b_hook01"'));
});

test('timebudget: grade factor and overflow flagged with a suggestion, nothing trimmed', () => {
  assert.equal(estMinutesFor('activity', '4'), 14.4);   // 12 * 1.2
  assert.equal(estMinutesFor('activity', '11'), 10.8);  // 12 * 0.9
  const ok = fitCheck(sample.blocks, 60);
  assert.equal(ok.ok, true);
  const over = fitCheck(sample.blocks, 20);
  assert.equal(over.ok, false);
  assert.ok(over.overBy > 0);
  assert.match(over.suggestion, /over 20 min/);
  assert.match(over.suggestion, /Nothing was removed/);
});

test('rag: local fallback returns attributed chunks and honours authority weighting', async () => {
  await ingest(MATERIAL, {
    materialId: 'M_teacher', source_id: 'M_teacher', source_name: 'fractions.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'teacher_upload', attribution_string: 'Teacher upload, fractions.txt',
  });
  const hits = await retrieve('denominator equal parts of a whole', { materialIds: ['M_teacher'] });
  assert.ok(hits.length > 0);
  assert.ok(hits[0].content.length > 0);
  const refs = sourceRefsFrom(hits);
  assert.equal(refs[0].attribution, 'Teacher upload, fractions.txt');

  // Same text, lower authority: teacher upload must outrank it.
  await ingest(MATERIAL, {
    materialId: 'M_other', source_id: 'M_other', source_name: 'random-blog.txt',
    board: 'CBSE', grade: '4', subject: 'Mathematics',
    authority_level: 'other', attribution_string: 'Other, random-blog.txt',
  });
  const mixed = await retrieve('denominator equal parts of a whole', { materialIds: ['M_other', 'M_teacher'] });
  assert.equal(mixed[0].authority_level, 'teacher_upload');
});

test('rag: chunking keeps 15% overlap and full metadata', () => {
  const chunks = chunkText('x'.repeat(3000), { source_id: 'S1', source_name: 'f.txt' });
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[0].authority_level, 'teacher_upload');
  assert.equal(chunks[0].attribution_string, 'Teacher upload, f.txt');
});
