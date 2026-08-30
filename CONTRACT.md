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
  "teacherId": "demo-teacher",
  "spec": { "board":"CBSE","grade":"4","subject":"Mathematics","topic":"Fractions",
            "nLessons":3,"lessonIndex":1,"durationMins":40,"defaultComplexity":3,
            "instructions":"use roti and paper-folding examples" } }
```
→ `{ lesson, html, timeFit }`. `html` is the body-only rendered lesson (embed as-is). `400 MATERIAL_REQUIRED` if `materialId` is missing/unknown.

### `POST /edit-block`  — Path A (per block)
```json
{ "lessonId":"lsn_..","blockId":"b_..","instruction":"use a cricket example","complexity":2 }
```
At least one of `instruction` / `complexity` (the 1–5 slider). **Only that block regenerates**; siblings
stay byte-identical. → `{ block, blockHtml, timeFit }`. Swap just that block's DOM node with `blockHtml`.

### `POST /edit-lesson`  — Path B (conversational)
```json
{ "lessonId":"lsn_..","instruction":"add an assessment at the end" }
```
Handles "add an assessment at the end", "remove blocks 5 and 6", "make suitable for Grade 4", etc.
The model sees **only the outline** (ids/types/summaries) and returns surgical ops; blocks not named in
the ops are **never regenerated**. → `{ lesson, html, changedBlockIds, timeFit, ops, note? }`.
Re-render the whole `html`, or flash just `changedBlockIds`.

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

## Stretch status
- Slideshow mode (`?format=slides`), animated mode, roadmap endpoint, NCERT seed — see README "Stretch".
