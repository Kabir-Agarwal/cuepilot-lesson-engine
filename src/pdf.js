// Text extraction. .txt/.md pass straight through; .pdf goes via pdf-parse.
export async function extractText(buffer, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext !== 'pdf') return buffer.toString('utf8');
  const mod = await import('pdf-parse');
  const parse = mod.default?.pdf || mod.pdf || mod.default || mod;
  const out = await parse(buffer);
  return out?.text ?? String(out ?? '');
}
