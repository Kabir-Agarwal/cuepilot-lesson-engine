// Visual-demand ladder — representation DENSITY, injected into planner + filler prompts.
// Orthogonal to complexity: complexity = language depth, visualDemand = how much of the
// lesson is carried by representations/interactives vs prose.
export const VISUAL_LEVELS = {
  1: 'Visual demand 1 — text-first: explain and teacher_notes dominate; at most one representation block in the whole lesson.',
  2: 'Visual demand 2 — light visuals: mostly prose, one or two representation blocks as support.',
  3: 'Visual demand 3 — balanced: a normal mix of prose and representation/interactive blocks.',
  4: 'Visual demand 4 — visual-heavy: prefer number_line, bar_compare, sequence and mcq over plain explain wherever the concept allows.',
  5: 'Visual demand 5 — visual-first: every teachable concept gets a representation or interactive; keep explain blocks to a caption-length sentence or two.',
};

// Representation/interactive block types (the "visual" ones) vs prose types.
export const VISUAL_TYPES = ['number_line', 'bar_compare', 'sequence', 'mcq', 'activity'];
export const PROSE_TYPES = ['explain', 'teacher_notes'];

export const clampVisual = v => Math.min(5, Math.max(1, Math.round(Number(v) || 3)));

export function visualDirective(level) {
  const v = clampVisual(level);
  return `VISUAL DEMAND ${v}/5. ${VISUAL_LEVELS[v]}`;
}
