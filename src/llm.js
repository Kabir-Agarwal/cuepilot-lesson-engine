// Single LLM door. Sequential calls with a 500ms gap, 429/5xx backoff x3,
// one JSON repair-retry, and a mock provider so the whole app runs with no network.
import 'dotenv/config';
import { emitStep } from './progress.js';

const GAP_MS = 500;
const MAX_RETRIES = 3;

// Preferred Gemini models, best first. The real list is discovered via ListModels;
// this only sets the ORDER — nothing here is hardcoded as "the" model.
const MODEL_PREF = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
let modelChain = null;   // resolved [chosen, ...fallbacks], cached per process

// Models this PROCESS has proven dead (per-model quota 429). Gemini quotas are PER MODEL,
// so a dead model is skipped on later calls but the rest of the chain is still tried.
const deadModels = new Set();
export const getDeadModels = () => [...deadModels];

// Cross-call tally of every model's outcomes (for realrun's end-of-run summary).
const chainTally = new Map();   // model -> { attempted, ok, '503', '429-quota', 'skipped-dead', other }
const tally = (model, key) => {
  const t = chainTally.get(model) || { attempted: 0, ok: 0, '503': 0, '429-quota': 0, 'skipped-dead': 0, other: 0 };
  if (key !== 'skipped-dead') t.attempted++;
  t[key] = (t[key] || 0) + 1;
  chainTally.set(model, t);
};
export const getChainTally = () => Object.fromEntries(chainTally);
export const __resetChainState = () => { deadModels.clear(); chainTally.clear(); };   // test hook

// The raw single-model caller, injectable so tests can drive the chain with no network.
let geminiCaller = callGemini;
export const __setGeminiCaller = fn => { geminiCaller = fn || callGemini; };

function rankFlash(names) {
  // Newest flash last-resort: sort by the version number embedded in the name, desc.
  const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)-flash/); return m ? parseFloat(m[1]) : 0; };
  return names.filter(n => /flash/.test(n) && !/(tts|image|omni|preview)/.test(n)).sort((a, b) => ver(b) - ver(a));
}

/** Discover available generateContent models and order them by preference. Cached. */
export async function resolveModelChain() {
  if (modelChain) return modelChain;
  if (process.env.GEMINI_MODEL) { modelChain = [process.env.GEMINI_MODEL]; return modelChain; }
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    if (!res.ok) throw new Error(`ListModels ${res.status}`);
    const j = await res.json();
    const avail = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''));
    const ordered = [];
    for (const p of MODEL_PREF) if (avail.includes(p) && !ordered.includes(p)) ordered.push(p);
    for (const n of rankFlash(avail)) if (!ordered.includes(n)) ordered.push(n);
    modelChain = ordered.length ? ordered : MODEL_PREF;
  } catch (e) {
    console.warn('[llm] ListModels failed, using preference defaults:', e.message);
    modelChain = MODEL_PREF;
  }
  console.log('[llm] Gemini model chain:', modelChain.join(' → '));
  return modelChain;
}

export const getModelChain = () => modelChain;
export const __setModelChain = chain => { modelChain = chain; };   // test hook (skips ListModels)

let lastPrompt = null;
let lastRaw = null;
let queue = Promise.resolve();   // serialises every provider call
let lastCallAt = 0;
export const stats = { calls: 0, promptChars: 0, completionChars: 0, ms: 0, live: 0, mock: 0 };

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

