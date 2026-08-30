// Lesson JSON is the truth. Everything downstream (renderers, edits) trusts these shapes.
import { randomUUID } from 'node:crypto';

export const BLOCK_TYPES = [
  'hook', 'explain', 'number_line', 'bar_compare', 'sequence',
  'mcq', 'activity', 'exit_ticket', 'teacher_notes',
  // Richer, UI-forward types (v9): a process/decision diagram, a tips callout,
  // and a small click-to-match game. See render/index.js for their renderers.
  'flowchart', 'pro_tip', 'match_game',
];

/** Node roles a flowchart may use. */
export const FLOW_NODE_TYPES = ['start', 'process', 'decision', 'end'];

const str = v => typeof v === 'string' && v.trim().length > 0;
const num = v => typeof v === 'number' && Number.isFinite(v);
const arr = (v, f) => Array.isArray(v) && v.length > 0 && v.every(f);

// One validator per block type. Returns array of error strings (empty = valid).
const DATA_RULES = {
  hook: d => [!str(d.text) && 'hook.text must be a non-empty string'],
  explain: d => [
    !str(d.heading) && 'explain.heading must be a non-empty string',
    !arr(d.paragraphs, str) && 'explain.paragraphs must be a non-empty string[]',
  ],
  number_line: d => [
    !num(d.min) && 'number_line.min must be a number',
    !num(d.max) && 'number_line.max must be a number',
    !(num(d.step) && d.step > 0) && 'number_line.step must be a positive number',
    num(d.min) && num(d.max) && d.max <= d.min && 'number_line.max must exceed min',
    !Array.isArray(d.marks) && 'number_line.marks must be an array',
    Array.isArray(d.marks) && !d.marks.every(m => m && num(m.value) && str(m.label)) && 'number_line.marks entries need {value:number,label:string}',
    !str(d.question) && 'number_line.question must be a non-empty string',
  ],
  bar_compare: d => [
    !arr(d.items, i => i && str(i.label) && num(i.numerator) && num(i.denominator) && i.denominator > 0)
      && 'bar_compare.items must be [{label,numerator,denominator>0}]',
    !str(d.caption) && 'bar_compare.caption must be a non-empty string',
  ],
  sequence: d => [
    !arr(d.steps, s => s && str(s.title) && str(s.text)) && 'sequence.steps must be [{title,text}]',
  ],
  mcq: d => [
    !str(d.question) && 'mcq.question must be a non-empty string',
    !(Array.isArray(d.options) && d.options.length === 4 && d.options.every(str)) && 'mcq.options must be exactly 4 non-empty strings',
    !(Number.isInteger(d.answerIndex) && d.answerIndex >= 0 && d.answerIndex <= 3) && 'mcq.answerIndex must be an integer 0-3',
    !str(d.explanation) && 'mcq.explanation must be a non-empty string',
  ],
  activity: d => [
    !str(d.title) && 'activity.title must be a non-empty string',
    !arr(d.instructions, str) && 'activity.instructions must be a non-empty string[]',
    !(Array.isArray(d.materials) && d.materials.every(str)) && 'activity.materials must be a string[]',
  ],
  exit_ticket: d => [!arr(d.questions, str) && 'exit_ticket.questions must be a non-empty string[]'],
  teacher_notes: d => [!arr(d.points, str) && 'teacher_notes.points must be a non-empty string[]'],
  flowchart: d => [
    !arr(d.nodes, n => n && FLOW_NODE_TYPES.includes(n.type) && str(n.text))
      && `flowchart.nodes must be [{type:${FLOW_NODE_TYPES.join('|')}, text}]`,
    Array.isArray(d.nodes) && !d.nodes.some(n => n.type === 'start') && 'flowchart.nodes needs a start node',
    Array.isArray(d.nodes) && !d.nodes.some(n => n.type === 'end') && 'flowchart.nodes needs an end node',
    d.title != null && !str(d.title) && 'flowchart.title, if present, must be a non-empty string',
  ],
  pro_tip: d => [
    !arr(d.tips, str) && 'pro_tip.tips must be a non-empty string[]',
    d.label != null && !str(d.label) && 'pro_tip.label, if present, must be a non-empty string',
  ],
  match_game: d => [
    !str(d.prompt) && 'match_game.prompt must be a non-empty string',
    !(Array.isArray(d.pairs) && d.pairs.length >= 2 && d.pairs.length <= 6
      && d.pairs.every(p => p && str(p.left) && str(p.right)))
      && 'match_game.pairs must be 2-6 items of {left,right}',
  ],
};

