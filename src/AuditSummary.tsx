import { ArrowUpRight, Check, FileText, ListChecks, ScanSearch } from "lucide-react";
import type { Presentation } from "../server/presentation";

/** Page coverage counts stay separate from visibility and are never an invented score. */
export function AuditSummary({ audit, domain, findingCounts, openAudit }: { audit: Presentation["audit"]; domain: string; findingCounts: { total: number; done: number }; openAudit: () => void }) {
  const rows = [{ label: "Page titles", count: audit.titles }, { label: "Page descriptions", count: audit.descriptions }, { label: "Structured data", count: audit.structuredData }];
  const open = findingCounts.total - findingCounts.done;
  return <section className="panel audit-summary">
    <div className="panel-heading"><h2><ScanSearch size={17} />Your website at a glance</h2><button className="text-button" onClick={openAudit}>Explore pages <ArrowUpRight size={14} /></button></div>
    <div className="audit-summary-body">
      <div className="page-coverage-visual">
        <div className="page-visual-header"><GlobeMark /><span>{domain}</span><ArrowUpRight size={13} /></div>
        <div className="page-visual-body"><span className="page-visual-icon"><FileText size={24} /></span><strong>{audit.pages.toLocaleString()}</strong><span>{audit.pages === 1 ? "page inspected" : "pages inspected"}</span></div>
        <div className="page-visual-footer"><Check size={14} />Website health check</div>
      </div>
      <div className="audit-signals"><h3>What your available pages contain</h3>{rows.map(row => <div className="audit-signal" key={row.label}><div><span>{row.label}</span><strong>{row.count} <span>/ {audit.available}</span></strong></div><div className="signal-track" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={Math.max(1, audit.available)} aria-valuenow={row.count} aria-valuetext={`${row.count} of ${audit.available} available pages`}><span style={{ width: (audit.available ? row.count / audit.available * 100 : 0) + "%" }} /></div></div>)}</div>
      <div className="audit-actions-summary"><span className="audit-action-icon"><ListChecks size={21} /></span><strong>{open}</strong><h3>{open === 1 ? "improvement to explore" : "improvements to explore"}</h3><p>{findingCounts.total ? `${findingCounts.done} marked done. Review the evidence before making a change.` : "Check AI visibility to connect your pages to the answers your customers see."}</p></div>
    </div>
  </section>;
}
function GlobeMark() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" /><ellipse cx="8" cy="8" rx="2.5" ry="6" stroke="currentColor" /><path d="M2 8h12" stroke="currentColor" /></svg>; }
