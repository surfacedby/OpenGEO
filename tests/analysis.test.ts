import test from "node:test";
import assert from "node:assert/strict";
import {
  recheckComparison,
  competitorEvidence,
  comparisonKey,
} from "../server/analysis.js";
import type { Job, Project, Observation } from "../server/contracts.js";
test("recheck comparisons reject changed collection scope and incomplete evidence", () => {
  const project = {
    domain: "example.com",
    brand: "Example",
    aliases: [],
    prompts: ["A question?"],
    locale: "en-US",
    competitors: [],
  } as unknown as Project;
  const job = {
    kind: "recheck",
    status: "completed",
    provider: "dataforseo",
    platform: "chat_gpt",
    model: "m",
    updatedAt: "2026-09-30T00:00:00Z",
  } as Job;
  const obs = [{ model: "m", prompt: "A question?" }] as Observation[];
  const key = comparisonKey(project, job, obs);
  assert.notEqual(
    key,
    comparisonKey({ ...project, locale: "fr-FR" }, job, obs),
  );
  assert.notEqual(
    comparisonKey(project, job, [{ ...obs[0], surface: "api" }]),
    comparisonKey(project, job, [{ ...obs[0], surface: "consumer_interface" }]),
  );
  assert.notEqual(
    key,
    comparisonKey(project, job, [
      { model: "changed", prompt: "A question?" },
    ] as Observation[]),
  );
  const current = {
    ...job,
    id: "current",
    result: {
      comparisonKey: key,
      metrics: { missing: 0, mentionRate: 75, citationRate: 50 },
    },
  };
  const prior = {
    ...job,
    id: "prior",
    result: {
      comparisonKey: key,
      metrics: { missing: 0, mentionRate: 50, citationRate: 25 },
    },
  };
  assert.equal(recheckComparison([current, prior])?.mentionPoints, 25);
  assert.equal(
    recheckComparison([
      {
        ...current,
        result: {
          ...current.result,
          metrics: { ...current.result.metrics, missing: 1 },
        },
      },
      prior,
    ])?.status,
    "incomplete",
  );
  assert.equal(
    recheckComparison([
      current,
      { ...prior, result: { ...prior.result, comparisonKey: "different" } },
    ])?.status,
    "unavailable",
  );
  const context = competitorEvidence(
    { ...project, competitors: ["competitor.example"] },
    [
      {
        id: "one",
        citations: [
          { url: "https://competitor.example/source" },
          { url: "https://competitor.example/other" },
        ],
      },
    ] as Observation[],
  );
  assert.equal(context[0].answersCiting, 1);
  assert.equal(context[0].urls.length, 2);
});
