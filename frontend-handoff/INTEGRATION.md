# Lesson Engine — Frontend Integration Guide

Everything the frontend needs, screen by screen, mapped to API calls. The backend owns generation,
RAG, rendering, and edits; **you never build lesson HTML yourself** — the API returns ready-to-embed,
XSS-safe HTML plus the lesson JSON (the source of truth).

- **BASE URL:** `http://localhost:3000` (see §L for another laptop).
- **CORS:** fully open (any origin/header/method, preflight handled) — call every endpoint from any origin.
- **Mock mode:** with no API keys the backend runs deterministic mock content, zero network. Same shapes.
  This is the safe demo mode. See `examples/` for real request/response captures.

---

## A. Screen flow (teacher journey)

```
Upload ─▶ Materials list ─▶ Lesson setup ─▶ Generate (progress) ─▶ Lesson view
                                                                      │
        ┌─────────────────────────────────────────────┬─────────────┤
        ▼                        ▼                      ▼             ▼
   Per-block edit         Lesson chat edit         Drag-drop      3 view modes
   (sliders/prompt)       (conversational)         + Save order   (doc/slides/animated)
        │
        └─▶ Library (list / reopen / duplicate) ─▶ Prefs
```

---

## (a) Upload screen → `POST /ingest`

`multipart/form-data`. **All fields required.** Accepts `.txt`, `.md`, `.pdf` (≤20 MB).

| field | type | notes |
|-------|------|-------|
| `file` | File | the material |
| `teacherId` | string | groups this teacher's materials |
| `subject` | string | e.g. "Mathematics" |
| `board` | string | e.g. "CBSE" |
| `grade` | string | e.g. "4" |
| `attribution` | string (optional) | citation label; default `Teacher upload, <filename>` |

```js
const fd = new FormData();
fd.append('file', fileInput.files[0]);
fd.append('teacherId', 'demo-teacher');
fd.append('subject', 'Mathematics');
fd.append('board', 'CBSE');
fd.append('grade', '4');
const { materialId } = await fetch(BASE + '/ingest', { method: 'POST', body: fd }).then(r => r.json());
```
**Response:** `{ "materialId": "mat_ab12cd34", "name": "fractions.txt", "chars": 436, "chunks": 1 }`
**Error:** missing `teacherId`/`subject`/`board`/`grade` → `400 { error, code: "MATERIAL_METADATA_REQUIRED" }`.
See `examples/ingest.request.md` + `examples/ingest.response.json`.

## (b) Materials list → `GET /materials?teacherId=<id>`

```
GET /materials?teacherId=demo-teacher
→ { "materials": [ { id, teacherId, subject, board, grade, filename, uploadedAt, chunks } ] }  // newest first
```
Omit `teacherId` for all materials. `examples/materials.response.json`.

## (c) Lesson setup form → the `spec` object

Every field, with control type / range / default:

| field | control | range / values | default | required |
|-------|---------|----------------|---------|----------|
| `board` | text | — | "CBSE" | ✓ |
| `grade` | text/number | e.g. 1–12 | "4" | ✓ |
| `subject` | text | — | "Mathematics" | ✓ |
| `topic` | text | — | — | ✓ |
| `nLessons` | number | ≥ 1 | 1 | ✓ |
| `lessonIndex` | number | 1 … nLessons | 1 | ✓ |
| `durationMins` | number | ≥ 5 | 40 | ✓ |
| `defaultComplexity` | slider | 1–5 (**language depth**) | 3 | — |
| `visualDemand` | slider | 1–5 (**representation density**) | 3 | — |
| `instructions` | textarea | free text | "" | — |
| `requestedBlocks` | multiselect | any of the block types below, in order | — (auto-plan) | — |
| `materialIds` | array | 1+ material ids (same teacher+subject) | `[materialId]` | ✓ (id or ids) |

**`defaultComplexity` and `visualDemand` are independent axes.** Complexity = how hard the *language* is;
visualDemand = how much of the lesson is carried by *representations/interactives* vs prose (1 text-first
→ 5 visual-first).

**Block types** (for `requestedBlocks`): `hook`, `explain`, `number_line`, `bar_compare`, `sequence`,
`mcq`, `activity`, `exit_ticket`, `teacher_notes`. Unknown type → `400 BAD_BLOCK_TYPE`.

**Multi-resource:** pass `materialIds: ["mat_a","mat_b"]` instead of a single `materialId`. They must share
the same `teacherId` and `subject`, else `400 MATERIAL_MISMATCH`. Retrieval merges but stays scoped to them.

