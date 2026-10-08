import test from "node:test";
import assert from "node:assert/strict";
import {
  comparableHistory,
  promptCoverage,
  sourceCoverage,
  workspacePresentation,
} from "../server/presentation.js";
import { displayedMeasurement } from "../server/portable-results.js";
import type { Job, Observation, PageEvidence } from "../server/contracts.js";

const answer = (
  id: string,
  prompt: string,
  citations: string[],
  mentioned = false,
): Observation => ({
  id,
  projectId: "project",
  jobId: "job",
  prompt,
  provider: "chatgpt",
  platform: "chat_gpt",
  model: "test-model",
  locale: "en-US",
  observedAt: "2026-10-01T10:00:00Z",
  answer: "Synthetic test evidence",
  surface: "api",
  citations: citations.map((url) => ({ url })),
  mentioned,
  cited: false,
  costUsd: 0,
});

test("answer outcomes are disjoint and missing requests never become absent mentions", () => {
  const cited = { ...answer("cited", "Question", []), cited: true };
  const mentioned = answer("mentioned", "Question", [], true);
  const absent = answer("absent", "Question", []);
  const result = workspacePresentation(
    [],
    undefined,
    [cited, mentioned, absent],
    ["Question", "Question", "Question", "Question"],
    4,
  );
  assert.deepEqual(
    result.outcomes.map((group) => [group.kind, group.count]),
    [
      ["cited", 1],
      ["mentioned", 1],
      ["absent", 1],
    ],
  );
  assert.equal(
    result.outcomes.reduce((total, group) => total + group.count, 0),
    3,
  );
  assert.deepEqual(result.outcomes[0].observationIds, ["cited"]);
  assert.equal(result.prompts[0].missing, 1);
});
const check = (id: string, at: string, key: string, missing = 0): Job => ({
  id,
  projectId: "project",
  kind: "measure",
  provider: "chatgpt",
  platform: "chat_gpt",
  model: "test-model",
  status: "completed",
  createdAt: at,
  updatedAt: at,
  step: 0,
  progress: "Done",
  error: null,
  spentUsd: 0,
  maxCostUsd: 0,
  render: false,
  webSearch: true,
  maxPages: 100,
  result: {
    comparisonKey: key,
    metrics: {
      requested: 2,
      completed: 2 - missing,
      missing,
      mentionRate: missing === 2 ? null : 50,
      citationRate: missing === 2 ? null : 0,
      citations: 0,
    },
  },
});

test("page essentials count only inspected pages and ignore blank metadata", () => {
  const page: PageEvidence = {
    id: "page",
    url: "https://example.com",
    fetchedAt: "2026-10-01T10:00:00Z",
    status: 200,
    title: "Example",
    description: " ",
    h1: [],
    text: "",
    canonical: "",
    noindex: false,
    schemaTypes: ["Article", "WebPage"],
    links: [],
  };
  const result = workspacePresentation([], undefined, [], [], 0, [
    page,
    {
      ...page,
      id: "other",
      title: " ",
      description: "Description",
      schemaTypes: [],
      noindex: true,
    },
  ]);
  assert.deepEqual(result.audit, {
    pages: 2,
    available: 2,
    titles: 1,
    descriptions: 1,
    structuredData: 1,
    noindex: 1,
  });
  assert.deepEqual(workspacePresentation([], undefined, [], [], 0).audit, {
    pages: 0,
    available: 0,
    titles: 0,
    descriptions: 0,
    structuredData: 0,
    noindex: 0,
  });
  const withError = workspacePresentation([], undefined, [], [], 0, [page, { ...page, id: "missing", status: 404, title: "Not found", description: "Missing page", noindex: true }]);
  assert.deepEqual(withError.audit, { pages: 2, available: 1, titles: 1, descriptions: 0, structuredData: 1, noindex: 0 });
});

