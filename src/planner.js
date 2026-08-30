import { completeJSON } from './llm.js';
import { BLOCK_TYPES } from './schema.js';
import { complexityDirective } from './complexity.js';
import { fitPlan, estMinutesFor } from './timebudget.js';
import { prefsDirective } from './prefs.js';

const DEFAULT_SHAPE = ['hook', 'explain', 'number_line', 'bar_compare', 'sequence', 'mcq', 'activity', 'exit_ticket', 'teacher_notes'];

const intentFor = (type, spec) => ({
  hook: `A real-life opening question about ${spec.topic} for grade ${spec.grade}`,
  explain: `Explain the core idea of ${spec.topic} using the teacher's own examples`,
  number_line: `Place ${spec.topic} values on a number line from the material`,
  bar_compare: `Compare quantities from the ${spec.topic} material as bars`,
  sequence: `The hands-on steps for ${spec.topic} described in the material`,
  mcq: `One check-understanding question on the commonest ${spec.topic} mistake`,
  activity: `A pair activity on ${spec.topic} using materials named in the chapter`,
  exit_ticket: `Two short exit questions on ${spec.topic}`,
  teacher_notes: `Misconceptions and pacing notes for ${spec.topic}`,
}[type] || `A ${type} block about ${spec.topic}`);

function mockPlan(spec) {
  return {
    title: `${spec.topic}: Lesson ${spec.lessonIndex} of ${spec.nLessons}`,
    blocks: DEFAULT_SHAPE.map(type => ({ type, intent: intentFor(type, spec) })),
  };
}

/** Plans the block spine for ONE lesson in a sequence. Returns {title, blocks:[{type,intent,estMinutes}]}. */
export async function plan(spec, contextChunks, prefs) {
  // Teammate spec D1: if the teacher pinned an exact block set, honour it verbatim (no LLM
  // planning of types, no time-dropping) so the generated set == the requested set.
  if (spec.requestedBlocks?.length) {
    let title = `${spec.topic}: Lesson ${spec.lessonIndex} of ${spec.nLessons}`;
    try {
      const r = await completeJSON({
        system: 'You title school lessons. Output ONLY JSON {"title": string}.',
        prompt: `Give a short lesson title for lesson ${spec.lessonIndex} of ${spec.nLessons} on "${spec.topic}", grade ${spec.grade}.`,
        mock: { title },
      });
      if (r?.title) title = String(r.title);
    } catch { /* keep default title */ }
    return {
      title,
      blocks: spec.requestedBlocks.map(type => ({ type, intent: intentFor(type, spec), estMinutes: estMinutesFor(type, spec.grade) })),
      droppedForTime: 0,
      requested: true,
    };
  }

  const context = contextChunks.map((c, i) => `[${i + 1}] (${c.attribution_string})\n${c.content}`).join('\n\n');
  const system = 'You plan school lessons. You output ONLY JSON. You never write HTML.';
  const prompt = `Plan lesson ${spec.lessonIndex} of ${spec.nLessons} on "${spec.topic}".
Board: ${spec.board}. Grade: ${spec.grade}. Subject: ${spec.subject}. Class length: ${spec.durationMins} minutes.
This lesson must cover only the slice of "${spec.topic}" that belongs at position ${spec.lessonIndex} of ${spec.nLessons}.

${complexityDirective(spec.defaultComplexity)}
${prefsDirective(prefs)}
TEACHER INSTRUCTIONS: ${spec.instructions || '(none)'}

TEACHER MATERIAL (ground every block in this):
${context || '(no material retrieved)'}

Allowed block types: ${BLOCK_TYPES.join(', ')}.
Return JSON: {"title": string, "blocks": [{"type": <allowed type>, "intent": "one line saying what this block must do, referencing the material"}]}
Rules: start with a hook, end with exit_ticket then teacher_notes. 7-10 blocks. Do not repeat a type more than twice.`;

  // A transient LLM failure (429/503) must not sink the whole lesson — degrade to the mock spine.
  let raw;
  try {
    raw = await completeJSON({ system, prompt, mock: mockPlan(spec) });
  } catch (e) {
    console.warn(`[planner] plan generation failed (${e.message}) — using mock spine`);
    raw = mockPlan(spec);
  }
  const blocks = (raw?.blocks || [])
    .filter(b => BLOCK_TYPES.includes(b?.type))
    .map(b => ({ type: b.type, intent: String(b.intent || `A ${b.type} block about ${spec.topic}`) }));
  const safe = blocks.length ? blocks : mockPlan(spec).blocks;

  // Fit to the clock (10% slack) before we spend a single filler call.
  const keptTypes = fitPlan(safe.map(b => b.type), spec.durationMins, spec.grade);
  const pool = [...safe];
  const kept = keptTypes.map(t => {
    const i = pool.findIndex(b => b.type === t);
    return pool.splice(i === -1 ? 0 : i, 1)[0];
  });

  return {
    title: String(raw?.title || `${spec.topic}: Lesson ${spec.lessonIndex} of ${spec.nLessons}`),
    blocks: kept.map(b => ({ ...b, estMinutes: estMinutesFor(b.type, spec.grade) })),
    droppedForTime: safe.length - kept.length,
  };
}