## (d) Generate → `POST /generate`

### Non-stream
```json
{ "materialId": "mat_ab12cd34", "teacherId": "demo-teacher",
  "spec": { "board":"CBSE","grade":"4","subject":"Mathematics","topic":"Fractions",
            "nLessons":3,"lessonIndex":1,"durationMins":45,"defaultComplexity":2,"visualDemand":3,
            "instructions":"use roti examples","requestedBlocks":["hook","explain","mcq","exit_ticket"] } }
```
**Response:** `{ "lesson": {...}, "html": "<section class=\"lesson\">…</section>", "timeFit": {...} }`
`400 MATERIAL_REQUIRED` if `materialId`/`materialIds` missing or unknown.
See `examples/generate.request.json` + `examples/generate.response.json`.

### Stream mode (`"stream": true`) — live progress bar
The response is **SSE** (`content-type: text/event-stream`). Note: **`EventSource` cannot POST**, so read
the fetch body stream yourself. Event table (one JSON per `data:` line):

| event | when | fields |
|-------|------|--------|
| `{"step":"retrieving"}` | RAG starts | `materials` (count) |
| `{"step":"planning"}` | block spine being planned | — |
| `{"step":"provider",...}` | a model answered | `provider`, `model` (or `"mock"`) |
| `{"step":"block",...}` | each block generated | `i`, `n`, `type` → show "block i/n — X%" |
| `{"step":"verifying"}` | only if verifier on | `cycle` |
| `{"step":"rendering"}` | HTML being built | — |
| `{"done":true,...}` | finished | `lessonId`, `lesson`, `html`, `timeFit` |
| `{"error":...}` | failure | `error`, `code` |

```js
const res = await fetch(BASE + '/generate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ materialId, teacherId, spec, stream: true }),
});
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf('\n\n')) >= 0) {
    const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data:')); buf = buf.slice(i + 2);
    if (!line) continue;
    const ev = JSON.parse(line.slice(5).trim());
    if (ev.step === 'block') setProgress(Math.round(ev.i / ev.n * 100), `block ${ev.i}/${ev.n} — ${ev.type}`);
    else if (ev.step === 'provider') showModel(ev.model);
    else if (ev.done) { render(ev.html); lesson = ev.lesson; }
    else if (ev.error) showError(ev.error);
  }
}
```
Full transcript: `examples/generate.sse-transcript.txt`.

## (e) Lesson view → render the returned `html`

The `html` field is a self-contained, escaped `<section class="lesson">…</section>`. Load the shared
stylesheet + interaction script once, then drop the HTML in.

```html
<link rel="stylesheet" href="http://localhost:3000/lesson.css">
<div id="lesson"></div>
<script src="http://localhost:3000/lesson.js"></script>
```
**Plain JS:** `document.getElementById('lesson').innerHTML = resp.html;` (interactions self-wire via lesson.js).
**React:**
```jsx
// once in <head>: <link rel="stylesheet" href={BASE + '/lesson.css'} />
useEffect(() => { const s = document.createElement('script'); s.src = BASE + '/lesson.js'; document.body.appendChild(s); }, []);
<div dangerouslySetInnerHTML={{ __html: resp.html }} />   // already XSS-safe
```

**Three view modes** (full standalone pages) — open in an iframe/new tab:
```
GET /lessons/:id?mode=document     scrollable page (default)
GET /lessons/:id?mode=slideshow    one block per slide, prev/next, Play (speechSynthesis narration)
GET /lessons/:id?mode=animated     slideshow that auto-plays: interactives + narration auto-advance
```
(Legacy aliases `?format=html` = document, `?format=slides` = slideshow still work.)
Without `mode`, `GET /lessons/:id` returns JSON `{ lesson, html, timeFit }`.

## (f) Per-block controls → `POST /edit-block`

At least one of `instruction` / `complexity` / `visualDemand` (else `400`).
```json
{ "lessonId":"lsn_..","blockId":"b_..","instruction":"use a cricket example","complexity":2,"visualDemand":5 }
```
**Only that block regenerates.** A high `visualDemand` on a prose block may **retype** it into a
representation (and low on a visual block toward `explain`) — still only that block changes.
**Response:** `{ block, blockHtml, timeFit }` → replace just that block's DOM node with `blockHtml`
(match `[data-block-id="<id>"]`). `examples/edit-block.request.json` + `.response.json`.

