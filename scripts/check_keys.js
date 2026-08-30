// Probes the two external services. Empty key => SKIP (never blocks). Gemini FAIL => flips
// .env to LLM_PROVIDER=mock so the demo still works. Run: npm run checkkeys
import 'dotenv/config';
import fs from 'node:fs';

const line = (label, msg) => console.log(`${label.padEnd(10)} ${msg}`);

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return line('GEMINI', 'SKIP — key empty; runtime uses mock. Paste GEMINI_API_KEY in .env to enable.');
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const t0 = Date.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }] }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) { forceMock(); return line('GEMINI', `FAIL — http ${res.status} (${(await res.text()).slice(0, 120)}). Set LLM_PROVIDER=mock in .env (done).`); }
    const j = await res.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    line('GEMINI', `PASS — model ${model}, ${ms}ms, replied: ${text.trim().slice(0, 40)}`);
  } catch (e) { forceMock(); line('GEMINI', `FAIL — ${e.message}. Set LLM_PROVIDER=mock in .env (done).`); }
}

function forceMock() {
  try {
    if (!fs.existsSync('.env')) return;
    const env = fs.readFileSync('.env', 'utf8');
    fs.writeFileSync('.env', env.replace(/^LLM_PROVIDER=.*$/m, 'LLM_PROVIDER=mock'));
  } catch { /* ignore */ }
}

async function checkAlchemyst() {
  const key = process.env.ALCHEMYST_AI_API_KEY;
  if (!key) return line('ALCHEMYST', 'SKIP — key empty; RAG uses local keyword fallback (fully functional).');
  const base = process.env.ALCHEMYST_BASE_URL || 'https://platform-backend.getalchemystai.com/api/v1';
  const probe = `check_keys probe ${Date.now()}: the mitochondrion is the powerhouse of the cell`;
  try {
    const add = await fetch(`${base}/context/add`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ documents: [{ content: probe }], source: 'check_keys', context_type: 'resource', scope: 'internal' }),
    });
    line('ALCHEMYST', add.ok ? 'context.add PASS' : `context.add FAIL — http ${add.status}; local fallback continues.`);
    const search = await fetch(`${base}/context/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: 'powerhouse of the cell', minimum_similarity_score: 0.5, scope: 'internal' }),
    });
    line('ALCHEMYST', search.ok ? 'context.search PASS' : `context.search FAIL — http ${search.status}; local fallback continues.`);
    // Informational: does this grant expose chat-completions?
    const chat = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    }).catch(() => null);
    line('ALCHEMYST', chat ? `chat-completions: http ${chat.status} (informational — we only use context.add/search)` : 'chat-completions: no response (informational)');
  } catch (e) { line('ALCHEMYST', `error — ${e.message}; local fallback continues.`); }
}

console.log('--- key check ---');
await checkGemini();
await checkAlchemyst();
console.log('-----------------');
