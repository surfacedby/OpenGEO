import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Globe,
  Link,
  Search,
  CalendarDays,
} from "lucide-react";
import { SiteIcon } from "./SiteIcon";
import { FileText, ListChecks, Braces } from "lucide-react";
import type { Job, Observation } from "../server/contracts";
import { completedMeasurement, measurementTime } from "../server/portable-results";
import type {
  Presentation,
  PromptRow,
  SourceRow,
} from "../server/presentation";
import {
  platformLabel,
  ProviderIcon,
  providerLabels,
  retrievalLabel,
} from "./provider-ui";
import "./analytics.css";

const percent = (value: number | null) =>
  value === null ? "No data" : value.toFixed(1) + "%";
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function languageName(locale: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
  } catch {
    return "Not recorded";
  }
}
type Evidence = (ids: string[], label: string) => void;

export function MeasurementScope({
  measurement,
  observations,
  missing,
}: {
  measurement: Job;
  observations: Observation[];
  missing: number;
}) {
  const latest = observations.at(-1);
  const models = [
    ...new Set(observations.map((observation) => observation.model)),
  ];
  const retrieval = [...new Set(observations.map(retrievalLabel))];
  return (
    <div className="measurement-scope" aria-label="Current measurement scope">
      {measurement.provider &&
        !["chatgpt", "openrouter"].includes(measurement.provider) && (
          <span>
            <ProviderIcon provider={measurement.provider} size={16} />
            {measurement.provider === "console"
              ? "SurfacedBy"
              : providerLabels[measurement.provider]}
          </span>
        )}
      <span>
        <ProviderIcon
          provider={measurement.platform ?? latest?.platform ?? "unknown"}
          size={16}
        />
        {platformLabel(measurement.platform ?? latest?.platform ?? "unknown")}
      </span>
      <span>
        <CalendarDays size={14} />
        {dateTime(measurementTime(measurement))}
      </span>
      {measurement.status !== "completed" && (
        <span className="badge">{completedMeasurement(measurement) ? 'Answers ready' : ({ queued: 'Waiting to start', running: 'Collecting answers', paused: 'Paused', failed: 'Needs attention', cancelled: 'Stopped' } as Record<string, string>)[measurement.status] ?? measurement.status}</span>
      )}
      {missing > 0 && (
        <span className={['queued', 'running', 'paused'].includes(measurement.status) ? '' : 'scope-missing'}>{missing} {['queued', 'running', 'paused'].includes(measurement.status) ? 'answers remaining' : 'answers missing'}</span>
      )}
      <details>
        <summary>
          About this check <ChevronDown size={13} />
        </summary>
        <div>
          <p>
            Models:{" "}
            {models.length
              ? models.join(", ")
              : (measurement.model ?? "Provider selected")}
          </p>
          {retrieval.length > 0 && <p>{retrieval.join(" / ")}</p>}
          {latest?.locale && (
            <p>Answer language: {languageName(latest.locale)}</p>
          )}
          <p>
            Rates use collected answers. Missing answers are not counted as
            absent mentions. Answers collected through a connection can differ
            from answers on the provider's website.
          </p>
        </div>
      </details>
    </div>
  );
}

export function RateBar({
  value,
  color = "blue",
}: {
  value: number | null;
  color?: "blue" | "teal";
}) {
  return (
    <span className={"rate-cell " + color}>
      <span className="rate-track" aria-hidden="true">
        <span style={{ width: Math.min(100, Math.max(0, value ?? 0)) + "%" }} />
      </span>
      <span>{percent(value)}</span>
    </span>
  );
}

