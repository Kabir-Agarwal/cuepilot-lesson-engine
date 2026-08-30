// Every test runs fully offline against a scratch data dir.
process.env.LLM_PROVIDER = 'mock';
process.env.DATA_DIR = './data/test';
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALCHEMYST_AI_API_KEY;

export const SPEC = {
  board: 'CBSE', grade: '4', subject: 'Mathematics', topic: 'Fractions',
  nLessons: 3, lessonIndex: 1, durationMins: 45, defaultComplexity: 2,
  instructions: 'Use roti and paper folding examples.',
};

export const MATERIAL = `Fractions for Class 4.
When we break a whole into equal parts each part is a fraction. The denominator says how many
equal parts the whole was broken into. The numerator says how many parts we are talking about.
On a number line from 0 to 1, fourths are four equal hops. 2/4 lands on the same point as 1/2.
When numerators are equal the smaller denominator makes the bigger piece, so 1/3 beats 1/6.
Fold a paper square twice to make four equal squares. Each is one fourth of the paper.`;
