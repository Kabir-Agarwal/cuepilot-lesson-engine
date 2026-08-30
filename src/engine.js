import { completeJSON } from './llm.js';
import { BLOCK_TYPES, newId, validateLesson } from './schema.js';
import { clampComplexity } from './complexity.js';
import { clampVisual, VISUAL_TYPES, PROSE_TYPES } from './visual.js';
import { fitCheck } from './timebudget.js';
import { getPrefs } from './prefs.js';
import { plan } from './planner.js';
import { fillBlock, summarise } from './filler.js';
import { save, load } from './store.js';
import { retrieve, loadChunks } from './rag.js';
import { emitStep } from './progress.js';
import { runVerifier } from './verifier.js';

function specFrom(input, materialIds) {
  const spec = {
    board: input.board || 'CBSE',
    grade: String(input.grade ?? '4'),
    subject: input.subject || 'Mathematics',
    topic: input.topic || 'Topic',
    nLessons: Math.max(1, parseInt(input.nLessons, 10) || 1),
    lessonIndex: Math.max(1, parseInt(input.lessonIndex, 10) || 1),
    durationMins: Math.max(5, Number(input.durationMins) || 40),
    defaultComplexity: clampComplexity(input.defaultComplexity),
    visualDemand: clampVisual(input.visualDemand),
    instructions: String(input.instructions || ''),
    materialIds,
  };
  if (Array.isArray(input.requestedBlocks) && input.requestedBlocks.length) {
    const unknown = input.requestedBlocks.filter(t => !BLOCK_TYPES.includes(t));
    if (unknown.length) throw Object.assign(new Error(`unknown requestedBlocks: ${unknown.join(', ')}`), { status: 400, code: 'BAD_BLOCK_TYPE' });
    spec.requestedBlocks = [...input.requestedBlocks];
  }
  return spec;
}

/** Rehydrates saved material chunks into the local RAG index (server-restart safe). */
function ensureMaterials(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const loaded = [];
  for (const id of list) {
    const m = load('materials', id);
    if (m?.chunks) { loadChunks(id, m.chunks); loaded.push(m); }
  }
  return loaded;
}
const ensureMaterial = id => ensureMaterials([id])[0] || null;

// Accepts a single materialId or a materialIds[] (teammate spec D4). Multiple must share
// teacherId + subject, else 400. Returns the validated id list.
function resolveMaterialIds(materialId, materialIds, teacherId) {
  const ids = Array.isArray(materialIds) && materialIds.length ? materialIds : (materialId ? [materialId] : []);
  if (!ids.length) return [];  // upload optional: no material -> ungrounded generation

  const mats = ids.map(id => ({ id, m: load('materials', id) }));
  const missing = mats.filter(x => !x.m).map(x => x.id);
  if (missing.length) throw Object.assign(new Error(`material(s) not found: ${missing.join(', ')}`), { status: 400, code: 'MATERIAL_REQUIRED' });
  if (ids.length > 1) {
    const subjects = new Set(mats.map(x => x.m.subject));
    const teachers = new Set(mats.map(x => x.m.teacherId));
    if (subjects.size > 1 || teachers.size > 1) {
      throw Object.assign(new Error('materialIds[] must share the same teacherId and subject'), { status: 400, code: 'MATERIAL_MISMATCH' });
    }
  }
  ensureMaterials(ids);
  return ids;
}

