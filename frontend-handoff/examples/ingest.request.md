# POST /ingest — request (multipart/form-data)

Not JSON — a file upload. Fields:

| field | value |
|-------|-------|
| `file` | fractions.txt (the material; .txt/.md/.pdf, ≤20MB) |
| `teacherId` | demo-teacher |
| `subject` | Mathematics |
| `board` | CBSE |
| `grade` | 4 |
| `attribution` | (optional) Teacher upload, fractions.txt |

Browser:
```js
const fd = new FormData();
fd.append('file', fileInput.files[0]);
fd.append('teacherId', 'demo-teacher');
fd.append('subject', 'Mathematics');
fd.append('board', 'CBSE');
fd.append('grade', '4');
await fetch(BASE + '/ingest', { method: 'POST', body: fd }).then(r => r.json());
```
Response: see `ingest.response.json`.
