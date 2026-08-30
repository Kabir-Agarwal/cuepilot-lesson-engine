# New engine block types → hg-frontend adapter additions

The engine now emits three new block `type`s. The **rendered content already works in the UI**
(the preview embeds the engine's `html`), so these are only needed to give the block *rail* a
proper title/summary/kind. Until they're added, an unknown type gracefully falls back to the
`concept` kind with a blank label.

## `src/lib/api/engine-types.ts` — extend the union

```ts
export type EngineBlockType =
  | "hook" | "explain" | "number_line" | "bar_compare" | "sequence"
  | "mcq" | "activity" | "exit_ticket" | "teacher_notes"
  | "flowchart" | "pro_tip" | "match_game";   // + these three
```

## `src/lib/api/adapt.ts` — three maps + two switch cases

```ts
// KIND_BY_TYPE — nine → twelve
flowchart: "concept",      // a process/decision diagram you read & follow
pro_tip:   "concept",      // tips & tricks callout
match_game:"interactive",  // a small game students act on

// engineTypeLabel
flowchart:  "Flowchart",
pro_tip:    "Pro Tips",
match_game: "Matching Game",

// REPRESENTATION_TYPES (optional — gives them the manipulable card in the rail)
"flowchart", "match_game",

// titleFor(): add cases
case "flowchart":  return str(d.title) || "Flowchart";
case "pro_tip":    return str(d.label) || "Pro Tips";
case "match_game": return "Matching Game";

// summaryFor(): add cases
case "flowchart": {
  const n = Array.isArray(d.nodes) ? d.nodes.length : 0;
  return n ? `${n}-step process diagram.` : "A process diagram.";
}
case "pro_tip": {
  const n = Array.isArray(d.tips) ? d.tips.length : 0;
  return n ? `${n} quick tip${n === 1 ? "" : "s"}.` : "Tips & tricks.";
}
case "match_game":
  return clamp(str(d.prompt) || "Match the pairs.");
```

## Block `data` shapes (for reference)

```jsonc
// flowchart
{ "title": "How to name a fraction",
  "nodes": [ { "type": "start", "text": "..." },
             { "type": "process", "text": "..." },
             { "type": "decision", "text": "Are the parts equal?", "yes": "Yes", "no": "No" },
             { "type": "end", "text": "..." } ] }   // always has a start + an end

// pro_tip
{ "label": "Pro tips", "tips": ["...", "...", "..."] }

// match_game
{ "prompt": "Match each card to its meaning.",
  "pairs": [ { "left": "1/2", "right": "one of two equal parts" }, ... ] }  // 2–6 pairs
```

`match_game` correctness is inherent: `pairs[i].left` matches `pairs[i].right`. The engine's
renderer shuffles the right column deterministically and pairs them back by index.