export async function generateLesson(input, materialId, teacherId = 'default', materialIds) {
  const ids = resolveMaterialIds(materialId, materialIds ?? input?.materialIds, teacherId);
  const prefs = getPrefs(teacherId);
  const spec = specFrom({ defaultComplexity: prefs.defaultComplexity, visualDemand: prefs.defaultVisualDemand, ...input }, ids);

  emitStep({ step: 'retrieving', materials: ids.length });
  const seed = await retrieve(`${spec.topic} grade ${spec.grade} ${spec.subject}`, {
    materialIds: spec.materialIds, k: 4,
  });
  emitStep({ step: 'planning' });
  const outline = await plan(spec, seed, prefs);

  const blocks = [];
  const total = outline.blocks.length;
  for (const p of outline.blocks) {
    emitStep({ step: 'block', i: blocks.length + 1, n: total, type: p.type });
    blocks.push(await fillBlock({
      type: p.type, intent: p.intent, complexity: spec.defaultComplexity, spec, prefs,
      siblingSummaries: blocks.map(summarise),
    }));
  }

  const lesson = {
    id: newId('lsn'),
    title: outline.title,
    board: spec.board, grade: spec.grade, subject: spec.subject, topic: spec.topic,
    nLessons: spec.nLessons, lessonIndex: spec.lessonIndex,
    durationMins: spec.durationMins, defaultComplexity: spec.defaultComplexity, visualDemand: spec.visualDemand,
    instructions: spec.instructions,
    teacherId, materialId: ids[0] ?? null, materialIds: ids,
    timeFit: fitCheck(blocks, spec.durationMins),
    blocks,
  };
  if (outline.droppedForTime > 0) {
    lesson.timeFit.notice = `${outline.droppedForTime} planned block(s) did not fit ${spec.durationMins} min and were not generated. Nothing from your material was cut mid-block.`;
  }

  // Optional verifier agent (E): only when VERIFY_PASS=on. Routes fixes through the op executor.
  await runVerifier(lesson, spec, prefs, { executeOps, validateOps, summarise });

  save('lessons', lesson.id, lesson);
  const check = validateLesson(lesson);
  if (!check.ok) console.warn('[engine] generated lesson has issues:', check.errors.slice(0, 3));
  return lesson;
}

/* ---------------- Path A: per-block edit ---------------- */

// Picks a fitting visual type for a prose block asked to become visual (or the reverse).
// Returns null when no retype is warranted, so most edits keep the block's type.
function retypeForVisual(type, visualDemand) {
  const v = clampVisual(visualDemand);
  if (type === 'hook' || type === 'exit_ticket') return null;       // never retype the framing blocks
  if (v >= 4 && PROSE_TYPES.includes(type)) return 'sequence';       // prose -> a representation
  if (v <= 2 && VISUAL_TYPES.includes(type) && type !== 'activity') return 'explain';  // visual -> prose
  return null;
}

export async function editBlock(lessonId, blockId, { instruction, complexity, visualDemand } = {}) {
  if (instruction == null && complexity == null && visualDemand == null) {
    throw Object.assign(new Error('editBlock needs at least one of instruction, complexity, visualDemand'), { status: 400 });
  }
  const lesson = load('lessons', lessonId);
  if (!lesson) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });
  const idx = lesson.blocks.findIndex(b => b.id === blockId);
  if (idx === -1) throw Object.assign(new Error(`block ${blockId} not found`), { status: 404 });

  const ids = lesson.materialIds?.length ? lesson.materialIds : (lesson.materialId ? [lesson.materialId] : []);
  ensureMaterials(ids);
  const prefs = getPrefs(lesson.teacherId || 'default');
  // This block's visualDemand overrides the lesson default for this regen only.
  const spec = specFrom({ ...lesson, visualDemand: visualDemand == null ? lesson.visualDemand : visualDemand }, ids);
  const old = lesson.blocks[idx];

  // High visual demand may turn a prose block into a representation (and vice versa) via retype.
  const newType = visualDemand == null ? old.type : (retypeForVisual(old.type, visualDemand) || old.type);
  const intent = newType !== old.type
    ? `Cover the same idea as the previous ${old.type} (${summarise(old)}) but as a ${newType} representation${instruction ? `, and: ${instruction}` : ''}`
    : `${old.narration || summarise(old)}${instruction ? ` — revised so that: ${instruction}` : ''}`;

  const fresh = await fillBlock({
    type: newType, intent, spec, prefs,
    complexity: complexity == null ? old.complexity : complexity,
    extraInstruction: instruction || '',
    siblingSummaries: lesson.blocks.filter(b => b.id !== blockId).map(summarise),
    keepId: blockId,
  });

  lesson.blocks[idx] = fresh;                       // only this index is touched
  lesson.timeFit = fitCheck(lesson.blocks, lesson.durationMins);
  save('lessons', lesson.id, lesson);
  return { block: fresh, lesson, timeFit: lesson.timeFit };
}

/* ---------------- Path B: lesson-level conversational edit ---------------- */