## (g) Lesson-level chat edit → `POST /edit-lesson`

```json
{ "lessonId":"lsn_..","instruction":"add an assessment at the end", "stream": false }
```
Handles "add an assessment at the end", "remove blocks 5 and 6", "make suitable for Grade 4", etc.
Blocks **not named** in the derived ops stay byte-identical.
**Response:** `{ lesson, html, changedBlockIds, timeFit, ops, note? }` — re-render the whole `html`, or flash
just `changedBlockIds`. With `"stream": true` you get the same SSE events (`{"step":"op",...}`) ending in `done`.

## (h) Drag-drop reorder → `POST /lessons/:id/reorder`

Reorder in the UI locally; on **Save**, send the new full id order (must be a permutation of the existing ids).
```json
{ "blockIds": ["b_2","b_0","b_1"] }
```
No LLM, same block objects, persisted. → `{ lesson, html, timeFit }`. Bad order → `400 BAD_PERMUTATION`.

## (i) Library → list / reopen / duplicate

```
GET  /lessons                     → { lessons: [{ id, title, grade, subject, topic, blocks, durationMins }] }
GET  /lessons/:id                 → { lesson, html, timeFit }
POST /lessons/:id/duplicate       → { lesson }   // fresh ids, title + " (copy)"
```

## (j) Prefs screen → `GET` / `PUT /prefs/:teacherId`

```
GET /prefs/demo-teacher → { prefs: { teacherId, textDensity, simpleLanguage, tone, defaultComplexity, defaultVisualDemand } }
PUT /prefs/demo-teacher  body: { defaultComplexity: 4, defaultVisualDemand: 5, textDensity: "low", simpleLanguage: true, tone: "warm" }
```
`textDensity` ∈ `low|medium|high`; `defaultComplexity` / `defaultVisualDemand` 1–5; `simpleLanguage` bool.
These become the defaults for that teacher's future generations.

## (k) Error table

| HTTP | `code` | meaning | fix |
|------|--------|---------|-----|
| 400 | `MATERIAL_REQUIRED` | generate without a known `materialId`/`materialIds` | upload first, pass the id |
| 400 | `MATERIAL_METADATA_REQUIRED` | ingest missing `teacherId`/`subject`/`board`/`grade` | send all four |
| 400 | `MATERIAL_MISMATCH` | `materialIds[]` span different teacher/subject | use one teacher+subject set |
| 400 | `BAD_BLOCK_TYPE` | `requestedBlocks` has an unknown type | use the listed types |
| 400 | `BAD_PERMUTATION` | reorder `blockIds` isn't a permutation of the lesson's ids | send every id exactly once |
| 400 | (message "at least one…") | `/edit-block` with no instruction/complexity/visualDemand | send ≥1 |
| 404 | — | lesson/block id not found | check the id |
| 500 | — | unexpected | retry; check server logs |

All errors are JSON: `{ "error": "human message", "code": "MACHINE_CODE" }` (code may be absent on 404/500).

## (l) BASE URL / serving to another laptop

- Same machine: `http://localhost:3000`.
- Another laptop on the **same Wi-Fi**: on the backend machine run `ipconfig` (Windows), read the
  **IPv4 Address** (e.g. `192.168.1.23`), then set the frontend `BASE_URL = "http://192.168.1.23:3000"`.
  CORS is already open, so no extra config. (Firewall may prompt to allow Node the first time.)
- Start the backend with `npm start` (listens on `0.0.0.0:3000`).

## (m) `timeFit` — the time-fit banner

Returned on `/generate`, `/edit-block`, `/edit-lesson`, `/reorder`:
```json
{ "plannedMins": 42, "ok": true }
// or when over the class length:
{ "plannedMins": 52.4, "ok": false, "overBy": 7.4,
  "suggestion": "This lesson runs about 7.4 min over 45 min. Nothing was removed. Suggestion: move the activity to homework.",
  "notice": "1 planned block(s) did not fit …" }
```
Show a **green** banner when `ok`; show an **amber** warning banner with `suggestion` when `!ok`. Nothing is
ever auto-trimmed — the teacher decides. Re-read `timeFit` after every edit.

---

## Quick start for the FE

1. Open `reference-client.html` in a browser (edit `BASE_URL` at the top if not localhost). It runs the
   **entire** journey and is commented so you can lift any piece.
2. `curl.md` has a copy-paste command for every endpoint.
3. `examples/` has real request/response JSON + an SSE transcript to code against.
