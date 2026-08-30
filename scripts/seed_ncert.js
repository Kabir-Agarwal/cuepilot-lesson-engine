// Stretch S4: seed one NCERT chapter as a curriculum-authority source. Skip-on-fail — a
// network hiccup must never break the build. Run: npm run seed
import 'dotenv/config';
import { extractText } from '../src/pdf.js';
import { ingest } from '../src/rag.js';
import { save } from '../src/store.js';

const URL = 'https://ncert.nic.in/textbook/pdf/hesc105.pdf';
const SOURCE_ID = 'R001';

try {
  console.log('Fetching', URL);
  const res = await fetch(URL, { headers: { 'user-agent': 'Mozilla/5.0 cuepilot-seed' } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = await extractText(buf, 'hesc105.pdf');
  if (!text.trim()) throw new Error('no text extracted');

  const chunks = await ingest(text, {
    materialId: SOURCE_ID, source_id: SOURCE_ID, source_name: 'NCERT Science Class VIII Ch.5',
    board: 'NCERT', grade: '8', subject: 'Science',
    content_type: 'textbook', authority_level: 'curriculum_authority',
    attribution_string: 'NCERT, Science, Class VIII, Ch. 5',
  });
  save('materials', SOURCE_ID, {
    id: SOURCE_ID, materialId: SOURCE_ID, teacherId: 'ncert', subject: 'Science', board: 'NCERT', grade: '8',
    filename: 'hesc105.pdf', uploadedAt: new Date().toISOString(), chars: text.length, chunks,
  });
  console.log(`Seeded ${SOURCE_ID}: ${chunks.length} chunks, ${text.length} chars (authority: curriculum_authority).`);
} catch (e) {
  console.log(`SKIP — could not seed NCERT (${e.message}). This is non-fatal; teacher uploads work regardless.`);
  process.exit(0);
}
