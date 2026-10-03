/** Export a readable document without executing HTML or loading images from model output. */
export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function inline(value: string) {
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let html = "", cursor = 0;
  for (const match of value.matchAll(pattern)) {
    html += escapeHtml(value.slice(cursor, match.index));
    if (match[1]) html += "<code>" + escapeHtml(match[1]) + "</code>";
    else if (match[2]) {
      let safe = false;
      try { const url = new URL(match[3]); safe = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch {}
      html += safe ? '<a href="' + escapeHtml(match[3]) + '" target="_blank" rel="noreferrer noopener">' + inline(match[2]) + "</a>" : escapeHtml(match[2]);
    } else html += match[4] ? "<strong>" + inline(match[4]) + "</strong>" : "<em>" + inline(match[5]) + "</em>";
    cursor = match.index! + match[0].length;
  }
  return html + escapeHtml(value.slice(cursor));
}
function tableCells(line: string) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let cell = '', code = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\' && value[index + 1] === '|') { cell += '|'; index++; }
    else if (value[index] === '`') { code = !code; cell += '`'; }
    else if (value[index] === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += value[index];
  }
  cells.push(cell.trim());
  return cells;
}
export function markdownHtml(markdown: string) {
  const output: string[] = [], paragraph: string[] = [], code: string[] = [];
  let fenced = false, list: "ul" | "ol" | null = null;
  function flush() { if (paragraph.length) { output.push("<p>" + inline(paragraph.join("\n")) + "</p>"); paragraph.length = 0; } }
  function closeList() { if (list) { output.push("</" + list + ">"); list = null; } }
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush(); closeList();
      if (fenced) { output.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>"); code.length = 0; }
      fenced = !fenced; continue;
    }
    if (fenced) { code.push(line); continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    const headings = tableCells(line), separators = tableCells(lines[index + 1] ?? '');
    if (line.includes('|') && headings.length > 1 && headings.length <= 128 && headings.length === separators.length
      && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flush(); closeList();
      output.push('<div class="markdown-table" role="region" aria-label="Content table" tabindex="0"><table><thead><tr>'
        + headings.map(cell => '<th scope="col">' + inline(cell) + '</th>').join('') + '</tr></thead><tbody>');
      index++;
      while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|')) {
        const cells = tableCells(lines[++index]);
        output.push('<tr>' + headings.map((_, column) => '<td>' + inline(cells[column] ?? '') + '</td>').join('') + '</tr>');
      }
      output.push('</tbody></table></div>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/), item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (heading) { flush(); closeList(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (item) { flush(); const type = item[1] ? "ul" : "ol"; if (list !== type) { closeList(); list = type; output.push("<" + type + ">"); } output.push("<li>" + inline(item[2]) + "</li>"); }
    else { closeList(); paragraph.push(line); }
  }
  flush(); closeList();
  if (fenced) output.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
  return output.join("\n");
}
export function htmlDocument(title: string, markdown: string, locale = "en") {
  let language = "en", direction = "ltr";
  try { const value = new Intl.Locale(locale); language = value.toString(); direction = ["ar", "fa", "he", "ur"].includes(value.language) ? "rtl" : "ltr"; } catch {}
  return '<!doctype html><html lang="' + escapeHtml(language) + '" dir="' + direction + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;"><title>' + escapeHtml(title) + '</title><style>body{font:16px/1.7 system-ui;color:#0f172a;max-width:860px;margin:48px auto;padding:24px}h1,h2,h3{line-height:1.25;margin:1.4em 0 .6em}a{color:#0d6cf2;overflow-wrap:anywhere}p{white-space:pre-wrap}pre{white-space:pre-wrap;background:#f1f5f9;padding:18px;border-radius:8px;overflow-wrap:anywhere}code{font-size:.9em}li{margin:.5em 0}.markdown-table{overflow:auto;margin:24px 0}table{border-collapse:collapse;width:100%}th,td{padding:12px;border:1px solid #e2e8f0;text-align:start;vertical-align:top}th{background:#f8fafc}@media print{body{margin:0;max-width:none;padding:0}a{color:inherit}.markdown-table{overflow:visible}}</style></head><body><article>' + markdownHtml(markdown) + '</article></body></html>';
}
