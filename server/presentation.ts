import type { Finding, Job, Observation, PageEvidence } from "./contracts.js";
import { portableJobResult, completedMeasurement } from "./portable-results.js";

export type SourceRow = {
  key: string;
  label: string;
  url: string;
  pages: number;
  answers: number;
  answerRate: number;
  observationIds: string[];
};
export type PromptRow = {
  prompt: string;
  requested: number | null;
  collected: number;
  missing: number | null;
  mentionRate: number | null;
  citationRate: number | null;
  observationIds: string[];
};
export type HistoryPoint = {
  jobId: string;
  at: string;
  collected: number;
  requested: number;
  missing: number;
  mentionRate: number | null;
  citationRate: number | null;
};
export type Presentation = {
  domains: SourceRow[];
  pages: SourceRow[];
  prompts: PromptRow[];
  history: HistoryPoint[];
  historyScopeAvailable: boolean;
  outcomes: {
    label: string;
    count: number;
    observationIds: string[];
    kind: "cited" | "mentioned" | "absent";
  }[];
  audit: {
    pages: number;
    titles: number;
    descriptions: number;
    structuredData: number;
    noindex: number;
  };
};

/** Fresh plans replace unstarted suggestions; accepted work keeps its progress across rechecks. */
export function currentFindings(findings: Finding[], jobs: Job[]) {
  const audit = jobs.find(job => job.kind === 'audit' && job.status === 'completed');
  const measurement = jobs.find(completedMeasurement);
  const analysis = jobs.find(job => job.kind === 'diagnose' && job.status === 'completed');
  const generations = new Map(jobs.map(job => [job.id, job]));
  return findings.filter(finding => {
    if (finding.kind === 'visibility') return false;
    if (finding.status !== 'open') return true;
    const job = generations.get(finding.jobId);
    if (!job) return true;
    if (job.kind === 'audit') return job.id === audit?.id;
    if (job.kind === 'diagnose') {
      const period = (job.result as { measurementJobId?: string } | null)?.measurementJobId;
      return job.id === analysis?.id && (!measurement || (period ? period === measurement.id : job.createdAt >= measurement.createdAt));
    }
    if (['measure', 'recheck'].includes(job.kind)) return job.id === measurement?.id;
    return true;
  });
}