const OPS = ['add', 'remove', 'edit', 'retype', 'global'];

function mockOps(instruction, lesson) {
  const s = instruction.toLowerCase();
  const ids = lesson.blocks.map(b => b.id);
  const ops = [];

  // "remove blocks 5 and 6" / "delete block 2" / "remove b_ab12cd34"
  const removeMatch = s.match(/\b(remove|delete|drop)\b([^.]*)/);
  if (removeMatch) {
    const named = ids.filter(id => s.includes(id.toLowerCase()));
    // Strip any explicit block ids before reading ordinals, so hex digits inside an id
    // (e.g. b_b85644a1) are never mistaken for "block number 1".
    let rest = removeMatch[2];
    named.forEach(id => { rest = rest.split(id.toLowerCase()).join(' '); });
    const nums = (rest.match(/\d+/g) || []).map(n => parseInt(n, 10));
    const byNum = nums.map(n => ids[n - 1]).filter(Boolean);
    const blockIds = [...new Set([...named, ...byNum])];
    if (blockIds.length) ops.push({ op: 'remove', blockIds });
  }
  // "add an assessment at the end"
  if (/\badd\b|\bappend\b|\binclude\b/.test(s)) {
    const type = /assessment|quiz|test|question/.test(s) ? 'mcq'
      : /activity|hands|practical/.test(s) ? 'activity'
      : /exit|ticket/.test(s) ? 'exit_ticket'
      : /note/.test(s) ? 'teacher_notes'
      : /hook|opening|starter/.test(s) ? 'hook'
      : 'explain';
    ops.push({ op: 'add', position: 'end', type, intent: instruction });
  }
  // "make suitable for grade 4" / "make it simpler" / re-tone
  if (/\bgrade\b|\bsimpler\b|\bsimplify\b|\beasier\b|\bharder\b|\btone\b|\bwhole lesson\b|\bevery block\b/.test(s)) {
    ops.push({ op: 'global', instruction });
  }
  // No verb we understood, and not a removal that resolved to nothing -> treat as a first-block edit.
  if (!ops.length && !removeMatch) ops.push({ op: 'edit', blockId: ids[0], instruction });
  return ops;
}

export function validateOps(raw, lesson) {
  const ids = new Set(lesson.blocks.map(b => b.id));
  const out = [];
  for (const o of Array.isArray(raw) ? raw : []) {
    if (!o || !OPS.includes(o.op)) continue;
    if (o.op === 'remove') {
      const blockIds = (o.blockIds || []).filter(id => ids.has(id));
      if (blockIds.length) out.push({ op: 'remove', blockIds });
    } else if (o.op === 'edit') {
      if (ids.has(o.blockId) && o.instruction) out.push({ op: 'edit', blockId: o.blockId, instruction: String(o.instruction) });
    } else if (o.op === 'retype') {
      if (ids.has(o.blockId) && BLOCK_TYPES.includes(o.newType)) out.push({ op: 'retype', blockId: o.blockId, newType: o.newType, intent: String(o.intent || '') });
    } else if (o.op === 'add') {
      if (!BLOCK_TYPES.includes(o.type)) continue;
      const after = ids.has(o.afterBlockId) ? o.afterBlockId : null;
      out.push({ op: 'add', afterBlockId: after, position: after ? undefined : 'end', type: o.type, intent: String(o.intent || '') });
    } else if (o.op === 'global') {
      if (o.instruction) out.push({ op: 'global', instruction: String(o.instruction) });
    }
  }
  return out;
}

/**
 * Shared op executor — the ONE place ops mutate a lesson. Used by editLesson AND the verifier.
 * Untouched blocks are the SAME objects (never regenerated). Returns {blocks, changedBlockIds}.
 */
