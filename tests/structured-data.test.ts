import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredTypes } from '../server/structured-data.js';
import { parsePage } from '../server/audit.js';

test('structured data follows nested entities, local prefixes and context resets without remote lookups', () => {
  const input = { '@context': 'https://schema.org', '@type': 'WebPage', mainEntity: [
    { '@type': 'Product', offers: { '@type': 'Offer' } },
    { '@context': null, '@type': 'NotASchemaType' },
    { '@context': { s: 'https://schema.org/', Item: { '@id': 'https://schema.org/Service' } }, '@type': ['s:Organization', 'Item'] },
    { '@context': 'https://example.com/context', '@type': 'Product', child: { '@type': 'https://schema.org/Article' } },
    { '@context': { '@vocab': 'https://example.com/' }, '@type': 'Product' },
    { '@type': 'https://schema.org.example.com/Product' },
  ] };
  const result = structuredTypes([JSON.stringify(input)]);
  assert.deepEqual(result.types, ['WebPage', 'Product', 'Offer', 'Organization', 'Service', 'Article']);
  assert.ok(result.limitations.length);
  assert.deepEqual(structuredTypes(['{"@type":"Product"}']).types, []);
  assert.deepEqual(structuredTypes(['{"@context":{"@vocab":"https://schema.org/","Product":null},"@type":"Product"}']).types, []);
});

test('property-scoped contexts do not leak to siblings or later script blocks', () => {
  const result = structuredTypes([JSON.stringify({ '@context': { child: { '@context': 'https://schema.org' } },
    child: { '@type': 'Product' }, sibling: { '@type': 'Person' } }), '{"@type":"Article"}']);
  assert.deepEqual(result.types, ['Product']);
  assert.ok(result.limitations.length);
});

test('malformed, oversized and deeply nested declarations stay bounded and disclose incomplete reading', () => {
  const valid = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article' });
  const malformed = structuredTypes(['{', valid]);
  assert.deepEqual(malformed.types, ['Article']);
  assert.match(malformed.limitations.join(' '), /could not be read/);
  assert.deepEqual(structuredTypes([' '.repeat(65537) + valid]).types, []);
  const limited = structuredTypes([...Array(16).fill('{}'), valid]);
  assert.deepEqual(limited.types, []);
  assert.match(limited.limitations.join(' '), /16/);
  let nested: unknown = { '@type': 'Product' };
  for (let i = 0; i < 30; i++) nested = { child: nested };
  const deep = structuredTypes([JSON.stringify({ '@context': 'https://schema.org', nested })]);
  assert.deepEqual(deep.types, []);
  assert.match(deep.limitations.join(' '), /deeply nested/);
});

test('publisher metadata survives furniture removal without entering readable page text', () => {
  const page = parsePage('https://example.com/', 200, '<main><h1>Example</h1><p>Visible page.</p></main><footer><script type=" Application/LD+JSON ">{"@context":"https://schema.org","@type":"Organization"}</script>Shared links</footer>');
  assert.deepEqual(page.schemaTypes, ['Organization']);
  assert.equal(page.text, 'Example Visible page.');
  assert.deepEqual(page.structuredDataLimitations, []);
});
