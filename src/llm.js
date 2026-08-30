// Single LLM door. Sequential calls with a 500ms gap, 429/5xx backoff x3,
// one JSON repair-retry, and a mock provider so the whole app runs with no network.
import 'dotenv/config';

const GAP_MS = 500;
const MAX_RETRIES = 3;

let lastPrompt = null;
let lastRaw = null;
let queue = Promise.resolve();   // serialises every provider call
let lastCallAt = 0;
export const stats = { calls: 0, promptChars: 0, completionChars: 0, ms: 0 };

export const getLastPrompt = () => lastPrompt;
export const getLastRaw = () => lastRaw;

export function provider() {
  const p = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
  if (p === 'gemini' && !process.env.GEMINI_API_KEY) return 'mock';
  if (p === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return 'mock';
  return ['mock', 'gemini', 'anthropic'].includes(p) ? p : 'mock';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Pull the first JSON value out of a model response (fences, prose, whatever). */
export function extractJSON(text) {
  if (typeof text !== 'string') throw new Error('no text to parse');
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model output');
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in model output');
}

async function callGemini(system, prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
}

async function callAnthropic(system, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return j.content?.map(c => c.text || '').join('') ?? '';
}

async function callWithBackoff(system, prompt) {
  const fn = provider() === 'anthropic' ? callAnthropic : callGemini;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(system, prompt);
    } catch (e) {
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'TypeError';
      if (!retryable || attempt >= MAX_RETRIES - 1) throw e;
      const wait = 1000 * 2 ** attempt;
      console.warn(`[llm] ${e.message} — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * completeJSON({system, prompt, mock}) -> parsed JSON.
 * `mock` is the canned, valid output used when LLM_PROVIDER=mock (or the key is missing).
 */
export function completeJSON({ system = 'You are a helpful curriculum assistant.', prompt, mock }) {
  const run = async () => {
    lastPrompt = `${system}\n\n${prompt}`;
    stats.calls++;
    stats.promptChars += lastPrompt.length;

    if (provider() === 'mock') {
      lastRaw = JSON.stringify(mock ?? null);
      stats.completionChars += lastRaw.length;
      return structuredClone(mock ?? null);
    }

    const since = Date.now() - lastCallAt;
    if (since < GAP_MS) await sleep(GAP_MS - since);

    const t0 = Date.now();
    let raw = await callWithBackoff(system, prompt);
    lastCallAt = Date.now();
    lastRaw = raw;
    try {
      const out = extractJSON(raw);
      stats.completionChars += raw.length;
      stats.ms += Date.now() - t0;
      return out;
    } catch {
      // one repair-retry
      await sleep(GAP_MS);
      raw = await callWithBackoff(system, `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON value, no prose, no code fences.`);
      lastCallAt = Date.now();
      lastRaw = raw;
      stats.completionChars += raw.length;
      stats.ms += Date.now() - t0;
      return extractJSON(raw);
    }
  };
  // ponytail: one global chain = strictly sequential calls. Per-key queues if we ever go multi-tenant.
  const next = queue.then(run, run);
  queue = next.then(() => {}, () => {});
  return next;
}