async function callGemini(system, prompt, model) {
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

// A 429 that names a quota is a PER-MODEL daily/rate limit (Gemini quotas are per model).
// It is not retryable and marks that model dead for this process — but the chain continues.
const isQuotaError = e => e.status === 429 && /quota|exceeded|rate/i.test(e.message || '');

// Try ONE model with backoff (2 retries: 1s, 2s). Quota 429 throws immediately (marked dead by caller).
async function callOneModel(model, system, prompt) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await geminiCaller(system, prompt, model);
    } catch (e) {
      if (isQuotaError(e)) throw e;   // don't retry a quota limit
      const retryable = (e.status >= 500 && e.status < 600) || e.status === 429 || e.name === 'TypeError';
      if (!retryable || attempt >= MAX_RETRIES - 1) throw e;
      const wait = (Number(process.env.LLM_BACKOFF_MS) || 1000) * 2 ** attempt;
      console.warn(`[llm] ${model} failed (${e.status || e.message}) — retry ${attempt + 1}/${MAX_RETRIES - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Walk the model chain explicitly by index. For each live (non-dead) model: try it; on success
 * return and emit which model answered. On quota 429 → mark that model dead and CONTINUE. On any
 * other failure → CONTINUE to the next model. Only when EVERY model is dead/failed do we throw
 * (→ completeJSON serves mock). Returns {text, attempts:[{model, result}]}.
 */
async function callGeminiChain(system, prompt) {
  const chain = await resolveModelChain();
  const attempts = [];
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];                 // the model this iteration actually calls
    if (deadModels.has(model)) { attempts.push({ model, result: 'skipped-dead' }); tally(model, 'skipped-dead'); continue; }
    try {
      const text = await callOneModel(model, system, prompt);
      attempts.push({ model, result: 'ok' }); tally(model, 'ok');
      emitStep({ step: 'provider', provider: 'gemini', model });
      return { text, attempts };
    } catch (e) {
      lastErr = e;
      if (isQuotaError(e)) {
        deadModels.add(model);              // per-model, NOT global
        attempts.push({ model, result: '429-quota (marked dead)' }); tally(model, '429-quota');
        console.warn(`[llm] ${model} quota-limited (429) — marked dead for this process, advancing to next model`);
      } else {
        const key = e.status === 503 ? '503' : 'other';
        attempts.push({ model, result: `${e.status || e.name || 'error'}` }); tally(model, key);
        console.warn(`[llm] ${model} failed (${e.status || e.message}) — advancing to next model`);
      }
    }
  }
  const summary = attempts.map(a => `${a.model}=${a.result}`).join(', ');
  console.warn(`[llm] all Gemini models exhausted (${summary}) — serving mock`);
  throw Object.assign(lastErr || new Error('all Gemini models failed'), { chainAttempts: attempts });
}

let lastChainAttempts = [];   // per-model outcomes of the most recent chain walk (for realrun)
export const getLastChainAttempts = () => lastChainAttempts;

async function callWithBackoff(system, prompt) {
  if (provider() === 'anthropic') {
    const out = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await callAnthropic(system, prompt); }
        catch (e) {
          const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'TypeError';
          if (!retryable || attempt >= MAX_RETRIES - 1) throw e;
          await sleep(1000 * 2 ** attempt);
        }
      }
    })();
    lastChainAttempts = [{ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', result: 'ok' }];
    emitStep({ step: 'provider', provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5' });
    return out;
  }
  try {
    const { text, attempts } = await callGeminiChain(system, prompt);
    lastChainAttempts = attempts;
    return text;
  } catch (e) {
    lastChainAttempts = e.chainAttempts || [];
    throw e;
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
      emitStep({ step: 'provider', provider: 'mock', model: 'mock' });
      stats.mock++;
      lastRaw = JSON.stringify(mock ?? null);
      stats.completionChars += lastRaw.length;
      return structuredClone(mock ?? null);
    }

    const since = Date.now() - lastCallAt;
    if (since < GAP_MS) await sleep(GAP_MS - since);

    const t0 = Date.now();
    try {
      let raw = await callWithBackoff(system, prompt);
      lastCallAt = Date.now();
      lastRaw = raw;
      try {
        const out = extractJSON(raw);
        stats.completionChars += raw.length;
        stats.ms += Date.now() - t0;
        stats.live++;
        return out;
      } catch {
        // one repair-retry
        await sleep(GAP_MS);
        raw = await callWithBackoff(system, `${prompt}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON value, no prose, no code fences.`);
        lastCallAt = Date.now();
        lastRaw = raw;
        stats.completionChars += raw.length;
        stats.ms += Date.now() - t0;
        stats.live++;
        return extractJSON(raw);
      }
    } catch (e) {
      // Last rung of the chain: every model failed (429/503/etc). Serve the mock so a
      // demo never dies mid-generation; the provider event shows it was the fallback.
      console.warn(`[llm] all providers failed (${e.status || e.message}) — serving mock for this call`);
      emitStep({ step: 'provider', provider: 'mock', model: 'mock', reason: String(e.status || e.message) });
      stats.mock++;
      lastRaw = JSON.stringify(mock ?? null);
      stats.completionChars += lastRaw.length;
      return structuredClone(mock ?? null);
    }
  };
  // ponytail: one global chain = strictly sequential calls. Per-key queues if we ever go multi-tenant.
  const next = queue.then(run, run);
  queue = next.then(() => {}, () => {});
  return next;
}