export async function executeOps(lesson, ops, spec, prefs, instruction = '') {
  const byId = new Map(lesson.blocks.map(b => [b.id, b]));
  const changed = new Set();
  const removed = new Set();
  const inserts = [];   // {afterId|null, block}

  for (const op of ops) {
    if (op.op === 'remove') {
      op.blockIds.forEach(id => removed.add(id));
      emitStep({ step: 'op', op: 'remove', blockIds: op.blockIds });
    } else if (op.op === 'edit' || op.op === 'retype') {
      const old = byId.get(op.blockId);
      if (!old || removed.has(op.blockId)) continue;
      const type = op.op === 'retype' ? op.newType : old.type;
      const intent = op.op === 'retype'
        ? (op.intent || `Replace the previous ${old.type} with a ${type} covering: ${summarise(old)}`)
        : `${old.narration || summarise(old)} — revised so that: ${op.instruction}`;
      emitStep({ step: 'op', op: op.op, blockId: op.blockId });
      const fresh = await fillBlock({
        type, intent, spec, prefs, complexity: old.complexity,
        extraInstruction: op.instruction || op.intent || '',
        siblingSummaries: lesson.blocks.filter(b => b.id !== op.blockId).map(summarise),
        keepId: op.blockId,
      });
      byId.set(op.blockId, fresh);
      changed.add(op.blockId);
    } else if (op.op === 'add') {
      emitStep({ step: 'op', op: 'add', type: op.type });
      const fresh = await fillBlock({
        type: op.type, intent: op.intent || `A ${op.type} block: ${instruction}`,
        spec, prefs, complexity: lesson.defaultComplexity,
        siblingSummaries: lesson.blocks.map(summarise),
      });
      inserts.push({ afterId: op.afterBlockId || null, block: fresh });
      changed.add(fresh.id);
    } else if (op.op === 'global') {
      for (const b of lesson.blocks) {
        if (removed.has(b.id)) continue;
        const cur = byId.get(b.id);
        emitStep({ step: 'op', op: 'global', blockId: b.id });
        const fresh = await fillBlock({
          type: cur.type,
          intent: `${cur.narration || summarise(cur)} — revised so that: ${op.instruction}`,
          spec, prefs, complexity: cur.complexity, extraInstruction: op.instruction,
          siblingSummaries: lesson.blocks.filter(x => x.id !== b.id).map(summarise),
          keepId: b.id,
        });
        byId.set(b.id, fresh);
        changed.add(b.id);
      }
    }
  }

  // Rebuild: untouched blocks are the SAME objects, never regenerated.
  const next = [];
  for (const b of lesson.blocks) {
    if (removed.has(b.id)) continue;
    next.push(byId.get(b.id));
    for (const ins of inserts) if (ins.afterId === b.id) next.push(ins.block);
  }
  for (const ins of inserts) if (!ins.afterId) next.push(ins.block);

  return { blocks: next, changedBlockIds: [...changed].filter(id => next.some(b => b.id === id)) };
}

export async function editLesson(lessonId, instruction) {
  if (!instruction || !String(instruction).trim()) throw Object.assign(new Error('editLesson needs an instruction'), { status: 400 });
  const lesson = load('lessons', lessonId);
  if (!lesson) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });

  const ids = lesson.materialIds?.length ? lesson.materialIds : (lesson.materialId ? [lesson.materialId] : []);
  ensureMaterials(ids);
  const prefs = getPrefs(lesson.teacherId || 'default');
  const spec = specFrom(lesson, ids);
  emitStep({ step: 'planning' });

  // The op planner sees ONLY the outline — never full block content.
  const outline = lesson.blocks.map((b, i) => `${i + 1}. ${summarise(b)}`).join('\n');
  const system = 'You turn a teacher\'s request into a minimal list of edit operations on a lesson. You output ONLY a JSON array.';
  const prompt = `LESSON OUTLINE (block number, id, type, complexity, one-line summary):
${outline}

TEACHER REQUEST: "${instruction}"

Return ONLY a JSON array of operations. Allowed shapes:
{"op":"add","afterBlockId":"<id>"|null,"position":"end","type":"<block type>","intent":"what the new block must do"}
{"op":"remove","blockIds":["<id>", ...]}
{"op":"edit","blockId":"<id>","instruction":"what to change in that block"}
{"op":"retype","blockId":"<id>","newType":"<block type>","intent":"what the replacement must do"}
{"op":"global","instruction":"a change that must apply to every block, e.g. re-grade or re-tone"}

Block types: ${BLOCK_TYPES.join(', ')}.
Rules: change as little as possible. Only touch blocks the teacher actually asked about.
Use "global" ONLY when the request is about the whole lesson (grade level, tone, language).`;

  let rawOps;
  try {
    rawOps = await completeJSON({ system, prompt, mock: mockOps(String(instruction), lesson) });
  } catch (e) {
    console.warn(`[editLesson] op planning failed (${e.message}) — using heuristic ops`);
    rawOps = mockOps(String(instruction), lesson);
  }
  const ops = validateOps(rawOps, lesson);
  if (!ops.length) {
    return { lesson, changedBlockIds: [], timeFit: lesson.timeFit, ops: [], note: 'No applicable operation was derived from that instruction. Nothing was changed.' };
  }

  const { blocks, changedBlockIds } = await executeOps(lesson, ops, spec, prefs, instruction);
  lesson.blocks = blocks;
  lesson.timeFit = fitCheck(blocks, lesson.durationMins);
  emitStep({ step: 'rendering' });
  save('lessons', lesson.id, lesson);
  return { lesson, changedBlockIds, timeFit: lesson.timeFit, ops };
}

