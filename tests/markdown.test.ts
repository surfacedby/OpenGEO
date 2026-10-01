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
