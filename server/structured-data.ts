type Context = { vocabulary?: string; terms: Map<string, unknown>; unknown: boolean };
const schemaNamespace = (value: unknown) => typeof value === 'string' && /^https?:\/\/schema\.org\/?$/.test(value);
const schemaTerm = (value: unknown) => typeof value === 'string' ? /^https?:\/\/schema\.org\/([A-Za-z][A-Za-z0-9]*)$/.exec(value)?.[1] : undefined;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function context(value: unknown, parent: Context): Context {
  let current = { ...parent, terms: new Map(parent.terms) };
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (entry === null) current = { terms: new Map(), unknown: false };
    else if (typeof entry === 'string') {
      if (schemaNamespace(entry)) current.vocabulary = entry;
      else current.unknown = true;
    } else if (record(entry)) {
      for (const [key, definition] of Object.entries(entry)) {
        if (key === '@vocab') current.vocabulary = typeof definition === 'string' ? definition : undefined;
        else current.terms.set(key, definition);
      }
      if ('@import' in entry || '@propagate' in entry) current.unknown = true;
    } else current.unknown = true;
  }
  return current;
}

function resolveType(value: unknown, scope: Context) {
  if (typeof value !== 'string') return undefined;
  const absolute = schemaTerm(value);
  if (absolute) return absolute;
  if (scope.unknown || /^https?:/.test(value)) return undefined;
  const mapped = scope.terms.get(value);
  if (scope.terms.has(value)) return schemaTerm(record(mapped) ? mapped['@id'] : mapped);
  const colon = value.indexOf(':');
  if (colon !== -1) {
    const prefix = scope.terms.get(value.slice(0, colon));
    const term = value.slice(colon + 1);
    return schemaNamespace(record(prefix) ? prefix['@id'] : prefix) && /^[A-Za-z][A-Za-z0-9]*$/.test(term) ? term : undefined;
  }
  return schemaNamespace(scope.vocabulary) && /^[A-Za-z][A-Za-z0-9]*$/.test(value) ? value : undefined;
}

/** Publisher declarations are untrusted input, not proof of valid rich results. Remote contexts are never fetched. */
export function structuredTypes(blocks: Iterable<string>) {
  const types = new Set<string>(), limitations = new Set<string>();
  let bytes = 0, blockCount = 0, nodes = 0;
  function visit(value: unknown, scope: Context, depth = 0): void {
    if (++nodes > 4096 || depth > 12 || types.size >= 100) {
      limitations.add('Some structured data was too deeply nested or too large to inspect.');
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) { visit(child, scope, depth + 1); if (nodes > 4096 || types.size >= 100) break; }
    } else if (record(value)) {
      const local = '@context' in value ? context(value['@context'], scope) : scope;
      const declared = Array.isArray(value['@type']) ? value['@type'] : value['@type'] === undefined ? [] : [value['@type']];
      if (declared.length > 20) limitations.add('Some structured data declares more types than this check can inspect.');
      for (const name of declared.slice(0, 20)) {
        const type = resolveType(name, local);
        if (type) types.add(type);
        else limitations.add('Some declared types could not be identified as Schema.org types.');
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === '@context') continue;
        const definition = local.terms.get(key);
        const childScope = record(definition) && '@context' in definition ? context(definition['@context'], local) : local;
        visit(child, childScope, depth + 1);
        if (nodes > 4096 || types.size >= 100) break;
      }
    }
  }
  for (const block of blocks) {
    const size = Buffer.byteLength(block, 'utf8');
    if (++blockCount > 16 || bytes + size > 65536) {
      limitations.add('Only the first 16 structured-data blocks within 64 KB were inspected.');
      break;
    }
    bytes += size;
    try { visit(JSON.parse(block), { terms: new Map(), unknown: false }); }
    catch { limitations.add('A structured-data block could not be read as JSON.'); }
    if (nodes > 4096 || types.size >= 100) {
      limitations.add('Some structured data was too deeply nested or too large to inspect.');
      break;
    }
  }
  return { types: [...types], limitations: [...limitations] };
}
