import test from "node:test";
import assert from "node:assert/strict";
import { markdownHtml, htmlDocument } from "../server/markdown.js";

test("reading and HTML exports preserve headings, lists, source links and code without executing source markup", () => {
  const html = markdownHtml('# Example\n\nUseful **facts** and [Source](https://example.com/).\n\n- First\n- Second\n\n```html\n<script>alert(1)</script>\n```');
  assert.match(html, /<h1>Example<\/h1>/); assert.match(html, /<ul>\n<li>First<\/li>/); assert.match(html, /<strong>facts<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/"/); assert.ok(!html.includes("<script>")); assert.match(html, /&lt;script&gt;/);
  for (const url of ["javascript:alert(1)", "data:text/html,evil", "https://user:secret@example.com/"]) assert.ok(!markdownHtml("[Unsafe](" + url + ")").includes("href="));
  assert.ok(!markdownHtml('<img src="https://example.com/tracking" onerror="evil()">').includes("<img"));
  assert.ok(!markdownHtml("![Remote](https://example.com/image.png)").includes("<img"));
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
