import { DEFAULT_PREFS } from './schema.js';
import { save, load } from './store.js';

export const getPrefs = (teacherId = 'default') =>
  ({ ...DEFAULT_PREFS, ...(load('teachers', teacherId) || {}), teacherId });

export const putPrefs = (teacherId, patch) =>
  save('teachers', teacherId, { ...getPrefs(teacherId), ...patch, teacherId });

const DENSITY = {
  low: 'Keep text short: at most 2 sentences per paragraph, 2 paragraphs per explain block.',
  medium: 'Use moderate text: 2-3 sentences per paragraph, up to 3 paragraphs per explain block.',
  high: 'Text may be fuller: up to 4 paragraphs per explain block.',
};

/** Teacher preferences as prompt directives, appended to every generation prompt. */
export function prefsDirective(prefs) {
  const lines = [
    DENSITY[prefs.textDensity] || DENSITY.medium,
    prefs.simpleLanguage ? 'Prefer the simplest everyday words even if it costs precision.' : null,
    prefs.tone ? `Tone: ${prefs.tone}.` : null,
  ].filter(Boolean);
  return `TEACHER PREFERENCES\n- ${lines.join('\n- ')}`;
}
