// Optional verifier agent (v8.3 section E). OFF unless VERIFY_PASS=on.
// It sees only the OUTLINE (never full block bodies), returns {ok:true} or edit ops in the
// exact editLesson schema, and those ops are applied through the SAME op executor — so any
// block it does not name stays byte-identical. Bounded by VERIFY_MAX_CYCLES (hard cap 3).
import { completeJSON } from './llm.js';
import { BLOCK_TYPES } from './schema.js';
import { fitCheck } from './timebudget.js';
import { emitStep } from './progress.js';

export const verifyEnabled = () => (process.env.VERIFY_PASS || '').toLowerCase() === 'on';

function maxCycles() {
  const n = parseInt(process.env.VERIFY_MAX_CYCLES || '1', 10);
  return Math.max(1, Math.min(3, Number.isFinite(n) ? n : 1));
}
export const __maxCyclesForTest = maxCycles;   // test hook for the cycle cap

/**
 * runVerifier(lesson, spec, prefs, { executeOps, validateOps, summarise }) — mutates lesson in place.
 * Deps are injected to avoid an engine<->verifier import cycle.
 */
export async function runVerifier(lesson, spec, prefs, { executeOps, validateOps, summarise }) {
  if (!verifyEnabled()) return { ran: false, cycles: 0, changedBlockIds: [] };

  const cycles = maxCycles();
  const allChanged = new Set();
  for (let cycle = 1; cycle <= cycles; cycle++) {
    emitStep({ step: 'verifying', cycle });
    const outline = lesson.blocks.map((b, i) =>
      `${i + 1}. id=${b.id} type=${b.type} C${b.complexity} ${b.estMinutes}min — ${summarise(b)}`).join('\n');

    const system = 'You are a curriculum QA reviewer. You output ONLY JSON: {"ok":true} or a JSON array of edit ops.';
    const prompt = `Review this lesson OUTLINE for lesson ${spec.lessonIndex} of ${spec.nLessons} on "${spec.topic}", ${spec.board} grade ${spec.grade} ${spec.subject}, ${spec.durationMins} min, default complexity ${spec.defaultComplexity}.

OUTLINE:
${outline}

Check: does it open with a hook and close with exit_ticket/teacher_notes? Is the complexity consistent with the target? Any duplicate or missing essential block? Does it fit the time?
If it is already good, return {"ok":true}.
Otherwise return the MINIMAL list of edit ops (change as little as possible), same schema as lesson edits:
{"op":"add","afterBlockId":"<id>"|null,"position":"end","type":"<type>","intent":"..."}
{"op":"remove","blockIds":["<id>"]}
{"op":"edit","blockId":"<id>","instruction":"..."}
{"op":"retype","blockId":"<id>","newType":"<type>","intent":"..."}
{"op":"global","instruction":"..."}
Block types: ${BLOCK_TYPES.join(', ')}.`;

    // Mock verifier is always satisfied — keeps the offline demo deterministic.
    const raw = await completeJSON({ system, prompt, mock: { ok: true } });

    if (raw && !Array.isArray(raw) && raw.ok === true) break;         // verifier satisfied
    const ops = validateOps(Array.isArray(raw) ? raw : (raw?.ops || []), lesson);
    if (!ops.length) break;                                           // nothing actionable

    const { blocks, changedBlockIds } = await executeOps(lesson, ops, spec, prefs, 'verifier pass');
    lesson.blocks = blocks;
    lesson.timeFit = fitCheck(blocks, lesson.durationMins);
    changedBlockIds.forEach(id => allChanged.add(id));
    if (!changedBlockIds.length) break;
  }

  lesson.verified = true;
  return { ran: true, cycles, changedBlockIds: [...allChanged] };
}
