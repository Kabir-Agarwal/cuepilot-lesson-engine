import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';

let base;
const server = app.listen(0);
await new Promise(r => server.once('listening', r));
base = `http://localhost:${server.address().port}`;
test.after(() => server.close());

async function post(path, body, isForm) {
  const opts = { method: 'POST' };
  if (isForm) opts.body = body;
  else { opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(body); }
  const res = await fetch(base + path, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('POST /generate without materialId -> 400 MATERIAL_REQUIRED', async () => {
  const r = await post('/generate', { spec: { topic: 'Fractions' }, teacherId: 'default' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'MATERIAL_REQUIRED');
});

test('CORS: preflight OPTIONS returns 204 with allow-origin/methods/headers', async () => {
  const res = await fetch(base + '/generate', {
    method: 'OPTIONS',
    headers: {
      origin: 'http://other-laptop.local:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://other-laptop.local:5173');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers').toLowerCase(), /content-type/);
});

test('CORS: an actual cross-origin GET carries the allow-origin header', async () => {
  const res = await fetch(base + '/lessons', { headers: { origin: 'http://other-laptop.local:5173' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://other-laptop.local:5173');
  assert.match(res.headers.get('vary') || '', /Origin/);
});

test('POST /ingest without subject/teacherId -> 400', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['some fractions text about equal parts'], { type: 'text/plain' }), 'm.txt');
  fd.append('board', 'CBSE');
  fd.append('grade', '4');           // teacherId and subject deliberately omitted
  const r = await post('/ingest', fd, true);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /teacherId/);
  assert.match(r.json.error, /subject/);
});

test('POST /ingest with full metadata -> materialId, then it appears in /materials', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['Fractions: a whole split into equal parts. Numerator over denominator.'], { type: 'text/plain' }), 'frac.txt');
  fd.append('teacherId', 'srv-teacher');
  fd.append('subject', 'Mathematics');
  fd.append('board', 'CBSE');
  fd.append('grade', '4');
  const up = await post('/ingest', fd, true);
  assert.equal(up.status, 200);
  assert.match(up.json.materialId, /^mat_/);

  const res = await fetch(base + '/materials?teacherId=srv-teacher');
  const { materials } = await res.json();
  assert.ok(materials.some(m => m.id === up.json.materialId && m.filename === 'frac.txt'));
});
