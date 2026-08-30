// Complexity ladder. Injected verbatim into every generation prompt so the level is
// auditable in the captured prompt (see test/complexity.test.js).
export const COMPLEXITY_LEVELS = {
  1: 'Level 1 — very simple words, short sentences, everyday examples, zero jargon.',
  2: 'Level 2 — simple language, one idea per sentence, familiar examples.',
  3: 'Level 3 — grade-standard textbook language and depth.',
  4: 'Level 4 — richer vocabulary, multi-step reasoning, why-questions.',
  5: 'Level 5 — advanced: abstraction, edge cases, challenge questions.',
};

export const clampComplexity = c => Math.min(5, Math.max(1, Math.round(Number(c) || 3)));

export function complexityDirective(level) {
  const c = clampComplexity(level);
  return `COMPLEXITY ${c}/5. ${COMPLEXITY_LEVELS[c]}`;
}
