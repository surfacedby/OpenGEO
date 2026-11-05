import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChartColumn, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Globe, Lightbulb, Link, MessagesSquare, Minus, ScanSearch, Search, Target, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { pointChange, shortDate } from '../format';

export function PageHeader({ title, description, icon: Icon, children }: { title: string; description: string; icon: LucideIcon; children?: ReactNode }) {
  return <div className="page-heading"><div className="page-heading-copy"><span className="page-icon"><Icon size={22} aria-hidden="true" /></span><div><h1>{title}</h1><p>{description}</p></div></div>{children}</div>;
}

export function Disclosure({ label, children, onOpenChange, defaultOpen = false }: { label: string; children: ReactNode; onOpenChange?: (open: boolean) => void; defaultOpen?: boolean }) {
  return <details className="disclosure" open={defaultOpen || undefined} onToggle={event => { if (event.target === event.currentTarget) onOpenChange?.(event.currentTarget.open); }}><summary>{label}<ChevronDown size={16} aria-hidden="true" /></summary><div className="disclosure-content">{children}</div></details>;
}

export function EmptyState({ title, children, icon: Icon = Search, action }: { title: string; children: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return <div className="empty"><Icon size={24} aria-hidden="true" /><h3>{title}</h3><p>{children}</p>{action}</div>;
}

/** A single content surface owns its spacing; callers never nest panels to get padding. */
export function Section({ title, description, action, children, className = '' }: { title?: string; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={'content-section ' + className}>
    {(title || action) && <div className="section-heading"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</div>}
    <div className="section-body">{children}</div>
  </section>;
}

export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return <div className="content-toolbar"><div className="toolbar-main">{children}</div>{actions && <div className="toolbar-actions">{actions}</div>}</div>;
}

export function Pagination({ page, total, pageSize, label, unit, onChange }: { page: number; total: number; pageSize: number; label: string; unit: string; onChange: (page: number) => void }) {
  if (total <= pageSize) return null;
  const current = Math.min(Math.max(0, page), Math.ceil(total / pageSize) - 1);
  return <nav className="list-pagination" aria-label={label + ' pagination'}>
    <span aria-live="polite">{current * pageSize + 1}-{Math.min((current + 1) * pageSize, total)} of {total} {unit}</span>
    <button type="button" className="secondary compact" aria-label={'Previous ' + label + ' ' + unit} disabled={current === 0} onClick={() => onChange(current - 1)}><ChevronLeft size={15} />Previous</button>
    <button type="button" className="secondary compact" aria-label={'Next ' + label + ' ' + unit} disabled={(current + 1) * pageSize >= total} onClick={() => onChange(current + 1)}>Next<ChevronRight size={15} /></button>
  </nav>;
}

export function ActionCard({ title, description, icon: Icon, children }: { title: string; description: string; icon: LucideIcon; children: ReactNode }) {
  return <Section className="action-card"><Icon size={24} aria-hidden="true" /><h2>{title}</h2><p>{description}</p><div className="button-row">{children}</div></Section>;
}

export function Tabs<T extends string>({ label, value, items, onChange, panelId }: { label: string; value: T; items: { value: T; label: string; count?: number; icon?: LucideIcon }[]; onChange: (value: T) => void; panelId: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = ref.current, active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !active) return;
    const bounds = list.getBoundingClientRect(), selected = active.getBoundingClientRect();
    if (selected.left < bounds.left) list.scrollLeft -= bounds.left - selected.left;
    else if (selected.right > bounds.right) list.scrollLeft += selected.right - bounds.right;
  }, [value]);
  return <div ref={ref} className="section-tabs" role="tablist" aria-label={label}>{items.map((item, index) => {
    const Icon = item.icon;
    return <button key={item.value} id={id + '-' + index} type="button" role="tab" aria-controls={panelId} aria-selected={item.value === value} tabIndex={item.value === value ? 0 : -1} onClick={() => onChange(item.value)} onKeyDown={event => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
      onChange(items[next].value); document.getElementById(id + '-' + next)?.focus();
    }}>{Icon && <Icon size={16} aria-hidden="true" />}{item.label}{item.count !== undefined && <span className="tab-count">{item.count}</span>}</button>;
  })}</div>;
}

const metricIcons: Record<string, LucideIcon> = { 'Brand mentions': MessagesSquare, 'Website citations': Link, 'Answers collected': Check, Opportunities: Lightbulb, 'Answers remaining': MessagesSquare, 'Cited websites': Globe, 'Your cited pages': FileText, 'Answers citing you': Link, 'Target pages cited': Target };

/** Deltas come from the server's same-scope comparison, not adjacent check values. */
export function MetricCard({ title, value, detail, points, since, tone = 'mention' }: { title: string; value: string; detail: string; points?: number | null; since?: string; tone?: 'mention' | 'citation' }) {
  const Icon = metricIcons[title] ?? ChartColumn;
  const change = points === undefined ? null : pointChange(points);
  const ChangeIcon = change?.direction === 'up' ? TrendingUp : change?.direction === 'down' ? TrendingDown : Minus;
  return <section className={'metric ' + tone}>
    <span className="metric-title">{title}<span className="metric-icon"><Icon size={16} aria-hidden="true" /></span></span>
    <div className="metric-value"><strong className={value.length > 10 ? 'metric-text' : undefined}>{value}</strong>{change && since && <span className={'metric-change ' + change.direction} title={'Compared with the comparable check on ' + shortDate(since)}><ChangeIcon size={13} aria-hidden="true" />{change.label}<span className="visually-hidden"> since the comparable check on {shortDate(since)}</span></span>}</div>
    <small>{detail}</small>
  </section>;
}

/** A count is always paired with its denominator; missing evidence never becomes zero. */
export function CoverageRing({ count, total, label }: { count: number; total: number; label: string }) {
  const id = useId(), radius = 45, circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.max(0, Math.min(1, count / total)) : 0;
  return <svg className="coverage-ring" viewBox="0 0 120 120" role="img" aria-labelledby={id}>
    <title id={id}>{total > 0 ? `${count} of ${total} ${label}` : 'No answers collected yet'}</title>
    <circle className="coverage-ring-track" cx="60" cy="60" r={radius} fill="none" strokeWidth="8" />
    {total > 0 && <circle className="coverage-ring-value" cx="60" cy="60" r={radius} fill="none" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${circumference * ratio} ${circumference}`} transform="rotate(-90 60 60)" />}
    <text x="60" y="58" textAnchor="middle" className="coverage-ring-number">{total > 0 ? `${Math.round(ratio * 100)}%` : 'Pending'}</text>
    <text x="60" y="77" textAnchor="middle" className="coverage-ring-label">{total > 0 ? `${count} of ${total}` : 'first check'}</text>
  </svg>;
}

export const emptyIcon = (title: string) => /draft|create|content/i.test(title) ? FileText : /audit|page/i.test(title) ? ScanSearch : /answer|response/i.test(title) ? MessagesSquare : /recommendation|improvement/i.test(title) ? Lightbulb : Search;
