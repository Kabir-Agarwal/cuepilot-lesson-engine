# curl for every endpoint

`BASE=http://localhost:3000`. Windows-safe: examples use **double quotes** and escape inner quotes as `\"`
(works in `cmd.exe`, PowerShell, and Git Bash). Replace `mat_..` / `lsn_..` / `b_..` ids with real ones from
prior responses. `curl` ships with Windows 10/11.

## Health / model chain
```
curl http://localhost:3000/health
```

## Ingest (multipart) — needs a real file path
```
curl -X POST http://localhost:3000/ingest ^
  -F "file=@fixtures/fractions.txt" -F "teacherId=demo-teacher" ^
  -F "subject=Mathematics" -F "board=CBSE" -F "grade=4"
```
(In PowerShell/Git Bash use a backslash `\` for line continuation instead of `^`, or put it all on one line.)

## Materials
```
curl "http://localhost:3000/materials?teacherId=demo-teacher"
```

## Generate (non-stream)
```
curl -X POST http://localhost:3000/generate -H "Content-Type: application/json" -d "{\"materialId\":\"mat_ab12cd34\",\"teacherId\":\"demo-teacher\",\"spec\":{\"board\":\"CBSE\",\"grade\":\"4\",\"subject\":\"Mathematics\",\"topic\":\"Fractions\",\"nLessons\":3,\"lessonIndex\":1,\"durationMins\":45,\"defaultComplexity\":2,\"visualDemand\":3,\"instructions\":\"use roti examples\"}}"
```

## Generate (stream / SSE) — `-N` disables buffering so events print live
```
curl -N -X POST http://localhost:3000/generate -H "Content-Type: application/json" -d "{\"materialId\":\"mat_ab12cd34\",\"teacherId\":\"demo-teacher\",\"stream\":true,\"spec\":{\"topic\":\"Fractions\",\"grade\":\"4\",\"subject\":\"Mathematics\",\"board\":\"CBSE\",\"nLessons\":3,\"lessonIndex\":1,\"durationMins\":45,\"defaultComplexity\":2,\"visualDemand\":3}}"
```

## Edit block (>=1 of instruction / complexity / visualDemand)
```
curl -X POST http://localhost:3000/edit-block -H "Content-Type: application/json" -d "{\"lessonId\":\"lsn_..\",\"blockId\":\"b_..\",\"instruction\":\"use a cricket example\",\"complexity\":4,\"visualDemand\":5}"
```

## Edit lesson (conversational; add "stream":true for SSE)
```
curl -X POST http://localhost:3000/edit-lesson -H "Content-Type: application/json" -d "{\"lessonId\":\"lsn_..\",\"instruction\":\"add an assessment at the end\"}"
```

## Reorder (permutation of the lesson's block ids)
```
curl -X POST http://localhost:3000/lessons/lsn_../reorder -H "Content-Type: application/json" -d "{\"blockIds\":[\"b_2\",\"b_0\",\"b_1\"]}"
```

## Library
```
curl http://localhost:3000/lessons
curl http://localhost:3000/lessons/lsn_..
curl -X POST http://localhost:3000/lessons/lsn_../duplicate
```

## View modes (returns a full HTML page)
```
curl "http://localhost:3000/lessons/lsn_..?mode=document"
curl "http://localhost:3000/lessons/lsn_..?mode=slideshow"
curl "http://localhost:3000/lessons/lsn_..?mode=animated"
```

## Prefs
```
curl http://localhost:3000/prefs/demo-teacher
curl -X PUT http://localhost:3000/prefs/demo-teacher -H "Content-Type: application/json" -d "{\"defaultComplexity\":4,\"defaultVisualDemand\":5,\"textDensity\":\"low\",\"simpleLanguage\":true}"
```

## Roadmap (multi-lesson plan)
```
curl -X POST http://localhost:3000/roadmap -H "Content-Type: application/json" -d "{\"materialId\":\"mat_..\",\"teacherId\":\"demo-teacher\",\"spec\":{\"topic\":\"Fractions\",\"subject\":\"Mathematics\",\"board\":\"CBSE\",\"grade\":\"4\",\"nLessons\":3}}"
```

## CORS preflight (should return 204 with Access-Control-* headers)
```
curl -i -X OPTIONS http://localhost:3000/generate -H "Origin: http://other:5173" -H "Access-Control-Request-Method: POST"
```
