# Lesson Engine — API Contract (for the UI teammate)

Backend base URL: `http://localhost:3000`. All bodies JSON unless noted. The backend owns lesson
generation, RAG grounding, rendering, and both edit paths. **The LLM never writes HTML** — you get
a lesson JSON (the truth) plus deterministic, XSS-safe rendered HTML you can drop straight into the page.

## Setup

```
npm install
cp .env.example .env      # keys optional — empty is fine, runtime falls back to mock
npm start                 # http://localhost:3000  (internal test page at /)
npm test                  # 20 tests
npm run checkkeys         # probes Gemini + Alchemyst; empty key = SKIP
npm run realrun           # one real Gemini e2e -> fixtures/real-run.json (SKIP if no key)
```

`LLM_PROVIDER=mock` (or any missing/invalid key) runs the whole app with **no network** — same shapes,
canned deterministic content. This is the demo safety net.

## Golden rule for the UI: upload first

**No upload, no lesson.** Every lesson is grounded in one uploaded material. `POST /generate` without a
known `materialId` returns `400 {code:"MATERIAL_REQUIRED"}`. Flow: `/ingest` → get `materialId` →
`/generate`.

---

## Endpoints

### `POST /ingest`  (multipart/form-data)
Upload teacher material (`.txt`, `.md`, `.pdf`). **All four metadata fields are required.**

| field | required | notes |
|-------|----------|-------|
| `file` | yes | .txt / .md / .pdf, ≤20MB |
| `teacherId` | yes | groups a teacher's materials |
| `subject` | yes | |
| `board` | yes | |
| `grade` | yes | |
| `attribution` | no | citation string; default `Teacher upload, <filename>` |

→ `200 {materialId, name, chars, chunks}` · missing field → `400 {error, code:"MATERIAL_METADATA_REQUIRED"}`

### `GET /materials?teacherId=<id>`
→ `{materials: [{id, teacherId, subject, board, grade, filename, uploadedAt, chunks}]}` (newest first).
Omit `teacherId` for all materials.

### `POST /generate`
```json
{ "materialId": "mat_ab12cd34",
  "materialIds": ["mat_ab12cd34", "mat_ef56gh78"],
  "teacherId": "demo-teacher",
  "stream": false,
  "spec": { "board":"CBSE","grade":"4","subject":"Mathematics","topic":"Fractions",
            "nLessons":3,"lessonIndex":1,"durationMins":40,"defaultComplexity":3,
            "instructions":"use roti and paper-folding examples",
            "requestedBlocks":["hook","explain","mcq","exit_ticket"] } }
```
→ `{ lesson, html, timeFit }`. `html` is the body-only rendered lesson (embed as-is). `400 MATERIAL_REQUIRED` if `materialId`/`materialIds` missing or unknown.

