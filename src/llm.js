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

async function callModelWithBackoff(model, system, prompt) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callGemini(system, prompt, model);
    } catch (e) {
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'TypeError';
      if (!retryable || attempt >= MAX_RETRIES - 1) throw e;
      const wait = 1000 * 2 ** attempt;
      console.warn(`[llm] ${model} ${e.message} — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Gemini call across the model chain: try chosen model (backoff x3) → on failure try the
 * next model in the chain once each → the last error propagates. Emits which model answered.
 */
async function callGeminiChain(system, prompt) {
  const chain = await resolveModelChain();
  let lastErr;
  for (const model of chain) {
    try {
      const out = await callModelWithBackoff(model, system, prompt);
      emitStep({ step: 'provider', provider: 'gemini', model });
      return out;
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] model ${model} failed (${e.status || e.message}) — trying next in chain`);
    }
  }
  throw lastErr || new Error('all Gemini models failed');
}

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
    emitStep({ step: 'provider', provider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5' });
    return out;
  }
  return callGeminiChain(system, prompt);
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
    } catch (e) {
      // Last rung of the chain: every model failed (429/503/etc). Serve the mock so a
      // demo never dies mid-generation; the provider event shows it was the fallback.
      console.warn(`[llm] all providers failed (${e.status || e.message}) — serving mock for this call`);
      emitStep({ step: 'provider', provider: 'mock', model: 'mock', reason: String(e.status || e.message) });
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
