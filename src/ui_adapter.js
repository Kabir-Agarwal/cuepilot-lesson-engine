// src/ui_adapter.js
// Pure mapping: an engine `Lesson` -> the frontend's `LessonModule` UI JSON.
// No I/O, no mutation of the input. Written defensively — a block's `data`
// fields may be missing, so arrays default to [] and strings to "".

const asArray = v => (Array.isArray(v) ? v : []);
const asString = v => (v == null ? '' : String(v));

// One-line summary: collapse whitespace, clamp to ~96 chars.
function oneLine(s, max = 96) {
  const t = asString(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// The 4 pedagogical roles the UI groups blocks by.
const KIND_BY_TYPE = {
  hook: 'hook',
  explain: 'concept',
  teacher_notes: 'concept',
  pro_tip: 'concept',
  number_line: 'interactive',
  bar_compare: 'interactive',
  sequence: 'interactive',
  activity: 'interactive',
  flowchart: 'interactive',
  match_game: 'interactive',
  mcq: 'assessment',
  exit_ticket: 'assessment',
};

// Fixed short labels for types whose title is not drawn from `data`.
const LABEL_BY_TYPE = {
  hook: 'Opening Hook',
  number_line: 'Number Line',
  bar_compare: 'Bar Comparison',
  sequence: 'Step Sequence',
  flowchart: 'Flowchart',
  match_game: 'Matching Game',
  mcq: 'Multiple Choice',
  exit_ticket: 'Exit Ticket',
  teacher_notes: 'Teacher Notes',
};

function uiTitle(type, data) {
  if (type === 'explain') return asString(data.heading) || 'Concept';
  if (type === 'activity') return asString(data.title) || 'Activity';
  if (type === 'pro_tip') return asString(data.label) || 'Pro Tip';
  return LABEL_BY_TYPE[type] || 'Block';
}

function uiSummary(type, data) {
  switch (type) {
    case 'hook': return oneLine(data.text);
    case 'explain': return oneLine(asArray(data.paragraphs)[0]);
    case 'number_line': return oneLine(data.question);
    case 'bar_compare': return oneLine(asString(data.caption) || 'Compare fractions as bars.');
    case 'sequence': return oneLine(`${asArray(data.steps).length}-step walkthrough.`);
    case 'mcq': return oneLine(data.question);
    case 'activity': return oneLine(asArray(data.instructions)[0] || 'A hands-on task.');
    case 'exit_ticket': return oneLine(`${asArray(data.questions).length} exit question(s).`);
    case 'teacher_notes': return oneLine(`${asArray(data.points).length} teaching note(s).`);
    case 'flowchart': return oneLine(asString(data.title) || `${asArray(data.nodes).length}-step process.`);
    case 'pro_tip': return oneLine(asArray(data.tips)[0] || 'Quick tips and common mistakes.');
    case 'match_game': return oneLine(asString(data.prompt) || 'Match the pairs.');
    default: return '';
  }
}

function uiBody(type, data) {
  if (type === 'hook') return [asString(data.text)];
  if (type === 'explain') return asArray(data.paragraphs).map(asString);
  if (type === 'teacher_notes') return asArray(data.points).map(asString);
  if (type === 'pro_tip') return asArray(data.tips).map(asString);
  return null;
}

function uiFigure(type, data) {
  switch (type) {
    case 'number_line':
      return {
        kind: 'number_line',
        min: data.min ?? 0,
        max: data.max ?? 1,
        step: data.step ?? 1,
        marks: asArray(data.marks).map(m => ({ value: m?.value, label: asString(m?.label) })),
        question: asString(data.question),
      };
    case 'bar_compare':
      return {
        kind: 'bars',
        items: asArray(data.items).map(i => ({
          label: asString(i?.label),
          numerator: i?.numerator,
          denominator: i?.denominator,
        })),
        caption: asString(data.caption),
      };
    case 'sequence':
      return {
        kind: 'flow',
        steps: asArray(data.steps).map(s => ({ title: asString(s?.title), text: asString(s?.text) })),
      };
    case 'mcq':
      return {
        kind: 'mcq',
        question: asString(data.question),
        options: asArray(data.options).map(asString),
        answerIndex: data.answerIndex ?? 0,
        explanation: asString(data.explanation),
      };
    case 'activity':
      return {
        kind: 'checklist',
        title: asString(data.title),
        items: asArray(data.instructions).map(asString),
      };
    case 'exit_ticket':
      return {
        kind: 'checklist',
        items: asArray(data.questions).map(asString),
      };
    case 'flowchart':
      // The engine's decision-flowchart nodes -> the UI's `flow` figure, which
      // renders as a numbered flowchart. Decision branches fold into the text.
      return {
        kind: 'flow',
        steps: asArray(data.nodes).map(n => {
          const role = asString(n?.type) || 'step';
          const title = role.charAt(0).toUpperCase() + role.slice(1);
          let text = asString(n?.text);
          if (role === 'decision') {
            const branches = [
              asString(n?.yes) && `Yes → ${asString(n.yes)}`,
              asString(n?.no) && `No → ${asString(n.no)}`,
            ].filter(Boolean).join('   ·   ');
            if (branches) text = text ? `${text}  (${branches})` : branches;
          }
          return { title, text };
        }),
      };
    case 'match_game':
      return {
        kind: 'checklist',
        title: asString(data.prompt),
        items: asArray(data.pairs).map(
          p => `${asString(p?.left)} ↔ ${asString(p?.right)}`,
        ),
      };
    default:
      return null;   // hook, explain, teacher_notes, pro_tip carry `body`, not a figure
  }
}

function toUiBlock(block, visualDemand) {
  const type = block?.type;
  const data = block?.data || {};
  const summary = uiSummary(type, data);
  const narration = asString(block?.narration).trim();

  const ui = {
    id: block?.id,
    kind: KIND_BY_TYPE[type] || 'concept',
    title: uiTitle(type, data),
    summary,
    instruction: narration || summary,
    complexity: block?.complexity,
    visualDemand,
  };
  const body = uiBody(type, data);
  if (body) ui.body = body;
  const figure = uiFigure(type, data);
  if (figure) ui.figure = figure;
  return ui;
}

export function toUiModule(lesson) {
  const l = lesson || {};
  const tf = l.timeFit || {};
  const timeNote = tf.ok
    ? `Fits ~${tf.plannedMins} of ${l.durationMins} min`
    : (tf.suggestion || tf.notice || 'Over the time budget.');
  const visualDemand = l.visualDemand ?? 3;

  return {
    id: l.id,
    title: l.title,
    headline: l.title,
    subheadline: `${l.board} · Grade ${l.grade} · ${l.subject}`,
    grade: `Grade ${l.grade}`,
    subject: l.subject,
    durationMinutes: l.durationMins,
    timeNote,
    blocks: asArray(l.blocks).map(b => toUiBlock(b, visualDemand)),
  };
}

export default { toUiModule };
