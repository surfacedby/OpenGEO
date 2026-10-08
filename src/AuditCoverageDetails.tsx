import { ArrowUpRight, ChevronDown, FileText, Globe, Shield, TriangleAlert } from "lucide-react";
import type { AuditCoverage } from "../server/contracts";

function addressLabel(value: string, file: boolean) {
  const url = new URL(value);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Some valid URL paths contain bytes outside UTF-8. */ }
  return file ? path.split("/").filter(Boolean).pop() ?? url.hostname : url.hostname + (path === "/" ? "" : path);
}

export function AuditCoverageDetails({ coverage }: { coverage: AuditCoverage }) {
  const groups = [
    { title: "Could not be read", description: "We couldn't retrieve these pages or files.", Icon: TriangleAlert, rows: coverage.failed.map(entry => ({ url: entry.url, reason: entry.reason })), file: false },
    { title: "Pages excluded by the website", description: "The website's crawl instructions exclude these addresses.", Icon: Shield, rows: coverage.excludedByRobots.map(url => ({ url, reason: "" })), file: false },
    { title: "Files not included", description: "This audit checks web pages. Document downloads are listed for reference.", Icon: FileText, rows: coverage.skippedNonHtml.map(url => ({ url, reason: "" })), file: true },
  ].filter(group => group.rows.length);
  return <div className="panel-padding audit-coverage">
    <p>{coverage.fetched} {coverage.fetched === 1 ? "page inspected" : "pages inspected"} from {coverage.attempted} {coverage.attempted === 1 ? "address checked" : "addresses checked"}.</p>
    {coverage.truncated && <p role="status">The page limit was reached. {coverage.remainingDiscovered} discovered addresses remain. Increase the limit in a new audit to inspect more.</p>}
    {groups.length > 0 && <details><summary>Pages and files not included<ChevronDown size={15} /></summary><div className="coverage-groups">{groups.map(({ title, description, Icon, rows, file }) => <details key={title} className="coverage-group">
      <summary><Icon size={16} /><strong>{title}</strong><span>{rows.length}</span><ChevronDown size={15} className="coverage-chevron" /></summary>
      <p>{description}</p><ul>{rows.map(row => <li key={row.url}><a href={row.url} target="_blank" rel="noreferrer" title={row.url}>{file ? <FileText size={16} /> : <Globe size={16} />}<span>{addressLabel(row.url, file)}</span><ArrowUpRight size={14} /></a>{row.reason && <small>{row.reason}</small>}</li>)}</ul>
    </details>)}</div></details>}
  </div>;
}
