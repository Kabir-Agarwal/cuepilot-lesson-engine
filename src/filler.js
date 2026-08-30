import { completeJSON } from './llm.js';
import { validateBlock, makeBlock } from './schema.js';
import { complexityDirective, clampComplexity } from './complexity.js';
import { prefsDirective } from './prefs.js';
import { estMinutesFor } from './timebudget.js';
import { retrieve, sourceRefsFrom } from './rag.js';

const SHAPES = {
  hook: '{"text": string}',
  explain: '{"heading": string, "paragraphs": string[]}',
  number_line: '{"min": number, "max": number, "step": number, "marks": [{"value": number, "label": string}], "question": string}',
  bar_compare: '{"items": [{"label": string, "numerator": number, "denominator": number}], "caption": string}',
  sequence: '{"steps": [{"title": string, "text": string}]}',
  mcq: '{"question": string, "options": [4 strings], "answerIndex": 0-3, "explanation": string}',
  activity: '{"title": string, "materials": string[], "instructions": string[]}',
  exit_ticket: '{"questions": string[]}',
  teacher_notes: '{"points": string[]}',
};

// Canned, valid, deterministic mock bodies — demo insurance with no network.
function mockData(type, intent, spec, complexity) {
  const t = spec.topic;
  const tag = `(level ${complexity})`;
  switch (type) {
    case 'hook':
      return { text: `Think about ${t} in your own day ${tag}. ${intent}` };
    case 'explain':
      return {
        heading: `Understanding ${t}`,
        paragraphs: [
          `${intent}`,
          `We build the idea of ${t} step by step, using the examples from your own material.`,
          `Say it out loud in your own words before moving on.`,
        ].slice(0, complexity >= 4 ? 3 : 2),
      };
    case 'number_line':
      return {
        min: 0, max: 1, step: 0.25,
        marks: [
          { value: 0, label: '0' }, { value: 0.25, label: '1/4' }, { value: 0.5, label: '2/4' },
          { value: 0.75, label: '3/4' }, { value: 1, label: '1' },
        ],
        question: `Tap each mark. ${intent}`,
      };
    case 'bar_compare':
      return {
        items: [
          { label: 'One half', numerator: 1, denominator: 2 },
          { label: 'One third', numerator: 1, denominator: 3 },
          { label: 'One sixth', numerator: 1, denominator: 6 },
        ],
        caption: `${intent}`,
      };
    case 'sequence':
      return {
        steps: [
          { title: 'Look', text: `Look closely at the ${t} example in front of you.` },
          { title: 'Try', text: `${intent}` },
          { title: 'Check', text: `Check your answer with your partner and say why.` },
        ],
      };
    case 'mcq':
      return {
        question: `Which statement about ${t} is correct?`,
        options: [
          `The parts do not have to be equal`,
          `The parts must all be equal`,
          `${t} only works with two parts`,
          `${t} has nothing to do with sharing`,
        ],
        answerIndex: 1,
        explanation: `${intent}`,
      };
    case 'activity':
      return {
        title: `Hands-on with ${t}`,
        materials: ['paper', 'pencil'],
        instructions: [
          'Work in pairs.',
          `${intent}`,
          'Write one sentence about what you found.',
        ],
      };
    case 'exit_ticket':
      return { questions: [`In one sentence, what is ${t}?`, `${intent}`] };
    case 'teacher_notes':
      return { points: [`${intent}`, `Watch for learners who rush this part of ${t}.`] };
    default:
      return { text: intent };
  }
}

/**
 * Builds ONE block. Always does a fresh retrieval for this block's intent,
 * so sourceRefs reflect the chunks that actually fed it.
 */
export async function fillBlock({ type, intent, complexity, spec, prefs, extraInstruction = '', siblingSummaries = [], keepId }) {
  const c = clampComplexity(complexity ?? spec.defaultComplexity);
  const chunks = await retrieve(`${intent} ${extraInstruction}`.trim(), {
    materialIds: spec.materialIds,
    board: spec.board, grade: spec.grade, subject: spec.subject, k: 3,
  });

  const context = chunks.map((ch, i) => `[${i + 1}] (${ch.attribution_string})\n${ch.content}`).join('\n\n');
  const siblings = siblingSummaries.length
    ? `\nOTHER BLOCKS IN THIS LESSON (read-only, do NOT rewrite them — just avoid repeating them):\n${siblingSummaries.map(s => `- ${s}`).join('\n')}`
    : '';

  const system = 'You write school lesson content as JSON only. You never write HTML, never add keys, never add prose outside the JSON.';
  const prompt = `Write the DATA for one "${type}" block of a lesson.
Lesson ${spec.lessonIndex} of ${spec.nLessons} on "${spec.topic}". Board: ${spec.board}. Grade: ${spec.grade}. Subject: ${spec.subject}.
BLOCK INTENT: ${intent}
${extraInstruction ? `TEACHER'S EDIT INSTRUCTION FOR THIS BLOCK: ${extraInstruction}` : ''}

${complexityDirective(c)}
${prefsDirective(prefs)}
LESSON-WIDE TEACHER INSTRUCTIONS: ${spec.instructions || '(none)'}
${siblings}

TEACHER MATERIAL — ground the content in these excerpts, do not invent facts outside them:
${context || '(no material retrieved — stay generic and safe)'}

Return ONLY this JSON shape, no wrapper:
${SHAPES[type] || '{"text": string}'}
Also include a "narration" string key: one or two sentences a teacher could read aloud for this block.`;

  const mock = { ...mockData(type, intent, spec, c), narration: `${intent}` };
  let data;
  try {
    data = await completeJSON({ system, prompt, mock });
  } catch (e) {
    console.warn(`[filler] ${type} generation failed (${e.message}) — using safe fallback`);
    data = mock;
  }

  const narration = String(data?.narration ?? '');
  if (data && typeof data === 'object') delete data.narration;

  const block = makeBlock({
    id: keepId,
    type,
    data,
    complexity: c,
    estMinutes: estMinutesFor(type, spec.grade),
    sourceRefs: sourceRefsFrom(chunks),
    narration,
  });

  const check = validateBlock(block);
  if (!check.ok) {
    console.warn(`[filler] invalid ${type} block (${check.errors[0]}) — using safe fallback`);
    block.data = mockData(type, intent, spec, c);
    block.narration = narration || intent;
  }
  return block;
}

export const summarise = b => {
  const d = b.data || {};
  const text = d.heading || d.title || d.question || d.text
    || d.caption || d.steps?.[0]?.title || d.questions?.[0] || d.points?.[0] || '';
  return `${b.id} (${b.type}, C${b.complexity}): ${String(text).slice(0, 90)}`;
};
