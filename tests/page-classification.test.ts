import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../server/audit.js';
import { pageAvailable, pageType, pageSearchExclusion } from '../server/page-classification.js';

test('availability treats an unresolved redirect or cached response as missing page content', () => {
  for (const status of [200, 201, 206]) assert.equal(pageAvailable({ status }), true);
  for (const status of [0, 103, 301, 304, 401, 404, 500]) assert.equal(pageAvailable({ status }), false);
});

test('page classification follows document evidence before URL guesses', () => {
  const page = parsePage('https://example.com/plugins/tool', 200, '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script><h1>Tool</h1>');
  assert.equal(pageType(page), 'product');
  assert.equal(pageType({ ...page, schemaTypes: [], url: 'https://example.com/fr-fr/pricing' }), 'pricing');
  assert.equal(pageType({ ...page, schemaTypes: [], url: 'https://example.com/docs/product-guide' }), 'documentation');
});

test('conventional page names do not alone exclude real public content', () => {
  const page = parsePage('https://example.com/checkout', 200, '<h1>A checkout product</h1>');
  assert.equal(pageSearchExclusion(page), null);
  assert.equal(pageSearchExclusion({ ...page, noindex: true }), 'Excluded from search by noindex');
  assert.equal(pageSearchExclusion({ ...page, status: 401 }), 'Sign-in required');
  assert.equal(pageSearchExclusion({ ...page, url: 'https://example.com/wp-login.php' }), 'Account or sign-in page');
});
