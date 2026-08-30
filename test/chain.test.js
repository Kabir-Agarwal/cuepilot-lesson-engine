import './setup.js';   // sets DATA_DIR; we override provider below for these tests
process.env.LLM_BACKOFF_MS = '5';   // shrink retry backoff so the stubbed chain tests run fast
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeJSON, getLastChainAttempts, getDeadModels,
  __setModelChain, __setGeminiCaller, __resetChainState,
} from '../src/llm.js';

// Force the live-provider path (stubbed caller = no network).
function useGemini() {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'stub-key-not-real';
  __setModelChain(['model-A', 'model-B', 'model-C']);
  __resetChainState();
}
function reset() {
  __setGeminiCaller(null);
  __resetChainState();
  process.env.LLM_PROVIDER = 'mock';
  delete process.env.GEMINI_API_KEY;
}
const err = status => Object.assign(new Error(`gemini ${status}: simulated`), { status });

test('(a) model A always 503 → the call is served by model B; both names logged', async () => {
  useGemini();
  const calls = [];
  __setGeminiCaller(async (_sys, _p, model) => {
    calls.push(model);
    if (model === 'model-A') throw err(503);
    return JSON.stringify({ answeredBy: model });
  });
  const out = await completeJSON({ prompt: 'x', mock: { answeredBy: 'mock' } });
  assert.equal(out.answeredBy, 'model-B', 'model B served the call, not mock');
  const attempts = getLastChainAttempts();
  assert.equal(attempts.find(a => a.model === 'model-A').result, '503');
  assert.equal(attempts.find(a => a.model === 'model-B').result, 'ok');
  assert.ok(calls.includes('model-A') && calls.includes('model-B'), 'both models actually called');
  reset();
});

test('(b) model A 429-quota → A marked dead & skipped next call; B used; NO global mock', async () => {
  useGemini();
  const calls = [];
  __setGeminiCaller(async (_sys, _p, model) => {
    calls.push(model);
    if (model === 'model-A') throw err(429);   // status 429 + "quota" in message
    return JSON.stringify({ answeredBy: model });
  });
  // message must name quota for isQuotaError
  __setGeminiCaller(async (_sys, _p, model) => {
    calls.push(model);
    if (model === 'model-A') throw Object.assign(new Error('gemini 429: exceeded your current quota'), { status: 429 });
    return JSON.stringify({ answeredBy: model });
  });

  const first = await completeJSON({ prompt: 'x', mock: { answeredBy: 'mock' } });
  assert.equal(first.answeredBy, 'model-B', 'B answered, not a global mock');
  assert.ok(getDeadModels().includes('model-A'), 'A marked dead for the process');

  calls.length = 0;
  const second = await completeJSON({ prompt: 'y', mock: { answeredBy: 'mock' } });
  assert.equal(second.answeredBy, 'model-B');
  assert.ok(!calls.includes('model-A'), 'dead model A not called again');
  assert.equal(getLastChainAttempts().find(a => a.model === 'model-A').result, 'skipped-dead');
  reset();
});

test('(c) all models failing → mock served, with a per-model failure summary', async () => {
  useGemini();
  __setGeminiCaller(async (_sys, _p, model) => { throw err(503); });
  const out = await completeJSON({ prompt: 'x', mock: { answeredBy: 'mock' } });
  assert.equal(out.answeredBy, 'mock', 'falls back to mock only after the whole chain fails');
  const attempts = getLastChainAttempts();
  assert.deepEqual(attempts.map(a => a.model), ['model-A', 'model-B', 'model-C']);
  assert.ok(attempts.every(a => a.result === '503'), 'every model recorded as failed');
  reset();
});

test('chain advances through EVERY model in order (retries per model, then next)', async () => {
  useGemini();
  const order = [];
  __setGeminiCaller(async (_sys, _p, model) => { order.push(model); throw err(503); });
  await completeJSON({ prompt: 'x', mock: { ok: true } });
  // Distinct models, first-seen order — each is retried (2x) before the chain moves on.
  const distinct = order.filter((m, i) => order.indexOf(m) === i);
  assert.deepEqual(distinct, ['model-A', 'model-B', 'model-C'], 'chain reached every model, in order');
  assert.equal(order.filter(m => m === 'model-A').length, 3, 'model A retried (1 + 2 retries) before advancing');
  reset();
});