test("source coverage deduplicates each answer and excludes unsafe links without inflating percentages", () => {
  const observations = [
    answer("one", "Question", [
      "https://www.example.com/a#one",
      "https://www.example.com/a#two",
      "https://www.example.com/b",
      "https://other.example/a",
      "not a url",
      "javascript:alert(1)",
      "https://private:secret@example.com/",
    ]),
    answer("two", "Other", ["https://www.example.com/a"]),
    answer("three", "Third", []),
  ];
  const result = sourceCoverage(observations);
  assert.equal(result.domains.length, 2);
  assert.equal(result.pages.length, 3);
  assert.equal(result.domains[0].key, "example.com");
  assert.equal(result.domains[0].pages, 2);
  assert.equal(result.domains[0].answers, 2);
  assert.equal(result.domains[0].answerRate, (2 / 3) * 100);
  assert.deepEqual(result.domains[0].observationIds, ["one", "two"]);
  assert.equal(result.pages[0].answers, 2);
  assert.ok(result.domains.every((row) => row.answerRate <= 100));
  assert.deepEqual(sourceCoverage([]), { domains: [], pages: [] });
});

test("prompt coverage preserves missing answers, duplicate requests and unknown historic plans", () => {
  const rows = promptCoverage(
    ["Repeated question", "Repeated question", "Missing question"],
    [answer("one", "Repeated question", [], true)],
    3,
  );
  assert.equal(rows[0].requested, 2);
  assert.equal(rows[0].collected, 1);
  assert.equal(rows[0].missing, 1);
  assert.equal(rows[0].mentionRate, 100);
  assert.equal(rows[1].missing, 1);
  assert.equal(rows[1].mentionRate, null);
  assert.equal(rows[1].citationRate, null);
  assert.equal(
    promptCoverage(null, [answer("one", "Historical question", [])], 5)[0]
      .requested,
    null,
  );
  assert.equal(
    promptCoverage(["Multi-platform question"], [], 4)[0].missing,
    null,
  );
  assert.equal(
    promptCoverage(
      ["Configured"],
      [answer("one", "Provider question", [])],
      1,
    )[1].requested,
    null,
  );
});

test("history uses only actual comparable completed checks and leaves incomplete checks as gaps", () => {
  const key = "a".repeat(64),
    otherKey = "b".repeat(64);
  const older = check("older", "2026-09-29T10:00:00Z", key),
    incomplete = check("incomplete", "2026-09-30T10:00:00Z", key, 1),
    current = check("current", "2026-10-01T10:00:00Z", key);
  const changed = check("changed", "2026-09-28T10:00:00Z", otherKey);
  const running = {
    ...check("running", "2026-10-02T10:00:00Z", key),
    status: "running" as const,
  };
  const result = comparableHistory(
    [running, current, changed, older, incomplete],
    current,
  );
  assert.deepEqual(
    result.history.map((point) => point.jobId),
    ["older", "incomplete", "current"],
  );
  assert.equal(result.history[1].mentionRate, null);
  assert.equal(result.history[1].citationRate, null);
  assert.equal(result.history[1].collected, 1);
  assert.equal(result.history[0].citationRate, 0);
  assert.deepEqual(comparableHistory([older], { ...running, result: null }), {
    history: [],
    historyScopeAvailable: false,
  });
  assert.deepEqual(comparableHistory([older]), {
    history: [],
    historyScopeAvailable: false,
  });
  assert.equal(comparableHistory([current], current).history.length, 1);
});

test("a failed or unstarted recheck never hides the last completed check", () => {
  const job = (id: string, status: Job["status"], createdAt: string) => ({ id, kind: "recheck", status, createdAt }) as Job;
  const done = job("done", "completed", "2026-10-01T10:00:00Z");
  const saved: Record<string, number> = { done: 6, failedEmpty: 0, failedPartial: 3, running: 2, queued: 0 };
  const pick = (...jobs: Job[]) => displayedMeasurement(jobs, (item) => saved[item.id] ?? 0)?.id;
  assert.equal(pick(job("failedEmpty", "failed", "2026-10-02T10:00:00Z"), done), "done");
  assert.equal(pick(job("failedPartial", "failed", "2026-10-02T10:00:00Z"), done), "done");
  assert.equal(pick(job("queued", "queued", "2026-10-02T10:00:00Z"), done), "done");
  assert.equal(pick(job("running", "running", "2026-10-02T10:00:00Z"), done), "running", "a newer run with saved answers is current");
  assert.equal(pick(job("failedPartial", "failed", "2026-10-02T10:00:00Z")), "failedPartial", "partial answers remain visible when nothing completed");
  assert.equal(pick(job("failedEmpty", "failed", "2026-10-02T10:00:00Z")), "failedEmpty");
});