/* ---------------- Teammate spec D3: reorder (no LLM) ---------------- */

export function reorderBlocks(lessonId, blockIds) {
  const lesson = load('lessons', lessonId);
  if (!lesson) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });
  const current = lesson.blocks.map(b => b.id);
  const asSet = a => [...a].sort().join(',');
  if (!Array.isArray(blockIds) || asSet(blockIds) !== asSet(current)) {
    throw Object.assign(new Error('blockIds must be a permutation of the lesson\'s existing block ids'), { status: 400, code: 'BAD_PERMUTATION' });
  }
  const byId = new Map(lesson.blocks.map(b => [b.id, b]));
  lesson.blocks = blockIds.map(id => byId.get(id));   // same objects, new order — no regeneration
  lesson.timeFit = fitCheck(lesson.blocks, lesson.durationMins);
  save('lessons', lesson.id, lesson);
  return lesson;
}

/* ---------------- Stretch S3: multi-lesson roadmap ---------------- */

export async function roadmap(input, materialId, teacherId = 'default') {
  if (!materialId || !ensureMaterial(materialId)) throw Object.assign(new Error('a materialId is required'), { status: 400, code: 'MATERIAL_REQUIRED' });
  const prefs = getPrefs(teacherId);
  const spec = specFrom({ defaultComplexity: prefs.defaultComplexity, ...input }, [materialId]);
  const chunks = await retrieve(`${spec.topic} ${spec.subject} grade ${spec.grade}`, { materialIds: [materialId], k: 4 });
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');

  const mock = {
    lessons: Array.from({ length: spec.nLessons }, (_, k) => ({
      lessonIndex: k + 1,
      title: `${spec.topic} — part ${k + 1}`,
      focus: `Part ${k + 1} of ${spec.nLessons}: the slice of ${spec.topic} that belongs at this point in the sequence.`,
    })),
  };
  const system = 'You plan a sequence of school lessons. Output ONLY JSON.';
  const prompt = `Split "${spec.topic}" (${spec.subject}, grade ${spec.grade}, ${spec.board}) into ${spec.nLessons} lessons.
TEACHER MATERIAL:
${context || '(none)'}
Return JSON {"lessons":[{"lessonIndex":number,"title":string,"focus":"one line of what this lesson covers"}]} with exactly ${spec.nLessons} entries in order.`;
  let raw;
  try { raw = await completeJSON({ system, prompt, mock }); }
  catch (e) { console.warn(`[roadmap] failed (${e.message}) — using mock plan`); raw = mock; }
  const lessons = (raw?.lessons || mock.lessons)
    .slice(0, spec.nLessons)
    .map((l, k) => ({ lessonIndex: k + 1, title: String(l.title || `${spec.topic} — part ${k + 1}`), focus: String(l.focus || '') }));
  return { topic: spec.topic, nLessons: spec.nLessons, materialId, lessons };
}

export function duplicateLesson(lessonId) {
  const src = load('lessons', lessonId);
  if (!src) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });
  const copy = structuredClone(src);
  copy.id = newId('lsn');
  copy.title = `${src.title} (copy)`;
  copy.blocks = copy.blocks.map(b => ({ ...b, id: newId('b') }));
  save('lessons', copy.id, copy);
  return copy;
}
