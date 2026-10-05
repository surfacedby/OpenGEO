import test from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, htmlDocument, markdownSummary } from "../server/markdown.js";

test("reading and HTML exports preserve headings, lists, source links and code without executing source markup", () => {
  const html = markdownHtml('# Example\n\nUseful **facts** and [Source](https://example.com/).\n\n- First\n- Second\n\n```html\n<script>alert(1)</script>\n```');
  assert.match(html, /<h1>Example<\/h1>/); assert.match(html, /<ul>\n<li>First<\/li>/); assert.match(html, /<strong>facts<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/"/); assert.ok(!html.includes("<script>")); assert.match(html, /&lt;script&gt;/);
  for (const url of ["javascript:alert(1)", "data:text/html,evil", "https://user:secret@example.com/"]) assert.ok(!markdownHtml("[Unsafe](" + url + ")").includes("href="));
  assert.ok(!markdownHtml('<img src="https://example.com/tracking" onerror="evil()">').includes("<img"));
  assert.ok(!markdownHtml("![Remote](https://example.com/image.png)").includes("<img"));
  assert.match(markdownHtml('Read **[the official guide](https://example.com/guide)** and [a **clear label**](https://example.com/).'), /<strong><a href="https:\/\/example.com\/guide"[^>]*>the official guide<\/a><\/strong>/);
  assert.match(markdownHtml('[a **clear label**](https://example.com/)'), /<a[^>]*>a <strong>clear label<\/strong><\/a>/);
  assert.match(markdownHtml('1. First step\n\n- Supporting detail\n\n2. Second step'), /<ol start="2">\n<li>Second step<\/li>/);
  const document = htmlDocument("<script>title</script>", "# A draft");
  assert.match(document, /<article><h1>A draft/); assert.match(document, /Content-Security-Policy/); assert.ok(!document.includes("<script>title"));
});

test('content tables render cells, escaped pipes and code without executing model markup', () => {
  const markdown = 'Intro\n\n| Cause | Check |\n| :--- | ---: |\n| **Database** | Review `a|b` and A \\| B |\n| <script>evil()</script> | [Unsafe](javascript:evil) |\n\n## Next step';
  const html = markdownHtml(markdown);
  assert.match(html, /<th scope="col">Cause<\/th>/);
  assert.match(html, /<td><strong>Database<\/strong><\/td>/);
  assert.match(html, /<code>a\|b<\/code> and A \| B/);
  assert.ok(!html.includes('<script>') && !html.includes('href="javascript:'));
  assert.match(html, /<\/table><\/div>\n<h2>Next step<\/h2>/);
  assert.match(htmlDocument('Table', markdown), /<table><thead>/);
  assert.ok(!markdownHtml('```\n| A | B |\n| --- | --- |\n```').includes('<table>'));
  assert.ok(!markdownHtml('| A | B |\n| --- |').includes('<table>'));
});

test("quotes and rules render as structure, and previews skip headings to the first prose block", () => {
  const html = markdownHtml("Before\n> Tip: **grind coarser**\n> for less bitterness\n\n---\n\nAfter");
  assert.match(html, /<p>Before<\/p>\n<blockquote><p>Tip: <strong>grind coarser<\/strong>\nfor less bitterness<\/p><\/blockquote>/);
  assert.match(html, /<hr>\n<p>After<\/p>/);
  assert.ok(!html.includes("&gt;"));
  assert.ok(!markdownHtml("> <script>evil()</script>").includes("<script>"));
  assert.equal(markdownSummary("## Short answer\n\nUse **fresh** beans.\n\n- Grind"), "Use **fresh** beans.");
  assert.equal(markdownSummary("| A | B |\n| --- | --- |\n\n> Quoted advice"), "Quoted advice");
  assert.equal(markdownSummary("# Only a heading"), "# Only a heading");
});

test("quote nesting is bounded and previews skip code and tables that contain blank lines", () => {
  const deep = markdownHtml(">".repeat(20000) + " deepest");
  assert.equal(deep.match(/<blockquote>/g)?.length, 4, "Nesting stops at the supported depth");
  assert.match(deep, /&gt;/, "Deeper markers stay as escaped text");
  assert.equal(markdownSummary("```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThe actual answer."), "The actual answer.");
  assert.equal(markdownSummary("Cause | Check\n--- | ---\nGrind | Coarse\n\nUse a coarse grind."), "Use a coarse grind.");
  assert.equal(markdownSummary("```\nonly code\n```"), "");
});
