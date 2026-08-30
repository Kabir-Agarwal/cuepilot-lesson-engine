import { completeJSON } from './llm.js';
import { BLOCK_TYPES, newId, validateLesson } from './schema.js';
import { clampComplexity } from './complexity.js';
import { fitCheck } from './timebudget.js';
import { getPrefs } from './prefs.js';
import { plan } from './planner.js';
import { fillBlock, summarise } from './filler.js';
import { save, load } from './store.js';
import { retrieve, loadChunks } from './rag.js';

function specFrom(input, materialIds) {
  return {
    board: input.board || 'CBSE',
    grade: String(input.grade ?? '4'),
    subject: input.subject || 'Mathematics',
    topic: input.topic || 'Topic',
    nLessons: Math.max(1, parseInt(input.nLessons, 10) || 1),
    lessonIndex: Math.max(1, parseInt(input.lessonIndex, 10) || 1),
    durationMins: Math.max(5, Number(input.durationMins) || 40),
    defaultComplexity: clampComplexity(input.defaultComplexity),
    instructions: String(input.instructions || ''),
    materialIds,
  };
}

/** Rehydrates a saved material's chunks into the local RAG index (server restart safe). */
function ensureMaterial(materialId) {
  if (!materialId) return null;
  const m = load('materials', materialId);
  if (m?.chunks) loadChunks(materialId, m.chunks);
  return m;
}

export async function generateLesson(input, materialId, teacherId = 'default') {
  ensureMaterial(materialId);
  const prefs = getPrefs(teacherId);
  const spec = specFrom({ defaultComplexity: prefs.defaultComplexity, ...input }, materialId ? [materialId] : []);

  const seed = await retrieve(`${spec.topic} grade ${spec.grade} ${spec.subject}`, {
    materialIds: spec.materialIds, k: 4,
  });
  const outline = await plan(spec, seed, prefs);

  const blocks = [];
  for (const p of outline.blocks) {
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
    durationMins: spec.durationMins, defaultComplexity: spec.defaultComplexity,
    instructions: spec.instructions,
    teacherId, materialId: materialId || null,
    timeFit: fitCheck(blocks, spec.durationMins),
    blocks,
  };
  if (outline.droppedForTime > 0) {
    lesson.timeFit.notice = `${outline.droppedForTime} planned block(s) did not fit ${spec.durationMins} min and were not generated. Nothing from your material was cut mid-block.`;
  }
  const check = validateLesson(lesson);
  if (!check.ok) console.warn('[engine] generated lesson has issues:', check.errors.slice(0, 3));
  save('lessons', lesson.id, lesson);
  return lesson;
}

/* ---------------- Path A: per-block edit ---------------- */

export async function editBlock(lessonId, blockId, { instruction, complexity } = {}) {
  if (instruction == null && complexity == null) throw Object.assign(new Error('editBlock needs instruction and/or complexity'), { status: 400 });
  const lesson = load('lessons', lessonId);
  if (!lesson) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });
  const idx = lesson.blocks.findIndex(b => b.id === blockId);
  if (idx === -1) throw Object.assign(new Error(`block ${blockId} not found`), { status: 404 });

  ensureMaterial(lesson.materialId);
  const prefs = getPrefs(lesson.teacherId || 'default');
  const spec = specFrom(lesson, lesson.materialId ? [lesson.materialId] : []);
  const old = lesson.blocks[idx];

  const intent = `${old.narration || summarise(old)}${instruction ? ` — revised so that: ${instruction}` : ''}`;
  const fresh = await fillBlock({
    type: old.type, intent, spec, prefs,
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

  // "remove blocks 5 and 6" / "delete block 2"
  const removeMatch = s.match(/\b(remove|delete|drop)\b([^.]*)/);
  if (removeMatch) {
    const nums = (removeMatch[2].match(/\d+/g) || []).map(n => parseInt(n, 10));
    const named = ids.filter(id => s.includes(id.toLowerCase()));
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

function validateOps(raw, lesson) {
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

export async function editLesson(lessonId, instruction) {
  if (!instruction || !String(instruction).trim()) throw Object.assign(new Error('editLesson needs an instruction'), { status: 400 });
  const lesson = load('lessons', lessonId);
  if (!lesson) throw Object.assign(new Error(`lesson ${lessonId} not found`), { status: 404 });

  ensureMaterial(lesson.materialId);
  const prefs = getPrefs(lesson.teacherId || 'default');
  const spec = specFrom(lesson, lesson.materialId ? [lesson.materialId] : []);

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

  const rawOps = await completeJSON({ system, prompt, mock: mockOps(String(instruction), lesson) });
  const ops = validateOps(rawOps, lesson);
  if (!ops.length) {
    return { lesson, changedBlockIds: [], timeFit: lesson.timeFit, ops: [], note: 'No applicable operation was derived from that instruction. Nothing was changed.' };
  }

  const byId = new Map(lesson.blocks.map(b => [b.id, b]));
  const changed = new Set();
  const removed = new Set();
  const inserts = [];   // {afterId|null, block}

  for (const op of ops) {
    if (op.op === 'remove') {
      op.blockIds.forEach(id => removed.add(id));
    } else if (op.op === 'edit' || op.op === 'retype') {
      const old = byId.get(op.blockId);
      if (!old || removed.has(op.blockId)) continue;
      const type = op.op === 'retype' ? op.newType : old.type;
      const intent = op.op === 'retype'
        ? (op.intent || `Replace the previous ${old.type} with a ${type} covering: ${summarise(old)}`)
        : `${old.narration || summarise(old)} — revised so that: ${op.instruction}`;
      const fresh = await fillBlock({
        type, intent, spec, prefs, complexity: old.complexity,
        extraInstruction: op.instruction || op.intent || '',
        siblingSummaries: lesson.blocks.filter(b => b.id !== op.blockId).map(summarise),
        keepId: op.blockId,
      });
      byId.set(op.blockId, fresh);
      changed.add(op.blockId);
    } else if (op.op === 'add') {
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

  lesson.blocks = next;
  lesson.timeFit = fitCheck(next, lesson.durationMins);
  save('lessons', lesson.id, lesson);
  return { lesson, changedBlockIds: [...changed].filter(id => next.some(b => b.id === id)), timeFit: lesson.timeFit, ops };
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
