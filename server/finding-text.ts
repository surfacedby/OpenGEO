/** Typed evidence references remain available separately from reader-facing explanations. */
export function withoutEvidenceList(text: string, evidenceIds: string[]) {
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const tail = new RegExp('\\s*(?:Evidence|Sources?):\\s*(' + uuid + '(?:\\s*[,;]\\s*' + uuid + ')*)\\.?\\s*$', 'i').exec(text);
  if (!tail) return text;
  const known = new Set(evidenceIds.map(id => id.toLowerCase()));
  if (tail[1].split(/\s*[,;]\s*/).some(id => !known.has(id.toLowerCase()))) return text;
  return text.slice(0, tail.index).trimEnd();
}
