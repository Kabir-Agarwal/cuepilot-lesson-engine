# Cuepilot Lesson Engine (backend)

Upload teacher material → generate a web-native, scrollable, interactive lesson grounded **only**
in that material, with visible citations, fitted to the class clock — then edit it two ways:
per-block (prompt or a 1–5 simple↔complex slider) or lesson-level conversation ("add an assessment
at the end", "remove blocks 5 and 6", "make suitable for Grade 4"). Untouched blocks stay
byte-identical. Full API + embed recipes in **[CONTRACT.md](CONTRACT.md)**.

## Run

```bash
npm install
cp .env.example .env     # keys optional; empty = mock mode (no network, demo-safe)
npm start                # http://localhost:3000  — internal test page at /
npm test                 # 23 tests
npm run checkkeys        # probe Gemini + Alchemyst (empty key = SKIP)
npm run realrun          # one real Gemini e2e -> fixtures/real-run.json (SKIP if no key)
npm run seed             # optional: seed one NCERT chapter (skip-on-fail)
```

The owner pastes `GEMINI_API_KEY` / `ALCHEMYST_AI_API_KEY` into `.env` by hand. With no key the
runtime falls back to `mock`: same shapes, canned deterministic content, zero network.

**`.env` keys** (all optional; empty = mock/local fallback):
```
LLM_PROVIDER=gemini        # gemini | anthropic | mock
GEMINI_API_KEY=            # owner pastes
ALCHEMYST_AI_API_KEY=      # owner pastes; empty = local keyword RAG
ANTHROPIC_API_KEY=
VERIFY_PASS=               # "on" enables the verifier agent (default off)
VERIFY_MAX_CYCLES=1        # verifier passes, hard-capped at 3
```

**Model selection is automatic** — the engine calls Gemini ListModels and picks the best available
flash model (`gemini-flash-latest` → `gemini-flash-lite-latest` → newest `*flash*`), falling through
the chain and finally to mock on 429/503. Nothing is hardcoded; `GET /health` shows the resolved chain.

**Streaming, reorder, multi-resource, requested blocks, verifier** — see [CONTRACT.md](CONTRACT.md).

**Two independent sliders.** `defaultComplexity` 1–5 sets *language depth*; `visualDemand` 1–5 sets
*representation density* (1 = text-first → 5 = visual-first, shifting the block-type mix). Both are
lesson-wide on `/generate` and per-block on `/edit-block` (a high per-block `visualDemand` can even
retype a prose block into a representation). Teacher defaults: `defaultComplexity`, `defaultVisualDemand`.

## How it works

`ingest` → 1200-char chunks (15% overlap) with authority-tagged metadata. `generateLesson` plans a
block spine for *this* lesson in the sequence, fits it to `durationMins` (10% slack, nothing
silently trimmed), then fills each block with a **fresh per-block retrieval** so citations reflect
the chunks actually used. `editBlock` regenerates one block; `editLesson` sees only the outline and
returns surgical ops (`add`/`remove`/`edit`/`retype`/`global`). The LLM only ever writes lesson
JSON — deterministic, XSS-safe renderers turn it into HTML.

- **Blocks:** hook, explain, number_line, bar_compare, sequence, mcq, activity, exit_ticket, teacher_notes
- **RAG:** Alchemyst (grouped per material) when a key is present; local keyword fallback otherwise, always material-scoped
- **Renderers:** document mode (`/lessons/:id?format=html`), slideshow (`?format=slides`), plus `/lesson.css` + `/lesson.js` for embedding

## Stretch

- **S1 slideshow** — `?format=slides`: one block per slide, prev/next, Play reads block narration via `speechSynthesis`
- **S2 animated** — interactives autoplay on slide entry
- **S3 roadmap** — `POST /roadmap` → an ordered multi-lesson plan
- **S4 NCERT seed** — `npm run seed` ingests one chapter as `curriculum_authority`

## Layout

```
src/schema.js complexity.js timebudget.js llm.js pdf.js rag.js prefs.js planner.js filler.js engine.js store.js
src/render/index.js  (document mode)   src/render/slides.js  (slideshow)
server.js  demo/index.html  scripts/{check_keys,real_run,seed_ncert}.js  test/*.test.js
```
