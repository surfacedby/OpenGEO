import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { chromium } from "playwright";
import { start } from "../server/main.js";
import { comparisonKey, summarize } from "../server/analysis.js";
import {
  projectInput,
  jobInput,
  type Observation,
} from "../server/contracts.js";

// Private regression captures are labelled test data and must not become public marketing examples.
const directory = mkdtempSync(join(tmpdir(), "opengeo-analytics-ui-"));
const output = join(
  process.env.LOCALAPPDATA ?? tmpdir(),
  "OpenGEO",
  "analytics-ux-review",
);
mkdirSync(output, { recursive: true });
const runtime = await start({
  directory,
  port: 0,
  protector: {
    encrypt: (text) => Buffer.from(text),
    decrypt: (bytes) => bytes.toString(),
  },
});
const browser = await chromium.launch({ ...(process.env.OPENGEO_TEST_BROWSER ? { executablePath: process.env.OPENGEO_TEST_BROWSER } : { channel: "chrome" }), headless: true });
const failures: string[] = [];
try {
  await runtime.runner.stop();
  runtime.scheduler.stop();
  runtime.store.createProject(
    projectInput.parse({
      domain: "example.org",
      brand: "Empty UX test",
      prompts: [],
    }),
  );
  const prompts = [
    "Synthetic review: explain example domains",
    "Synthetic review: explain example domains",
    "Synthetic review: choose documentation examples",
    "Synthetic review: compare sample websites",
  ];
  const project = runtime.store.createProject(
    projectInput.parse({
      domain: "example.com",
      brand: "UX test data",
      prompts,
      competitors: ["iana.org", "w3.org"],
    }),
  );
  runtime.store.set("onboarding", { completed: true });
  let currentId = "";
  for (let index = 0; index < 5; index++) {
    const at = `2026-09-${25 + index}T10:00:00.000Z`;
    const job = runtime.store.enqueue(
      jobInput.parse({
        projectId: project.id,
        kind: "measure",
        provider: "chatgpt",
        model: "synthetic-ui-model",
      }),
      randomUUID(),
    );
    const observations: Observation[] = prompts.flatMap((prompt, p) =>
      index === 2 && p === 1
        ? []
        : [
            {
              id: randomUUID(),
              projectId: project.id,
              jobId: job.id,
              prompt,
              provider: "chatgpt",
              platform: "chat_gpt",
              model: "synthetic-ui-model",
              locale: "en-US",
              observedAt: at,
              surface: "api",
              retrieval: "web_search",
              webSearchConfirmed: true,
              mentioned: p < [1, 2, 2, 3, 3][index],
              cited: p < [0, 1, 1, 2, 2][index],
              costUsd: 0,
              answer:
                "Synthetic **UX review evidence**. These are test records, not measured AI visibility. " +
                "Example domains are reserved for documentation and testing. ".repeat(
                  8,
                ) +
                "End of full test answer.",
              citations: [
                {
                  url: "https://www.iana.org/domains/reserved",
                  title: "IANA reserved domains",
                },
                {
                  url:
                    p < 2
                      ? "https://example.com/"
                      : "https://www.w3.org/standards/",
                  title: p < 2 ? "Example Domain" : "W3C standards",
                },
                {
                  url: "https://www.iana.org/domains/reserved#example",
                  title: "Duplicate citation",
                },
              ],
            },
          ],
    );
    const result = {
      metrics: summarize(observations, prompts.length),
      comparisonKey: comparisonKey(project, job, observations),
    };
    const saved = {
      ...job,
      status: "completed",
      progress: "Synthetic review; no supplier requests",
      createdAt: at,
      updatedAt: at,
      requestedAnswers: prompts.length,
      result,
    };
    runtime.store.db
      .prepare("UPDATE jobs SET status=?,body=? WHERE id=?")
      .run(saved.status, JSON.stringify(saved), job.id);
    runtime.store.setStep(job.id, "project", "completed", project);
    for (const observation of observations)
      runtime.store.put("observation", project.id, job.id, observation);
    currentId = job.id;
  }
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(
    "http://127.0.0.1:" + (runtime.app.server.address() as any).port,
  );
  await page
    .getByRole("heading", { name: "Visibility over time", exact: true })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  const projection = (
    await runtime.app.inject({
      url: `/api/projects/${project.id}/workspace`,
      headers: { authorization: "Bearer " + runtime.token },
    })
  ).json();
  assert.equal(projection.measurement.id, currentId);
  assert.equal(projection.presentation.history.length, 5);
  assert.equal(projection.presentation.history[2].mentionRate, null);
  assert.equal(projection.presentation.domains[0].answers, 4);
  assert.equal(projection.presentation.domains[0].answerRate, 100);
  assert.equal(projection.presentation.prompts[0].requested, 2);
  assert.deepEqual(
    projection.presentation.outcomes.map(
      (group: { count: number }) => group.count,
    ),
    [2, 1, 1],
  );
  assert.doesNotMatch(
    await page.locator(".measurement-scope").innerText(),
    /synthetic-ui-model|en-US|API/,
  );
  await page.locator(".measurement-scope summary").click();
  assert.match(
    await page.locator(".measurement-scope").innerText(),
    /synthetic-ui-model/,
  );
  await page.locator(".measurement-scope summary").click();
  await page
    .getByRole("button", { name: "Named without a link", exact: false })
    .click();
  assert.equal(await page.locator(".compact-answer").count(), 1);
  await navigate(page, "Overview");
  assert.equal(
    await page.locator('.visibility-chart > svg path[fill="none"]').count(),
    4,
    "Both series break at the incomplete check",
  );
  await page.locator(".visibility-chart circle[role=button]").first().focus();
  assert.match(await page.locator(".chart-readout").innerText(), /25\.0%/);
  await page.getByText("View chart data", { exact: true }).click();
  assert.equal(await page.locator(".chart-data tbody tr").count(), 5);
  assert.match(
    await page.locator(".chart-data tbody tr").nth(2).innerText(),
    /No data.*incomplete/,
  );
  await page.getByText("View chart data", { exact: true }).click();
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    for (const view of [
      "Overview",
      "Visibility",
      "Responses",
      "Sources",
      "Competitors",
    ]) {
      await navigate(page, view);
      await page.getByRole("heading", { name: view, exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector("main")?.scrollTop === 0,
      );
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        )
      ) {
        await page.screenshot({
          path: join(output, "overflow-diagnostic.png"),
        });
        console.log(
          await page.locator("main").evaluateAll((elements) =>
            elements.flatMap((root) =>
              [...root.querySelectorAll("*")]
                .filter(
                  (element) =>
                    element.getBoundingClientRect().right > innerWidth + 1,
                )
                .map((element) => ({
                  tag: element.tagName,
                  class: element.className,
                  width: element.getBoundingClientRect().width,
                  right: element.getBoundingClientRect().right,
                }))
                .slice(0, 12),
            ),
          ),
        );
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${view} at ${width}px`,
      );
      assert.equal(
        await page
          .locator("main button:visible")
          .evaluateAll((elements) =>
            elements.some(
              (element) => element.getBoundingClientRect().width < 24,
            ),
          ),
        false,
      );
      await page.screenshot({
        path: join(output, `${view.toLowerCase()}-${width}.png`),
        fullPage: view === "Overview",
      });
      if (view === "Overview") {
        await page
          .getByRole("heading", { name: "What the answers say", exact: true })
          .evaluate((heading) =>
            heading.closest("section")?.scrollIntoView({ block: "start" }),
          );
        await page.screenshot({
          path: join(output, `overview-details-${width}.png`),
        });
      }
    }
  }
  await navigate(page, "Competitors");
  const latest = runtime.store.job(currentId);
  runtime.store.updateJob(currentId, { result: { ...(latest.result as object), competitors: [{ name: "Documentation example", domain: "example.net", observationIds: runtime.store.observations(project.id, currentId).slice(0, 1).map(answer => answer.id) }] } });
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await page.getByRole("heading", { name: "Discover competitors", exact: true }).waitFor();
  const addCompetitors = page.getByRole("button", { name: "Add selected competitors", exact: true });
  assert.equal(await addCompetitors.isEnabled(), false);
  await page.getByRole("checkbox", { name: "Follow Documentation example", exact: true }).check();
  await addCompetitors.click();
  await page.getByRole('button', { name: 'Remove example.net from comparison', exact: true }).waitFor();
  assert.deepEqual(runtime.store.project(project.id).competitors, ["iana.org", "w3.org", "example.net"]);
  assert.deepEqual(runtime.store.project(project.id).prompts, prompts);
  assert.equal(await page.getByRole("heading", { name: "Discover competitors", exact: true }).count(), 0);
  assert.equal(
    await page
      .getByRole("textbox", { name: "Customer questions", exact: true })
      .count(),
    0,
  );
  await page.getByRole('textbox', { name: 'Add a competitor website', exact: true }).fill('example.net');
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByText('Comparison website added.', { exact: true }).waitFor();
  assert.deepEqual(runtime.store.project(project.id).competitors, [
    "iana.org",
    "w3.org",
    "example.net",
  ]);
  assert.deepEqual(runtime.store.project(project.id).prompts, prompts);
  const supporting = runtime.store.observations(project.id, currentId);
  runtime.store.updateJob(currentId, { result: { ...(latest.result as object),
    competitors: [{ name: 'W3C', domain: 'w3.org', role: 'both', reason: 'A comparison example backed by saved answers.', observationIds: supporting.filter(answer => answer.citations.some(citation => new URL(citation.url).hostname === 'www.w3.org')).map(answer => answer.id) }],
    references: [{ name: 'IANA', domain: 'iana.org', role: 'reference', reason: 'Provides documentation used in these answers.', observationIds: supporting.map(answer => answer.id) }],
  } });
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await page.getByRole('button', { name: 'View answers for W3C', exact: true }).click();
  await page.getByRole('heading', { name: 'Questions where your website wasn\'t cited', exact: true }).waitFor();
  assert.equal(await page.locator('.competitor-detail-grid > div').first().getByRole('link').count(), 2);
  assert.equal(await page.locator('.competitor-detail-grid > div').last().getByRole('link').count(), 1);
  await page.locator('.competitor-detail-grid > div').first().getByRole('link').first().click();
  assert.equal(await page.locator('.competitor-full-answers').getAttribute('open'), '');
  assert.equal(await page.locator('.competitor-full-answers .answer').count(), 2);
  await page.getByRole('button', { name: /^References/ }).click();
  await page.getByText('Provides documentation used in these answers.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Follow IANA', exact: true }).count(), 0);
  assert.equal(runtime.store.project(project.id).competitors.includes('example.org'), false);
  await navigate(page, "Sources");
  await page.getByRole("button", { name: /^Pages/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: /^Pages/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page
    .getByRole("textbox", { name: "Search sources", exact: true })
    .fill("no-such-source");
  await page.getByText("No matching sources", { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Search sources", exact: true })
    .fill("");
  await page
    .getByRole("button", {
      name: "View answers citing IANA reserved domains",
      exact: true,
    })
    .click();
  await page.getByRole("heading", { name: "Responses", exact: true }).waitFor();
  assert.equal(await page.locator(".compact-answer").count(), 4);
  await page.locator(".answer-detail summary").first().focus();
  await page.keyboard.press("Enter");
  assert.match(
    await page.locator(".answer-detail[open]").innerText(),
    /End of full test answer\./,
  );
  assert.equal(await page.locator('.answer-detail[open] .answer-document strong').innerText(), 'UX review evidence');
  assert.equal(await page.locator('.answer-detail[open] .answer-sources .site-icon').count(), 3);
  assert.ok((await page.locator('.answer-detail[open] .answer-sources a').first().getAttribute('href'))?.startsWith('https://'));
  await page
    .getByRole("button", { name: "Show all answers", exact: true })
    .click();
  assert.equal(await page.locator(".evidence-filter").count(), 0);
  await navigate(page, "Visibility");
  await page
    .getByRole("button", {
      name: "View answers for Synthetic review: compare sample websites",
      exact: true,
    })
    .click();
  assert.equal(await page.locator(".compact-answer").count(), 1);
  await navigate(page, "Visibility");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Customer questions", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Edit questions", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Question 1", exact: true })
    .waitFor();
  assert.deepEqual(
    await page.locator(".inline-question").allTextContents(),
    prompts,
  );
  const editedQuestion = "Synthetic review: find useful documentation examples";
  await page.getByRole("textbox", { name: "Question 1", exact: true }).fill(editedQuestion);
  await page.getByRole("checkbox", { name: "Include question 4", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save questions", exact: true }).click();
  await page.getByText("Questions and website details saved.", { exact: true }).waitFor();
  assert.deepEqual(runtime.store.project(project.id).prompts, [
    editedQuestion,
    prompts[1],
    prompts[2],
  ]);
  assert.deepEqual(runtime.store.project(project.id).competitors, [
    "iana.org",
    "w3.org",
    "example.net",
  ]);
  const empty = runtime.store
    .projects()
    .find((item) => item.brand === "Empty UX test")!;
  const emptyWorkspace = (
    await runtime.app.inject({
      url: `/api/projects/${empty.id}/workspace`,
      headers: { authorization: "Bearer " + runtime.token },
    })
  ).json();
  assert.equal(emptyWorkspace.metrics.mentionRate, null);
  assert.deepEqual(emptyWorkspace.presentation.history, []);
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify({
      output,
      viewportChecks: 15,
      tests:
        "plain main-screen copy, optional measurement details, answer outcomes, comparison settings preservation, gaps, zero values, deduplication, source grouping/search/drill-down, question drill-down, keyboard answers/chart, editable questions and empty history",
      providerRequests: 0,
      rendererErrors: failures.length,
    }),
  );
} finally {
  await browser.close();
  await runtime.app.close();
  const child = relative(resolve(tmpdir()), resolve(directory));
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("Refusing cleanup outside the temporary test root");
  rmSync(directory, { recursive: true, force: true });
}