export function VisibilityChart({
  presentation,
  openVisibility,
}: {
  presentation: Presentation;
  openVisibility?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    id = useId();
  const history = presentation.history;
  const chartRef = useRef<SVGSVGElement>(null),
    [chartWidth, setChartWidth] = useState(600);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(Math.max(240, Math.round(entry.contentRect.width))),
    );
    observer.observe(chart);
    return () => observer.disconnect();
  }, [history.length > 0]);
  const active =
    history.find((point) => point.jobId === selected) ?? history.at(-1);
  const left = 43,
    right = chartWidth - 20,
    top = 18,
    bottom = 175;
  const start = history.length ? Date.parse(history[0].at) : 0;
  const span = history.length ? Date.parse(history.at(-1)!.at) - start : 0;
  const x = (index: number) =>
    span === 0
      ? (left + right) / 2
      : left +
        ((Date.parse(history[index].at) - start) / span) * (right - left);
  const y = (value: number) => bottom - (value / 100) * (bottom - top);
  const series = [
    { key: "mentionRate", label: "Brand mentions", color: "#0d6cf2" },
    { key: "citationRate", label: "Website citations", color: "#087f76" },
  ] as const;
  function segments(key: "mentionRate" | "citationRate") {
    const paths: { line: string; area: string }[] = [];
    let path = "", first = 0, last = 0;
    const finish = () => { if (path) paths.push({ line: path, area: path + ` L ${last} ${bottom} L ${first} ${bottom} Z` }); path = ""; };
    history.forEach((point, index) => {
      const value = point[key];
      if (value === null) {
        finish();
      } else { if (!path) first = x(index); last = x(index); path += (path ? " L " : "M ") + x(index) + " " + y(value); }
    });
    finish();
    return paths;
  }
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>Visibility over time</h2>
        {openVisibility && (
          <button className="text-button" onClick={openVisibility}>
            View checks <ArrowRight size={14} />
          </button>
        )}
      </div>
      {history.length ? (
        <div className="visibility-chart">
          <div className="chart-legend">
            {series.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          <svg
            ref={chartRef}
            viewBox={`0 0 ${chartWidth} 205`}
            aria-labelledby={id}
            role="group"
          >
            <title id={id}>
              Mention and citation rates in comparable checks. Percentages range
              from zero to one hundred. Missing checks are gaps.
            </title>
            <defs>{series.map(s => <linearGradient key={s.key} id={id + s.key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity=".14" /><stop offset="100%" stopColor={s.color} stopOpacity=".015" /></linearGradient>)}</defs>
            {[0, 25, 50, 75, 100].map((tick) => (
              <g key={tick}>
                <line
                  x1={left}
                  x2={right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="#e2e8f0"
                />
                <text x={left - 10} y={y(tick) + 4} textAnchor="end">
                  {tick}%
                </text>
              </g>
            ))}
            {series.map((s) => (
              <g key={s.key}>
                {segments(s.key).map((path, index) => (
                  <g key={index}><path d={path.area} fill={`url(#${id + s.key})`} /><path
                    d={path.line}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  /></g>
                ))}
                {history.map((point, index) =>
                  point[s.key] === null ? null : (
                    <g key={point.jobId}>
                      <circle
                        cx={x(index)}
                        cy={y(point[s.key]!)}
                        r={active?.jobId === point.jobId ? 5 : 4}
                        fill={s.color}
                        stroke="white"
                        strokeWidth="1.5"
                        aria-hidden="true"
                      />
                      <circle
                        className="chart-hit-target"
                        cx={x(index)}
                        cy={y(point[s.key]!)}
                        r="14"
                        fill="transparent"
                        tabIndex={0}
                        role="button"
                        aria-label={
                          s.label +
                          ", " +
                          new Date(point.at).toLocaleString() +
                          ", " +
                          percent(point[s.key])
                        }
                        onFocus={() => setSelected(point.jobId)}
                        onMouseEnter={() => setSelected(point.jobId)}
                        onClick={() => setSelected(point.jobId)}
                        onKeyDown={(event) => {
                          if (["Enter", " "].includes(event.key)) {
                            event.preventDefault();
                            setSelected(point.jobId);
                          }
                        }}
                      />
                    </g>
                  ),
                )}
              </g>
            ))}
            <text
              x={history.length === 1 ? x(0) : left}
              y="199"
              textAnchor={history.length === 1 ? "middle" : "start"}
            >
              {date(history[0].at)}
            </text>
            {history.length > 1 && (
              <text x={right} y="199" textAnchor="end">
                {date(history.at(-1)!.at)}
              </text>
            )}
          </svg>
          {active && (
            <div className="chart-readout" aria-live="polite">
              <time dateTime={active.at}>{dateTime(active.at)}</time>
              <span>
                Mentions <strong>{percent(active.mentionRate)}</strong>
              </span>
              <span>
                Citations <strong>{percent(active.citationRate)}</strong>
              </span>
            </div>
          )}
          <p className="chart-note">
            {history.length === 1
              ? "One check so far; recheck to see a trend."
              : "Comparable checks only. Gaps show incomplete checks."}
          </p>
          <details className="chart-data">
            <summary>
              View chart data <ChevronDown size={14} />
            </summary>
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">
                  Comparable visibility checks
                </caption>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Mentions</th>
                    <th>Citations</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((point) => (
                    <tr key={point.jobId}>
                      <td>{new Date(point.at).toLocaleString()}</td>
                      <td>{percent(point.mentionRate)}</td>
                      <td>{percent(point.citationRate)}</td>
                      <td>
                        {point.collected} / {point.requested}
                        {point.missing ? " (incomplete)" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : (
        <div className="analytics-empty">
          <p>
            {presentation.historyScopeAvailable
              ? "No completed checks in this collection scope yet."
              : "Finish a visibility check to start your history."}
          </p>
          <span>Comparable checks appear here as you recheck.</span>
        </div>
      )}
    </section>
  );
}

export function SourcesTable({
  presentation,
  collected,
  evidence,
  compact = false,
  openSources,
  projectId,
}: {
  presentation: Presentation;
  collected: number;
  evidence: Evidence;
  compact?: boolean;
  openSources?: () => void;
  projectId: string;
}) {
  const [mode, setMode] = useState<"domains" | "pages">("domains"),
    [search, setSearch] = useState("");
  const rows = presentation[mode].filter((row) =>
    (row.label + " " + row.url).toLowerCase().includes(search.toLowerCase()),
  );
  const shown = compact ? rows.slice(0, 6) : rows;
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>{compact ? "Most cited sources" : "Source coverage"}</h2>
        {openSources && (
          <button className="text-button" onClick={openSources}>
            View all <ArrowRight size={14} />
          </button>
        )}
      </div>
      {!compact && (
        <div className="analytics-toolbar">
          <div
            className="segmented-control"
            role="group"
            aria-label="Source grouping"
          >
            {(["domains", "pages"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === "domains" ? <Globe size={14} /> : <Link size={14} />}
                {value === "domains" ? "Domains" : "Pages"}
                <span>{presentation[value].length}</span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Search sources"
              placeholder="Find a source"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
      )}
      {shown.length ? (
        <div className="table-wrap">
          <table className="analytics-table source-coverage-table responsive-evidence-table">
            <caption className="visually-hidden">
              {mode === "domains" ? "Cited domains" : "Cited pages"}. Coverage
              counts each collected answer once per source.
            </caption>
            <thead>
              <tr>
                <th>Source</th>
                <th>Answer coverage</th>
                {!compact && mode === "domains" && <th>Pages</th>}
                <th>
                  <span className="visually-hidden">Evidence</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <SourceTableRow
                  key={row.key}
                  row={row}
                  collected={collected}
                  mode={mode}
                  compact={compact}
                  evidence={evidence}
                  projectId={projectId}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="analytics-empty">
          <p>{search ? "No matching sources" : "No citation links yet"}</p>
          <span>
            {search
              ? "Try another search."
              : "Sources appear when collected answers include verifiable links."}
          </span>
        </div>
      )}
      {shown.length > 0 && (
        <p className="chart-note table-note">
          Share of {collected} collected answers citing each source. Sources can
          overlap.
        </p>
      )}
    </section>
  );
}

function SourceTableRow({
  row,
  collected,
  mode,
  compact,
  evidence,
  projectId,
}: {
  row: SourceRow;
  collected: number;
  mode: "domains" | "pages";
  compact: boolean;
  evidence: Evidence;
  projectId: string;
}) {
  return (
    <tr>
      <td className="source-name">
        <a href={row.url} target="_blank" rel="noreferrer" title={row.url}>
          <SiteIcon projectId={projectId} domain={new URL(row.url).hostname} />
          <span>{row.label}</span>
          <ExternalLink size={12} />
        </a>
        {mode === "pages" && <small>{row.url}</small>}
      </td>
      <td>
        <RateBar value={row.answerRate} />
        <small>
          {row.answers} / {collected} answers
        </small>
      </td>
      {!compact && mode === "domains" && (
        <td className="source-page-count" data-label="Pages">
          {row.pages}
        </td>
      )}
      <td>
        <button
          className="text-button evidence-button"
          aria-label={"View answers citing " + row.label}
          onClick={() => evidence(row.observationIds, row.label)}
        >
          <span>Answers</span>
          <ArrowRight size={14} />
        </button>
      </td>
    </tr>
  );
}

export function PromptTable({
  rows,
  evidence,
  collecting = false,
}: {
  rows: PromptRow[];
  evidence: Evidence;
  collecting?: boolean;
}) {
  const [search, setSearch] = useState("");
  const shown = rows.filter((row) =>
    row.prompt.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>Question coverage</h2>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search questions"
            placeholder="Find a question"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {shown.length ? (
        <div className="table-wrap">
          <table className="analytics-table prompt-table responsive-evidence-table">
            <caption className="visually-hidden">
              Results for questions in the current measurement
            </caption>
            <thead>
              <tr>
                <th>Question</th>
                <th>Mentions</th>
                <th>Citations</th>
                <th>Collected</th>
                <th>
                  <span className="visually-hidden">Evidence</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.prompt}>
                  <td>{row.prompt}</td>
                  <td data-label="Mentions">
                    <RateBar value={row.mentionRate} />
                  </td>
                  <td data-label="Citations">
                    <RateBar value={row.citationRate} color="teal" />
                  </td>
                  <td data-label="Collected">
                    {row.collected}
                    {row.requested !== null ? " / " + row.requested : ""}
                    {row.missing !== null && row.missing > 0 && (
                      <small className={collecting ? '' : 'scope-missing'}>
                        {row.missing} {collecting ? 'remaining' : 'missing'}
                      </small>
                    )}
                  </td>
                  <td>
                    <button
                      className="text-button evidence-button"
                      disabled={!row.collected}
                      onClick={() => evidence(row.observationIds, row.prompt)}
                      aria-label={"View answers for " + row.prompt}
                    >
                      <span>Answers</span>
                      <ArrowRight size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="analytics-empty">
          <p>No matching questions</p>
        </div>
      )}
      <p className="chart-note table-note">
        Rates use collected answers for each question. No data means no
        collected answer.
      </p>
    </section>
  );
}

export function AnswerCard({ observation: o }: { observation: Observation }) {
  return (
    <article className="answer compact-answer">
      <div className="answer-meta">
        <span className="badge">
          <ProviderIcon provider={o.platform} size={14} />
          {platformLabel(o.platform)}
        </span>
        <time dateTime={o.observedAt}>{dateTime(o.observedAt)}</time>
      </div>
      <h3>{o.prompt}</h3>
      <p className="answer-preview">
        {o.answer.length > 260
          ? o.answer.slice(0, 260).trimEnd() + "..."
          : o.answer}
      </p>
      <div className="answer-outcomes">
        <span className={o.mentioned ? "outcome-positive" : ""}>
          {o.mentioned ? "Brand mentioned" : "Brand not detected"}
        </span>
        <span className={o.cited ? "outcome-positive" : ""}>
          {o.cited ? "Website cited" : "Website not cited"}
        </span>
        <span>{o.citations.length} source links</span>
      </div>
      <details className="answer-detail">
        <summary>
          Read full answer and sources <ChevronDown size={15} />
        </summary>
        <p className="answer-text">{o.answer}</p>
        <div className="answer-meta">
          <span>Provider-collected answer</span>
          <span>{retrievalLabel(o)}</span>
          <span>Model: {o.model}</span>
        </div>
        <ul>
          {o.citations
            .filter((c) => /^https?:\/\//.test(c.url))
            .map((c, index) => (
              <li key={index}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.title || c.url}
                  <ExternalLink size={12} />
                </a>
              </li>
            ))}
        </ul>
      </details>
    </article>
  );
}

export function AnswerDistribution({
  presentation,
  collected,
  requested,
  missing,
  evidence,
  collecting = false,
}: {
  presentation: Presentation;
  collected: number;
  requested: number;
  missing: number;
  evidence: Evidence;
  collecting?: boolean;
}) {
  const colors = { cited: "#0d6cf2", mentioned: "#087f76", absent: "#d99522" },
    circumference = 2 * Math.PI * 66;
  let offset = 0;
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>What the answers say</h2>
        <span>{collected} answers</span>
      </div>
      <div className="outcome-layout">
        <svg
          className="outcome-donut"
          viewBox="0 0 176 176"
          role="img"
          aria-label={presentation.outcomes
            .map((group) => `${group.label}: ${group.count}`)
            .join(". ")}
        >
          <circle
            cx="88"
            cy="88"
            r="66"
            fill="none"
            stroke="#edf2f7"
            strokeWidth="16"
          />
          {presentation.outcomes.map((group) => {
            const length = collected
              ? (group.count / collected) * circumference
              : 0;
            const start = offset;
            offset += length;
            return length ? (
              <circle
                key={group.kind}
                cx="88"
                cy="88"
                r="66"
                fill="none"
                stroke={colors[group.kind]}
                strokeWidth="16"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-start}
                transform="rotate(-90 88 88)"
              />
            ) : null;
          })}
          <text x="88" y="87" textAnchor="middle" className="donut-total">
            {collected}
          </text>
          <text x="88" y="108" textAnchor="middle" className="donut-caption">
            answers
          </text>
        </svg>
        <div className="outcome-legend">
          {presentation.outcomes.map((group) => (
            <button
              key={group.kind}
              disabled={!group.count}
              onClick={() => evidence(group.observationIds, group.label)}
            >
              <i style={{ background: colors[group.kind] }} />
              <span>{group.label}</span>
              <strong>{group.count}</strong>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="collection-coverage">
        <div>
          <span>Answers collected</span>
          <strong>
            {collected} / {requested}
          </strong>
        </div>
        <div className="coverage-track" aria-hidden="true">
          <span
            style={{
              width: requested
                ? Math.min(100, (collected / requested) * 100) + "%"
                : "0%",
            }}
          />
        </div>
        <small>
          {missing
            ? collecting ? `${missing} answers remaining. Results update as they arrive.` : `${missing} missing. These are not counted as absent mentions.`
            : "All requested answers were collected."}
        </small>
      </div>
    </section>
  );
}

type Competitor = {
  domain: string;
  citationRate: number | null;
  answersCiting: number;
  answersCollected: number;
  observationIds: string[];
};
export function CitationComparison({
  rows,
  projectId,
  ownDomain,
  evidence,
  openCompetitors,
}: {
  rows: Competitor[];
  projectId: string;
  ownDomain: string;
  evidence: Evidence;
  openCompetitors: () => void;
}) {
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>Website citations</h2>
        <button className="text-button" onClick={openCompetitors}>
          Compare <ArrowRight size={14} />
        </button>
      </div>
      <div className="citation-comparison">
        {rows.map((row) => (
          <div className="citation-comparison-row" key={row.domain}>
            <SiteIcon projectId={projectId} domain={row.domain} size={30} />
            <div>
              <div className="citation-comparison-label">
                <strong>{row.domain}</strong>
                {row.domain === ownDomain && <span>Your site</span>}
                <span>{percent(row.citationRate)}</span>
              </div>
              <div className="comparison-track" aria-hidden="true">
                <span style={{ width: (row.citationRate ?? 0) + "%" }} />
              </div>
              <small>
                {row.answersCiting} of {row.answersCollected} answers
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={"View answers citing " + row.domain}
              disabled={!row.answersCiting}
              onClick={() => evidence(row.observationIds, row.domain)}
            >
              <ArrowRight size={15} />
            </button>
          </div>
        ))}
      </div>
      <p className="chart-note table-note">
        Websites linked in the same set of answers. One answer can cite several
        sites.
      </p>
    </section>
  );
}

export function AuditEssentials({ audit }: { audit: Presentation["audit"] }) {
  if (!audit.pages) return null;
  const rows = [
    { label: "Page titles", count: audit.titles, Icon: FileText },
    { label: "Page descriptions", count: audit.descriptions, Icon: ListChecks },
    { label: "Structured data", count: audit.structuredData, Icon: Braces },
  ];
  return (
    <section className="panel analytics-panel">
      <div className="panel-heading">
        <h2>Page essentials</h2>
        <span>
          {audit.pages}{" "}
          {audit.pages === 1 ? "page inspected" : "pages inspected"}
        </span>
      </div>
      <div className="audit-essentials">
        {rows.map(({ label, count, Icon }) => (
          <div key={label}>
            <span className="essentials-icon">
              <Icon size={18} />
            </span>
            <div>
              <span>
                {label}
                <strong>
                  {count} / {audit.pages}
                </strong>
              </span>
              <div className="coverage-track" aria-hidden="true">
                <span style={{ width: (count / audit.pages) * 100 + "%" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      {audit.noindex > 0 && (
        <p className="chart-note table-note">
          {audit.noindex} inspected{" "}
          {audit.noindex === 1 ? "page asks" : "pages ask"} search engines not
          to index {audit.noindex === 1 ? "it" : "them"}.
        </p>
      )}
    </section>
  );
}