/** Count answers rather than links: one answer citing a domain repeatedly is one observation. */
export function sourceCoverage(observations: Observation[]) {
  const domains = new Map<
    string,
    { url: string; pages: Set<string>; ids: Set<string> }
  >();
  const pages = new Map<string, { label: string; ids: Set<string> }>();
  for (const observation of observations) {
    for (const citation of observation.citations) {
      let url: URL;
      try {
        url = new URL(citation.url);
      } catch {
        continue;
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      url.hash = "";
      const page = url.href,
        domain = url.hostname.replace(/^www\./, "");
      const p = pages.get(page) ?? {
        label: citation.title?.trim() || page,
        ids: new Set<string>(),
      };
      p.ids.add(observation.id);
      pages.set(page, p);
      const d = domains.get(domain) ?? {
        url: url.origin,
        pages: new Set<string>(),
        ids: new Set<string>(),
      };
      d.pages.add(page);
      d.ids.add(observation.id);
      domains.set(domain, d);
    }
  }
  const denominator = new Set(observations.map((observation) => observation.id))
    .size;
  const rate = (n: number) => (denominator ? (n / denominator) * 100 : 0);
  const sort = (a: SourceRow, b: SourceRow) =>
    b.answers - a.answers || a.key.localeCompare(b.key);
  return {
    domains: [...domains]
      .map(([key, d]) => ({
        key,
        label: key,
        url: d.url,
        pages: d.pages.size,
        answers: d.ids.size,
        answerRate: rate(d.ids.size),
        observationIds: [...d.ids],
      }))
      .sort(sort),
    pages: [...pages]
      .map(([key, p]) => ({
        key,
        label: p.label,
        url: key,
        pages: 1,
        answers: p.ids.size,
        answerRate: rate(p.ids.size),
        observationIds: [...p.ids],
      }))
      .sort(sort),
  };
}

/** Only a frozen, exact request plan can identify which questions have missing answers. */
export function promptCoverage(
  prompts: string[] | null,
  observations: Observation[],
  requested: number,
): PromptRow[] {
  const planned = new Map<string, number>();
  for (const prompt of prompts ?? [])
    planned.set(prompt, (planned.get(prompt) ?? 0) + 1);
  const exactPlan = prompts !== null && prompts.length === requested;
  const grouped = new Map<string, Observation[]>();
  for (const observation of observations) {
    const group = grouped.get(observation.prompt) ?? [];
    group.push(observation);
    grouped.set(observation.prompt, group);
  }
  return [...new Set([...planned.keys(), ...grouped.keys()])].map((prompt) => {
    const answers = grouped.get(prompt) ?? [],
      expected = exactPlan && planned.has(prompt) ? planned.get(prompt)! : null;
    return {
      prompt,
      requested: expected,
      collected: answers.length,
      missing:
        expected === null ? null : Math.max(0, expected - answers.length),
      mentionRate: answers.length
        ? (answers.filter((o) => o.mentioned).length / answers.length) * 100
        : null,
      citationRate: answers.length
        ? (answers.filter((o) => o.cited).length / answers.length) * 100
        : null,
      observationIds: answers.map((o) => o.id),
    };
  });
}

/** A trend includes only saved checks with the current comparison key; incomplete checks remain gaps. */
export function comparableHistory(jobs: Job[], measurement?: Job) {
  const current = measurement ? portableJobResult(measurement) : null;
  if (!current)
    return { history: [] as HistoryPoint[], historyScopeAvailable: false };
  const history = jobs
    .filter(completedMeasurement)
    .flatMap((job) => {
      const result = portableJobResult(job);
      if (
        !result ||
        result.comparisonKey !== current.comparisonKey ||
        !Number.isFinite(Date.parse(result.collectionCompletedAt ?? job.updatedAt))
      )
        return [];
      return [
        {
          jobId: job.id,
          at: result.collectionCompletedAt ?? job.updatedAt,
          collected: result.metrics.completed,
          requested: result.metrics.requested,
          missing: result.metrics.missing,
          mentionRate: result.metrics.missing
            ? null
            : result.metrics.mentionRate,
          citationRate: result.metrics.missing
            ? null
            : result.metrics.citationRate,
        },
      ];
    })
    .sort(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) || a.jobId.localeCompare(b.jobId),
    );
  return { history, historyScopeAvailable: true };
}

export function workspacePresentation(
  jobs: Job[],
  measurement: Job | undefined,
  observations: Observation[],
  prompts: string[] | null,
  requested: number,
  auditPages: PageEvidence[] = [],
): Presentation {
  return {
    ...sourceCoverage(observations),
    prompts: promptCoverage(prompts, observations, requested),
    ...comparableHistory(jobs, measurement),
    audit: {
      pages: auditPages.length,
      titles: auditPages.filter((page) => page.title.trim()).length,
      descriptions: auditPages.filter((page) => page.description.trim()).length,
      structuredData: auditPages.filter((page) => page.schemaTypes.length)
        .length,
      noindex: auditPages.filter((page) => page.noindex).length,
    },
    outcomes: (
      [
        {
          label: "Website cited",
          kind: "cited",
          answers: observations.filter((answer) => answer.cited),
        },
        {
          label: "Named without a link",
          kind: "mentioned",
          answers: observations.filter(
            (answer) => answer.mentioned && !answer.cited,
          ),
        },
        {
          label: "Brand not detected",
          kind: "absent",
          answers: observations.filter(
            (answer) => !answer.mentioned && !answer.cited,
          ),
        },
      ] as const
    ).map((group) => ({
      label: group.label,
      kind: group.kind,
      count: group.answers.length,
      observationIds: group.answers.map((answer) => answer.id),
    })),
  };
}