export function validateBlock(block) {
  const errors = [];
  if (!block || typeof block !== 'object') return { ok: false, errors: ['block must be an object'] };
  if (!str(block.id)) errors.push('block.id must be a non-empty string');
  if (!BLOCK_TYPES.includes(block.type)) errors.push(`block.type must be one of ${BLOCK_TYPES.join('|')}`);
  if (!(Number.isInteger(block.complexity) && block.complexity >= 1 && block.complexity <= 5)) errors.push('block.complexity must be an integer 1-5');
  if (!(num(block.estMinutes) && block.estMinutes >= 0)) errors.push('block.estMinutes must be a number >= 0');
  if (!Array.isArray(block.sourceRefs)) errors.push('block.sourceRefs must be an array');
  else if (!block.sourceRefs.every(r => r && str(r.sourceId) && str(r.sourceName) && str(r.attribution)))
    errors.push('block.sourceRefs entries need {sourceId,sourceName,attribution}');
  if (!block.data || typeof block.data !== 'object') errors.push('block.data must be an object');
  else if (DATA_RULES[block.type]) errors.push(...DATA_RULES[block.type](block.data).filter(Boolean));
  return { ok: errors.length === 0, errors };
}

export function validateLesson(lesson) {
  const errors = [];
  if (!lesson || typeof lesson !== 'object') return { ok: false, errors: ['lesson must be an object'] };
  for (const f of ['id', 'title', 'board', 'grade', 'subject', 'topic']) {
    if (!str(String(lesson[f] ?? ''))) errors.push(`lesson.${f} is required`);
  }
  if (!(Number.isInteger(lesson.nLessons) && lesson.nLessons >= 1)) errors.push('lesson.nLessons must be an integer >= 1');
  if (!(Number.isInteger(lesson.lessonIndex) && lesson.lessonIndex >= 1)) errors.push('lesson.lessonIndex must be an integer >= 1');
  if (Number.isInteger(lesson.nLessons) && Number.isInteger(lesson.lessonIndex) && lesson.lessonIndex > lesson.nLessons)
    errors.push('lesson.lessonIndex must be <= nLessons');
  if (!(num(lesson.durationMins) && lesson.durationMins > 0)) errors.push('lesson.durationMins must be a positive number');
  if (!(Number.isInteger(lesson.defaultComplexity) && lesson.defaultComplexity >= 1 && lesson.defaultComplexity <= 5))
    errors.push('lesson.defaultComplexity must be an integer 1-5');
  if (!Array.isArray(lesson.blocks) || lesson.blocks.length === 0) errors.push('lesson.blocks must be a non-empty array');
  else {
    const ids = new Set();
    lesson.blocks.forEach((b, i) => {
      const r = validateBlock(b);
      if (!r.ok) errors.push(...r.errors.map(e => `blocks[${i}]: ${e}`));
      if (b && ids.has(b.id)) errors.push(`blocks[${i}]: duplicate block id ${b.id}`);
      if (b) ids.add(b.id);
    });
  }
  return { ok: errors.length === 0, errors };
}

export const newId = prefix => `${prefix}_${randomUUID().slice(0, 8)}`;

export function makeBlock({ type, data, complexity, estMinutes, sourceRefs = [], narration = '', id }) {
  return { id: id || newId('b'), type, data, complexity, estMinutes, sourceRefs, narration };
}

export const DEFAULT_PREFS = {
  teacherId: 'default',
  textDensity: 'medium',   // low | medium | high
  simpleLanguage: false,
  tone: 'warm',
  defaultComplexity: 3,
  defaultVisualDemand: 3,  // representation density 1-5, independent of complexity
};
