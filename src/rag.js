// Agentic RAG. retrieve() is called fresh per block and again on every edit,
// so an edited block is grounded in the material relevant to its NEW intent.
// Alchemyst is best-effort: any error falls back to the local index, logged, never thrown.

const CHUNK_CHARS = 1200;
const OVERLAP = 0.15;
const ALCHEMYST_BASE = process.env.ALCHEMYST_BASE_URL || 'https://platform-backend.getalchemystai.com/api/v1';

export const AUTHORITY_WEIGHT = {
  teacher_upload: 1.0,
  curriculum_authority: 0.9,
  other: 0.7,
};

/** materialId -> chunk[]  (local index; also the Alchemyst fallback) */
const store = new Map();
export const ragStatus = { alchemystTried: false, alchemystAdd: null, alchemystSearch: null, lastError: null };

export function chunkText(text, baseMeta = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  const stride = Math.max(1, Math.round(CHUNK_CHARS * (1 - OVERLAP)));
  const chunks = [];
  for (let i = 0, n = 0; i < clean.length; i += stride, n++) {
    const content = clean.slice(i, i + CHUNK_CHARS).trim();
    if (content) chunks.push({ content, chunk_index: n, ...meta(baseMeta) });
    if (i + CHUNK_CHARS >= clean.length) break;
  }
  return chunks;
}

function meta(m) {
  return {
    source_id: m.source_id || 'M000',
    source_name: m.source_name || 'material',
    board: m.board || '',
    grade: String(m.grade ?? ''),
    subject: m.subject || '',
    content_type: m.content_type || 'chapter',
    authority_level: m.authority_level || 'teacher_upload',
    attribution_string: m.attribution_string || `Teacher upload, ${m.source_name || 'material'}`,
  };
}

/** Chunk + index. Pushes to Alchemyst when a key is present; local index always wins as fallback. */
export async function ingest(text, baseMeta = {}) {
  const chunks = chunkText(text, baseMeta);
  store.set(baseMeta.materialId || baseMeta.source_id, chunks);
  await alchemystAdd(chunks);
  return chunks;
}

export function loadChunks(materialId, chunks) {
  store.set(materialId, chunks);
}

async function alchemystAdd(chunks) {
  const key = process.env.ALCHEMYST_AI_API_KEY;
  if (!key || !chunks.length) return;
  ragStatus.alchemystTried = true;
  try {
    const res = await fetch(`${ALCHEMYST_BASE}/context/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        documents: chunks.map(c => ({ content: c.content, metadata: c })),
        source: chunks[0].source_name,
        context_type: 'resource',
        scope: 'internal',
        metadata: { fileName: chunks[0].source_name, fileType: 'text/plain' },
      }),
    });
    ragStatus.alchemystAdd = res.ok ? 'ok' : `http ${res.status}`;
    if (!res.ok) console.warn('[rag] alchemyst add failed:', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    ragStatus.alchemystAdd = 'error';
    ragStatus.lastError = e.message;
    console.warn('[rag] alchemyst add error, using local index:', e.message);
  }
}

async function alchemystSearch(query) {
  const key = process.env.ALCHEMYST_AI_API_KEY;
  if (!key) return null;
  ragStatus.alchemystTried = true;
  try {
    const res = await fetch(`${ALCHEMYST_BASE}/context/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, similarity_threshold: 0.7, minimum_similarity_score: 0.7, scope: 'internal' }),
    });
    if (!res.ok) {
      ragStatus.alchemystSearch = `http ${res.status}`;
      console.warn('[rag] alchemyst search failed:', res.status);
      return null;
    }
    ragStatus.alchemystSearch = 'ok';
    const j = await res.json();
    const hits = j.contexts || j.results || j.data || [];
    if (!Array.isArray(hits) || !hits.length) return null;
    return hits.map(h => ({
      ...meta(h.metadata || {}),
      content: h.content || h.text || '',
      chunk_index: h.metadata?.chunk_index ?? 0,
      score: Number(h.score ?? h.similarity ?? 0.7),
    })).filter(h => h.content);
  } catch (e) {
    ragStatus.alchemystSearch = 'error';
    ragStatus.lastError = e.message;
    console.warn('[rag] alchemyst search error, using local index:', e.message);
    return null;
  }
}

const STOP = new Set('a an the of to in on for and or is are was were be with as at by it its this that these those from how what why do does'.split(' '));
const tokens = s => String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(t => t.length > 2 && !STOP.has(t)) ?? [];

function localSearch(intent, materialIds) {
  const want = tokens(intent);
  const wantSet = new Set(want);
  const pool = materialIds?.length
    ? materialIds.flatMap(id => store.get(id) || [])
    : [...store.values()].flat();
  return pool.map(c => {
    const t = tokens(c.content);
    let hit = 0;
    for (const tok of t) if (wantSet.has(tok)) hit++;
    return { ...c, score: want.length ? hit / (want.length + Math.sqrt(t.length)) : 0 };
  });
}

/**
 * retrieve(intent, {materialIds, board, grade, subject, k}) -> top chunks with attribution.
 * Rank = similarity x authority weight, so teacher uploads beat curriculum beats other.
 */
export async function retrieve(intent, filters = {}) {
  const { materialIds, board, grade, subject, k = 3 } = filters;
  let hits = await alchemystSearch(intent);
  if (!hits || !hits.length) hits = localSearch(intent, materialIds);

  const match = (a, b) => !a || !b || String(a).toLowerCase() === String(b).toLowerCase();
  const filtered = hits.filter(c =>
    match(board, c.board) && match(grade, c.grade) && match(subject, c.subject));
  const pool = filtered.length ? filtered : hits;

  return pool
    .map(c => ({ ...c, rank: (c.score || 0) * (AUTHORITY_WEIGHT[c.authority_level] ?? 0.7) }))
    .sort((a, b) => b.rank - a.rank || a.chunk_index - b.chunk_index)
    .slice(0, k);
}

export const sourceRefsFrom = chunks => {
  const seen = new Set();
  return chunks.filter(c => !seen.has(c.source_id) && seen.add(c.source_id))
    .map(c => ({ sourceId: c.source_id, sourceName: c.source_name, attribution: c.attribution_string }));
};
