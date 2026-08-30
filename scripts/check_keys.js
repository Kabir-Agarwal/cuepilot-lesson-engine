// Report-only key probe (never rewrites .env). Run: npm run checkkeys
// Gemini: ListModels -> pick model -> tiny generate. 503 = "key ok, model busy".
// Alchemyst: official SDK context.add + search; logs the FULL error body on 400.
import 'dotenv/config';
import { resolveModelChain } from '../src/llm.js';
import { errorBody } from '../src/rag.js';

const line = (label, msg) => console.log(`${label.padEnd(10)} ${msg}`);

async function probeModel(key, model) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }] }),
    });
    const ms = Date.now() - t0;
    if (res.status === 503) return { model, status: 'BUSY (503)', ms };
    if (res.status === 429) return { model, status: 'QUOTA/RATE (429)', ms };
    if (!res.ok) return { model, status: `FAIL http ${res.status}`, ms, body: (await res.text()).slice(0, 120) };
    return { model, status: 'PASS', ms };
  } catch (e) { return { model, status: `ERROR ${e.message}`, ms: Date.now() - t0 }; }
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return line('GEMINI', 'SKIP — key empty; runtime uses mock. Paste GEMINI_API_KEY in .env to enable.');

  const chain = await resolveModelChain();
  line('GEMINI', `model chain (ListModels): ${chain.join(' → ')}`);

  // Probe the FIRST TWO models so "one model busy" (chain healthy) vs "chain broken" is clear.
  const probes = [];
  for (const model of chain.slice(0, 2)) probes.push(await probeModel(key, model));
  for (const p of probes) line('GEMINI', `  ${p.model}: ${p.status} (${p.ms}ms)${p.body ? ' — ' + p.body : ''}`);

  if (probes.some(p => p.status === 'PASS')) line('GEMINI', 'VERDICT — key works; at least one chain model is live.');
  else if (probes.every(p => /BUSY|QUOTA|RATE/.test(p.status))) line('GEMINI', 'VERDICT — KEY OK, MODELS BUSY/LIMITED — runtime advances the chain then degrades to mock. Retry later.');
  else line('GEMINI', 'VERDICT — chain looks broken (auth/model errors above); check the key and model availability.');
}

async function checkAlchemyst() {
  const key = process.env.ALCHEMYST_AI_API_KEY;
  if (!key) return line('ALCHEMYST', 'SKIP — key empty; RAG uses local keyword fallback (fully functional).');

  let AlchemystAI;
  try { ({ AlchemystAI } = await import('@alchemystai/sdk')); }
  catch (e) { return line('ALCHEMYST', `SDK missing (${e.message}); run "npm i @alchemystai/sdk". Local fallback continues.`); }

  const c = new AlchemystAI({ apiKey: key });
  const probe = `check_keys probe ${process.pid}: the mitochondrion is the powerhouse of the cell`;
  try {
    await c.v1.context.add({
      documents: [{ content: probe }], context_type: 'resource', source: 'check_keys', scope: 'internal',
      metadata: { fileName: 'check_keys.txt', fileType: 'text/plain', fileSize: probe.length, lastModified: new Date().toISOString() },
    });
    line('ALCHEMYST', 'context.add PASS');
  } catch (e) { line('ALCHEMYST', `context.add FAIL — ${errorBody(e)}`); }

  try {
    const r = await c.v1.context.search({ query: 'powerhouse of the cell', minimum_similarity_threshold: 0.5, similarity_threshold: 0.5, scope: 'internal' });
    const n = (r?.contexts || r?.results || r?.data || []).length;
    line('ALCHEMYST', `context.search PASS — ${n} hit(s)`);
  } catch (e) { line('ALCHEMYST', `context.search FAIL — ${errorBody(e)}`); }

  // Informational: does the grant expose chat completions? (We only use context.add/search.)
  try {
    const base = process.env.ALCHEMYST_BASE_URL || 'https://platform-backend.getalchemystai.com/api/v1';
    const chat = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    });
    line('ALCHEMYST', `chat-completions: http ${chat.status} (informational — not used by the engine)`);
  } catch { line('ALCHEMYST', 'chat-completions: no response (informational)'); }
}

console.log('--- key check (report-only; .env is never modified) ---');
await checkGemini();
await checkAlchemyst();
console.log('------------------------------------------------------');
