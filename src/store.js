// Flat-file JSON persistence. ./data/{materials,lessons,teachers}/<id>.json
import fs from 'node:fs';
import path from 'node:path';

const dir = kind => {
  const d = path.join(path.resolve(process.env.DATA_DIR || './data'), kind);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const file = (kind, id) => path.join(dir(kind), `${String(id).replace(/[^\w.-]/g, '_')}.json`);

export const save = (kind, id, obj) => (fs.writeFileSync(file(kind, id), JSON.stringify(obj, null, 2)), obj);

export function load(kind, id) {
  const f = file(kind, id);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export const list = kind => fs.readdirSync(dir(kind))
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(dir(kind), f), 'utf8')));

// Recreate the data dirs on boot so a fresh (e.g. Render, ephemeral-disk) instance never
// starts missing them. dir() already mkdirs lazily; this just makes it explicit and eager.
export const ensureStore = () => ['materials', 'lessons', 'teachers'].forEach(dir);
