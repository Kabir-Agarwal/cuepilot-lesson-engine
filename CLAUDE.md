# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                 # node server.js -> http://localhost:3000 (internal test page at /)
npm test                  # node --test "test/*.test.js"  (all tests, forced offline/mock)
npm run checkkeys         # probe Gemini + Alchemyst keys (empty key = SKIP)
npm run realrun           # one real Gemini e2e -> fixtures/real-run.json (SKIP if no key)
npm run seed              # optional: seed one NCERT chapter as curriculum_authority

node --test test/engine.test.js                              # a single test file
node --test --test-name-pattern="byte-identical" test/*.test.js   # tests matching a name
```

ESM only (`"type":"module"`), Node >=18, native `fetch`, `node:test`. No build step, no linter configured. Env comes from `.env` (git-ignored; copy `.env.example`). With no keys the whole app runs in **mock** mode — same shapes, canned deterministic content, zero network.

`test/setup.js` forces `LLM_PROVIDER=mock` and `DATA_DIR=./data/test`, and deletes all API keys — every test runs fully offline. Import it (for `SPEC`/`MATERIAL`) before touching engine modules.

## The one rule that shapes everything

**The LLM only ever emits JSON. Deterministic, XSS-safe renderers produce all HTML.** `src/render/index.js` (document mode) and `src/render/slides.js` (slideshow) `esc()` every model-authored string. Never let model output reach the DOM unrendered, and never add an HTML-generating path to the LLM prompts.

## Architecture

Request flow for `POST /generate` (`src/engine.js::generateLesson`):

```
resolveMaterialIds (no upload -> 400 MATERIAL_REQUIRED)
  -> retrieve seed chunks (rag.js)
  -> plan block spine for THIS lesson (planner.js)     # honours spec.requestedBlocks verbatim
  -> fillBlock per block (filler.js)                   # FRESH retrieval per block -> citations
  -> optional verifier pass (verifier.js, VERIFY_PASS=on)
  -> fitCheck time budget (timebudget.js)
  -> save (store.js) + validateLesson (schema.js)
```

Key invariants and non-obvious wiring:

- **`completeJSON` (`src/llm.js`) is the single LLM door.** All model calls go through it. It serialises every call on one global promise queue (500ms gap), does 429/5xx backoff ×3, one JSON repair-retry, and — critically — **falls back to the caller-supplied `mock` value on any failure rather than throwing**. So a dead key or 503 degrades to mock content mid-request instead of a 500. `provider()` returns `'mock'` whenever the selected provider's key is missing. Planner/filler/editLesson each *also* catch and degrade to mock as a second belt.
- **Model selection is dynamic.** On first Gemini use, `resolveModelChain()` calls ListModels and orders available models (`gemini-flash-latest` -> `gemini-flash-lite-latest` -> newest `*flash*`). Nothing is hardcoded. A daily-quota 429 short-circuits the whole chain straight to mock (retrying a shared exhausted quota just hammers it).
- **`executeOps` (`src/engine.js`) is the ONE place a lesson mutates via ops**, shared by `editLesson` (Path B) and the verifier. Untouched blocks are the **same object references** (never regenerated) — this byte-identity guarantee is tested repeatedly and must be preserved. `editBlock` (Path A) mutates exactly one array index the same way.
- **Fresh per-block retrieval.** `fillBlock` retrieves for each block's own intent, so `sourceRefs` reflect the chunks that actually fed it — and an edited block is re-grounded against its NEW intent.
- **RAG is material-scoped, always.** `rag.js` tries Alchemyst (best-effort, per-material group), falls back to a local keyword index, and re-enforces `materialIds` scoping client-side even if Alchemyst leaks. Rank = similarity × `AUTHORITY_WEIGHT` (teacher_upload > curriculum_authority > other). The local `store` Map is rehydrated from saved chunks on restart via `ensureMaterials`.
- **Two orthogonal sliders**, both 1–5, both injected verbatim into prompts (making them auditable via `getLastPrompt()`): `defaultComplexity` (language depth, `complexity.js`) and `visualDemand` (representation density, `visual.js`). `visualDemand` also shifts the planner's block-type mix (`SHAPE_BY_VISUAL`) and can **retype** a block prose<->visual on `editBlock`.
- **Progress via AsyncLocalStorage** (`src/progress.js`). `emitStep()` is a no-op unless an SSE handler bound an emitter with `withProgress` — so engine/planner/llm emit stream events without threading an emitter through their signatures. Streaming endpoints (`stream:true`) wrap the same core functions.
- **Time budgeting never silently trims** (`timebudget.js`). Over-budget lessons carry `timeFit.ok:false` with `overBy` + a `suggestion`; planned-but-unfit blocks surface as `timeFit.notice`.
- **Persistence** is flat-file JSON under `./data/{materials,lessons,teachers}/<id>.json` (`store.js`). The server exports `app` and only binds a port when run directly, so tests import it in-process.

## Adding a new block type

Touch all of these or validation/rendering will break:
`schema.js` (`BLOCK_TYPES` + `DATA_RULES`), `filler.js` (`SHAPES` + `mockData`), `render/index.js` (`BODY` + `BLOCK_LABEL` + `ICONS`, plus `STYLES`/`SCRIPT` if interactive), `timebudget.js` (`BASE_MINUTES`), and if it's a representation type, `visual.js` (`VISUAL_TYPES`/`PROSE_TYPES`) and the planner shapes. Then mirror the type in the frontend adapter — see `docs/NEW_BLOCK_TYPES.md`.

The current set is 12 types: the original 9 plus `flowchart` (process/decision diagram), `pro_tip` (tips callout), and `match_game` (click-to-match game). MCQs are generated **correct-by-construction** in `filler.js` (`makeMcq`/`assembleMcq`): the model returns `{correctAnswer, distractors[]}`, the engine builds `options` and computes `answerIndex`, and a live `verifyMcq` pass re-checks the answer against the material.

## Reference

`README.md` — run/how-it-works overview. `CONTRACT.md` — the full HTTP API contract, data shapes, and embed recipes (source of truth for the UI teammate). `fixtures/sample-lesson.json` — a valid lesson covering all 9 block types.
