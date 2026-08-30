// Time budgeting. Never silently trims teacher content — it warns and suggests.
export const BASE_MINUTES = {
  hook: 3, explain: 8, number_line: 5, bar_compare: 5, sequence: 6,
  mcq: 4, activity: 12, exit_ticket: 4, teacher_notes: 0,
  flowchart: 5, pro_tip: 2, match_game: 6,
};

export function gradeFactor(grade) {
  const g = parseInt(String(grade).replace(/\D/g, ''), 10);
  if (!Number.isFinite(g)) return 1.0;
  if (g <= 3) return 1.4;
  if (g <= 6) return 1.2;
  if (g <= 9) return 1.0;
  return 0.9;
}

export const estMinutesFor = (type, grade) =>
  Math.round((BASE_MINUTES[type] ?? 5) * gradeFactor(grade) * 10) / 10;

export const plannedMinutes = blocks =>
  Math.round(blocks.reduce((s, b) => s + (Number(b.estMinutes) || 0), 0) * 10) / 10;

/** Fits a planned block-type list into durationMins (10% slack). Returns the kept types. */
export function fitPlan(types, durationMins, grade) {
  const budget = durationMins * 1.1;
  const kept = [];
  let total = 0;
  for (const t of types) {
    const m = estMinutesFor(t, grade);
    if (total + m > budget && kept.length > 0 && t !== 'teacher_notes') continue;
    kept.push(t);
    total += m;
  }
  return kept;
}

const SUGGESTIONS = {
  activity: 'move the activity to homework or shorten it to a 5-minute pair task',
  explain: 'split the longest explain block across two lessons',
  sequence: 'turn the sequence into a printed handout the class reads at home',
};

export function fitCheck(blocks, durationMins) {
  const planned = plannedMinutes(blocks);
  const slack = durationMins * 1.1;
  if (planned <= slack) return { plannedMins: planned, ok: true };
  const overBy = Math.round((planned - durationMins) * 10) / 10;
  // Suggest trimming the single most expensive block, never trim it ourselves.
  const worst = [...blocks].sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0))[0];
  const hint = worst ? (SUGGESTIONS[worst.type] || `shorten the ${worst.type} block`) : 'remove one block';
  return {
    plannedMins: planned,
    ok: false,
    overBy,
    suggestion: `This lesson runs about ${overBy} min over ${durationMins} min. Nothing was removed. Suggestion: ${hint}.`,
  };
}