- **`materialIds[]`** (multi-resource): pass several material ids instead of one. They must share the same `teacherId` and `subject`, else `400 MATERIAL_MISMATCH`. Retrieval merges across them but stays strictly scoped to that set. A single `materialId` behaves exactly as before.
- **`spec.requestedBlocks[]`** (optional): pin the exact block types, in order. Unknown type → `400 BAD_BLOCK_TYPE`. When present, the generated set equals the requested set (no time-dropping).
- **`spec.visualDemand`** 1–5 (optional, default 3): representation **density**, independent of `defaultComplexity` (which is language depth). 1 = text-first (prose dominates); 3 = balanced; 5 = visual-first (every concept gets a representation/interactive, explains compressed to captions). It shifts the planner's block-type mix and is injected into every generation prompt. Stored on the lesson. Teacher default: `prefs.defaultVisualDemand`.
- **`stream: true`** → the response is an **SSE** stream (`content-type: text/event-stream`). Events (one JSON per `data:` line):
  `{"step":"retrieving"}` → `{"step":"planning"}` → `{"step":"provider","model":"gemini-flash-latest"}` → `{"step":"block","i":k,"n":total,"type":"..."}` (per block) → `{"step":"verifying","cycle":1}` (only if the verifier is on) → `{"step":"rendering"}` → `{"done":true,"lessonId":"...","lesson":{...},"html":"...","timeFit":{...}}`. On failure: `{"error":"...","code":"..."}`. The `provider` event names which model (or `mock`) actually answered.

  **Consuming the SSE (POST → EventSource won't work; read the fetch body stream):**
  ```js
  const res = await fetch('/generate', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ materialId, teacherId, spec, stream:true }) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream:true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data:')); buf = buf.slice(i + 2);
      if (line) { const ev = JSON.parse(line.slice(5).trim());
        if (ev.step === 'block') updateBar(ev.i, ev.n);          // "block k/n — X%"
        else if (ev.done) render(ev.html); }
    }
  }
  ```

### `POST /lessons/:id/reorder`
```json
{ "blockIds": ["b_2","b_0","b_1", "..."] }
```
Must be a **permutation** of the lesson's existing block ids (`400 BAD_PERMUTATION` otherwise). No LLM — same block objects, new order, persisted. → `{ lesson, html, timeFit }`. The UI does the drag-drop and calls this to save the new order.

### `POST /edit-block`  — Path A (per block)
```json
{ "lessonId":"lsn_..","blockId":"b_..","instruction":"use a cricket example","complexity":2,"visualDemand":5 }
```
At least one of `instruction` / `complexity` (1–5 language slider) / `visualDemand` (1–5 density slider).
**Only that block regenerates**; siblings stay byte-identical. A high `visualDemand` on a prose block may
**retype** it to a representation (and a low one on a visual block toward `explain`) via the existing retype
path — still only that block changes. → `{ block, blockHtml, timeFit }`. Swap just that block's DOM node with `blockHtml`.

### `POST /edit-lesson`  — Path B (conversational)
```json
{ "lessonId":"lsn_..","instruction":"add an assessment at the end", "stream": false }
```
Handles "add an assessment at the end", "remove blocks 5 and 6", "make suitable for Grade 4", etc.
The model sees **only the outline** (ids/types/summaries) and returns surgical ops; blocks not named in
the ops are **never regenerated**. → `{ lesson, html, changedBlockIds, timeFit, ops, note? }`.
Re-render the whole `html`, or flash just `changedBlockIds`. With `stream:true` it emits the same SSE
events (each op as `{"step":"op",...}`) ending in the `done` event above.

### `POST /lessons/:id/duplicate` → `{ lesson }` (fresh ids, title + " (copy)")
### `GET /lessons` → `{ lessons: [{id,title,grade,subject,topic,blocks,durationMins}] }`
### `GET /lessons/:id` → `{ lesson, html, timeFit }` · `?format=html` → full standalone HTML page
### `GET /prefs/:teacherId` · `PUT /prefs/:teacherId` → `{ prefs }`
### `GET /health` → `{ ok, provider, llm, rag }` (provider is `mock` when no key)
### `GET /lesson.css` · `GET /lesson.js` — the renderer's stylesheet + interaction script

---

## Data shapes

**Lesson**
```
{ id, title, board, grade, subject, topic, nLessons, lessonIndex,
  durationMins, defaultComplexity, instructions, teacherId, materialId,
  timeFit: { plannedMins, ok, overBy?, suggestion?, notice? },
  blocks: [ Block ] }
```

**Block** — `{ id, type, data, complexity:1-5, estMinutes, sourceRefs:[{sourceId,sourceName,attribution}], narration }`

**Block types & `data`**
| type | data |
|------|------|
| `hook` | `{text}` |
| `explain` | `{heading, paragraphs[]}` |
| `number_line` | `{min,max,step,marks:[{value,label}],question}` |
| `bar_compare` | `{items:[{label,numerator,denominator}],caption}` |
| `sequence` | `{steps:[{title,text}]}` |
| `mcq` | `{question,options[4],answerIndex,explanation}` |
| `activity` | `{title,instructions[],materials[]}` |
| `exit_ticket` | `{questions[]}` |
| `teacher_notes` | `{points[]}` |

**timeFit** — `ok:false` carries `overBy` (minutes) and a `suggestion` (e.g. move a block to homework).
Nothing is ever auto-trimmed; both edit paths recompute it.

**Citations** — every block renders a footer `Source: <attribution>` and a `C<n>` complexity badge,
sourced from the chunks that actually fed it.

---

## Embedding the rendered HTML

**Plain page**
```html
<link rel="stylesheet" href="http://localhost:3000/lesson.css">
<div id="lesson"></div>
<script src="http://localhost:3000/lesson.js"></script>
<script>
  const r = await fetch('http://localhost:3000/generate', { method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({ materialId, teacherId, spec }) }).then(r=>r.json());
  document.getElementById('lesson').innerHTML = r.html;   // interactions self-wire via lesson.js
</script>
```

**React**
```jsx
useEffect(() => { const l = document.createElement('script'); l.src='http://localhost:3000/lesson.js';
  document.body.appendChild(l); }, []);
// <link rel="stylesheet" href="http://localhost:3000/lesson.css"/> once in <head>
<div dangerouslySetInnerHTML={{ __html: r.html }} />   // html is already escaped/XSS-safe
```
For a per-block edit, replace only that block's node using `blockHtml` (match `[data-block-id="..."]`).

---

## Mock mode

Set `LLM_PROVIDER=mock` (or just leave keys empty). Every endpoint returns valid, deterministic content
with no network — safe for the demo if the internet or a key dies mid-presentation.

## Architecture

```
orchestrator (engine.generateLesson)
  → context pipeline (rag.retrieve — per block, authority-weighted, strictly material-scoped)
  → planner (block spine for THIS lesson; honours spec.requestedBlocks verbatim)
  → sequential block agents (filler.fillBlock — fresh retrieval + citations per block)
  → validation (schema.validateBlock on every block)
     → optional verifier agent (VERIFY_PASS=on): reviews the OUTLINE, emits edit ops
       through the SAME op executor → untouched blocks byte-identical → re-fit time
  → deterministic renderers (document / slides)  ·  iteration loop = editBlock / editLesson / reorder
```

- **LLM model chain** — on first use the engine calls Gemini **ListModels** and orders the available
  `generateContent` models: `gemini-flash-latest` → `gemini-flash-lite-latest` → newest `*flash*`. Nothing
  is hardcoded. Per call: chosen model (backoff ×3 on 429/503) → next model in the chain once → **mock**.
  The `provider` SSE event reports which one answered. `GET /health` returns the resolved `modelChain`.
- **Verifier flag** — `VERIFY_PASS=on` (default off) with `VERIFY_MAX_CYCLES=1` (hard cap 3). Off by default,
  so ordinary generation is unchanged. These belong in `.env`.

## Stretch status
- Slideshow mode (`?format=slides`), animated mode, roadmap endpoint, NCERT seed — see README "Stretch".
