import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../server/audit.js';

test('main page evidence excludes furniture and hidden content while retaining crawl discovery', () => {
  const page = parsePage('https://example.com/', 200, `<title>Example</title><header>Shared promotion</header>
    <nav><a href="/docs">Documentation</a></nav><main><h1>Setup</h1><p>Use Woo<strong>Commerce</strong>.</p><p>Follow these steps.</p>
    <div hidden>Hidden claim</div><div style="display: none !important">Old offer</div><template>Template claim</template></main>
    <aside>Other products</aside><footer>Legal navigation</footer>`);
  assert.equal(page.text, 'Setup Use WooCommerce. Follow these steps.');
  assert.deepEqual(page.h1, ['Setup']);
  assert.deepEqual(page.links, ['https://example.com/docs']);
  assert.equal(page.title, 'Example');
});

test('fallback extraction keeps visible content and separates adjacent blocks', () => {
  const page = parsePage('https://example.com/', 200, '<header>Navigation</header><h1>Overview</h1><p>First paragraph.</p><p>Second paragraph.</p><div style="display: block">Visible</div>');
  assert.equal(page.text, 'Overview First paragraph. Second paragraph. Visible');
});

test('nested interface text and outside headings cannot become main page evidence', () => {
  const page = parsePage('https://example.com/', 200, `<title>Services</title><h1>Site banner</h1>
    <main><header><h1>Website services</h1></header><section><p>We build accessible websites.</p>
    <div role="navigation"><h1>Browse products</h1><a href="/products">All products</a></div>
    <div role="dialog"><h1>Subscribe</h1><p>Our shared subscription pitch.</p></div>
    <form><label>Choose a language</label><select><option>English</option></select></form>
    <svg><title>Decorative chart</title><text>Unverified claim</text></svg>
    <aside>Other services</aside><p aria-hidden="TRUE">Invisible claim</p>
    <details><summary>How long does setup take?</summary><p>Two working days.</p></details>
    <section><h2>Performance score</h2><p>94</p></section></section></main>`);
  assert.equal(page.title, 'Services');
  assert.deepEqual(page.h1, ['Website services']);
  assert.equal(page.text, 'Website services We build accessible websites. How long does setup take? Two working days. Performance score 94');
  assert.deepEqual(page.links, ['https://example.com/products']);
});

test('article fallback retains its header and ignores surrounding layout', () => {
  const page = parsePage('https://example.com/guide', 200, `<div><header><h1>Shared website title</h1></header>
    <article><header><h1>Installation guide</h1></header><p>Connect your account.</p></article>
    <div>More from this website</div></div>`);
  assert.deepEqual(page.h1, ['Installation guide']);
  assert.equal(page.text, 'Installation guide Connect your account.');
});

test('multiple main regions retain their content without including shared layout', () => {
  const page = parsePage('https://example.com/', 200, '<div>Shared promotion</div><main><h1>Products</h1><p>First product.</p></main><main><h2>Services</h2><p>Second offering.</p></main>');
  assert.deepEqual(page.h1, ['Products']);
  assert.equal(page.text, 'Products First product. Services Second offering.');
});

test('indexing directives combine repeated metadata without substring false positives', () => {
  const page = (meta: string) => parsePage('https://example.com/', 200, meta + '<h1>Example</h1>');
  assert.equal(page('<meta name="robots" content="index"><meta name="ROBOTS" content="noindex, follow">').noindex, true);
  assert.equal(page('<meta name="googlebot" content="none">').noindex, true);
  assert.equal(page('<meta name="robots" content="not-noindex">').noindex, false);
  assert.equal(parsePage('https://example.com/', 200, '<h1>Example</h1>', 'noindex, follow').noindex, true);
});
