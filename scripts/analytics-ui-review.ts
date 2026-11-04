import { navigate } from "./ui-navigation.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { chromium } from "playwright";
import { start } from "../server/main.js";
import { comparisonKey, summarize } from "../server/analysis.js";
import { parsePage } from '../server/audit.js';
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
  const campaign = { id: randomUUID(), name: "Documentation examples", goal: "Answers about example domains link to the example page.", prompts: [prompts[0], prompts[2]], targetUrls: ["https://example.com/"], competitors: ["iana.org"], reviewBy: "2026-10-01", status: "active", createdAt: "2026-09-20T10:00:00.000Z" };
  assert.equal((await runtime.app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, headers: { authorization: "Bearer " + runtime.token }, payload: { campaigns: [campaign] } })).statusCode, 200);
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
  assert.deepEqual(projection.campaigns.map((item: { questions: number; targets: number; targetsCited: number }) => [item.questions, item.targets, item.targetsCited]), [[3, 1, 1]]);
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
      "Prompts",
      "Campaigns",
      "Responses",
      "Sources",
      "Competitors",
      "Scans",
      "Opportunities",
      "Content",
      "Reports",
      "Brand",
      "Settings",
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
      assert.deepEqual(await page.locator('.page-heading').evaluateAll(headings => headings.flatMap(heading => {
        const bounds = heading.getBoundingClientRect();
        return [...heading.children].filter(child => {
          const rect = child.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
        }).map(child => child.textContent);
      })), [], `${view} header contents must fit at ${width}px`);
      await page.screenshot({
        path: join(output, `${view.toLowerCase()}-${width}.png`),
        fullPage: view === "Overview",
      });
      // The workspace scrolls inside main, so a page screenshot alone misses lower panels.
      const charts = page.locator('.visibility-chart > svg');
      for (let index = 0; index < await charts.count(); index++) {
        const chart = charts.nth(index);
        await chart.scrollIntoViewIfNeeded();
        assert.deepEqual(await chart.evaluate(svg => {
          const bounds = svg.getBoundingClientRect();
          return [...svg.querySelectorAll('text')].filter(label => {
            const box = label.getBoundingClientRect();
            return box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1;
          }).map(label => label.textContent);
        }), [], `${view} chart labels at ${width}px`);
        assert.ok((await chart.boundingBox())!.height >= 205, 'Chart must not shrink in a flex panel');
        await chart.locator('xpath=ancestor::section[1]').screenshot({ path: join(output, `${view.toLowerCase()}-chart-${width}.png`) });
      }
      await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(output, `${view.toLowerCase()}-bottom-${width}.png`) });
      if (view === 'Settings') {
        for (const tab of ['Schedules', 'Data & privacy', 'About']) {
          await page.getByRole('tab', { name: tab, exact: true }).click();
          await page.getByRole('tabpanel').waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${tab} at ${width}px`);
          await page.getByRole('tabpanel').screenshot({ path: join(output, `settings-${tab.replaceAll(/[^a-z]/gi, '-')}-${width}.png`) });
        }
      }
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
  // Campaign screens: the list and each tab of one campaign, then the lens over the evidence screens.
  for (const width of [1360, 760, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 780 : 900 });
    await navigate(page, "Campaigns");
    await page.getByRole("button", { name: campaign.name, exact: true }).click();
    await page.getByRole("heading", { name: campaign.name, exact: true }).waitFor();
    for (const tab of ["Results", "Questions", "Target pages", "Competitors", "Checks"]) {
      await page.getByRole("tab", { name: new RegExp("^" + tab) }).click();
      if (tab === "Target pages") assert.match(await page.getByRole("tabpanel").innerText(), /Cited in 2 of 3 answers/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Campaign ${tab} at ${width}px`);
      await page.screenshot({ path: join(output, `campaign-${tab.toLowerCase().replaceAll(" ", "-")}-${width}.png`), fullPage: true });
    }
    await navigate(page, "Visibility");
    await page.getByRole("button", { name: width === 1360 ? "Campaign" : "Mobile campaign", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(campaign.name) }).click();
    await page.getByText("Showing 3 of 4 questions", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Check these 3 questions", exact: true }).waitFor();
    for (const view of ["Visibility", "Responses", "Sources", "Competitors"]) {
      await navigate(page, view);
      await page.getByRole("heading", { name: view, exact: true }).waitFor();
      await page.locator(".workspace-loading").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} for a campaign at ${width}px`);
      await page.screenshot({ path: join(output, `campaign-lens-${view.toLowerCase()}-${width}.png`) });
    }
    await page.getByRole("button", { name: width === 1360 ? "Campaign" : "Mobile campaign", exact: true }).click();
    await page.getByRole("option", { name: /All questions/ }).click();
    await navigate(page, "Prompts");
    await page.getByRole("button", { name: /^No campaign/ }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Grouped prompts at ${width}px`);
    await page.screenshot({ path: join(output, `prompts-grouped-${width}.png`) });
    await navigate(page, "Campaigns");
    await page.getByRole("button", { name: "New campaign", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New campaign" });
    await editor.getByLabel("Campaign name").waitFor();
    assert.equal(await editor.getByRole("button", { name: "Create campaign", exact: true }).isDisabled(), true);
    await editor.screenshot({ path: join(output, `campaign-dialog-${width}.png`) });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
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
  await page.getByRole('button', { name: 'View answers for W3C', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'View answers for iana.org', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Remove iana.org from comparison', exact: true }).count(), 1);
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
  const answerOpener = page.getByRole('button', { name: 'Read full answer and sources', exact: true }).first();
  await answerOpener.focus();
  await page.keyboard.press("Enter");
  assert.match(
    await page.getByRole('dialog', { name: 'Answer and sources', exact: true }).innerText(),
    /End of full test answer\./,
  );
  assert.equal(await page.locator('.answer-reader .answer-document strong').innerText(), 'UX review evidence');
  assert.equal(await page.locator('.answer-reader .answer-sources .site-icon').count(), 3);
  assert.ok((await page.locator('.answer-reader .answer-sources a').first().getAttribute('href'))?.startsWith('https://'));
  await page.screenshot({ path: join(output, 'answer-drawer-mobile.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Answer and sources', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await answerOpener.evaluate(element => element === document.activeElement), true, 'Closing the drawer restores keyboard focus');
  for (const [label, count] of [['Cited', 2], ['Named only', 1], ['Not mentioned', 1], ['All answers', 4]] as const) {
    await page.getByRole('group', { name: 'Filter answers by outcome' }).getByRole('button', { name: new RegExp('^' + label) }).click();
    assert.equal(await page.locator('.compact-answer').count(), count);
  }
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
  await navigate(page, "Prompts");
  await page
    .getByRole("button", { name: "Add or edit prompts", exact: true })
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
  await page.getByRole("button", { name: "Save prompts", exact: true }).click();
  await page.getByText("Prompts saved. Your next visibility check will use this list.", { exact: true }).waitFor();
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
  // Exercise the shared unsaved-changes dialog against real local draft persistence.
  const draft = { id: randomUUID(), topic: 'Synthetic design review draft', markdown: '# Review\n\nOriginal.', brief: 'Test data.', createdAt: new Date().toISOString(), locale: 'en-US', reviewCurrent: true, sourceEvidence: [], review: { issues: [] } };
  runtime.store.put('content', project.id, currentId, draft);
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await navigate(page, 'Content');
  await page.getByRole('group', { name: 'Filter draft review' }).getByRole('button', { name: /^Needs review/ }).click();
  await page.getByRole('heading', { name: 'No drafts waiting for review', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show all drafts', exact: true }).click();
  await page.getByRole('button', { name: 'Open draft: ' + draft.topic, exact: true }).click();
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Draft for ' + draft.topic, exact: true }).fill('# Review\n\nSaved locally.');
  await navigate(page, 'Overview');
  const unsaved = page.getByRole('dialog', { name: 'Save your changes?', exact: true });
  await unsaved.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Draft for ' + draft.topic, exact: true }).inputValue(), '# Review\n\nSaved locally.');
  await navigate(page, 'Overview');
  await unsaved.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  assert.equal(runtime.store.artifacts<any>(project.id, 'content').find(item => item.id === draft.id).markdown, '# Review\n\nSaved locally.');
  const audit = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'synthetic-design-audit');
  runtime.store.put('page', project.id, audit.id, parsePage('https://example.com/', 200, '<title>Example domain</title><h1>Example domain</h1><p>Synthetic interface review, not a live audit.</p>'));
  runtime.store.updateJob(audit.id, { status: 'completed' });
  const diagnosis = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'diagnose', provider: 'chatgpt', maxCostUsd: 0 }), 'synthetic-design-diagnosis');
  runtime.store.updateJob(diagnosis.id, { status: 'completed', result: { measurementJobId: currentId } });
  const finding = { id: randomUUID(), projectId: project.id, jobId: diagnosis.id, title: 'Explain the example domain purpose', description: 'Synthetic review finding supported by the example page.', priority: 'medium', targetUrl: 'https://example.com/', evidenceIds: [], steps: ['Review the existing explanation before editing.'], confidence: 'inferred', status: 'open', kind: 'analysis' };
  runtime.store.put('finding', project.id, diagnosis.id, finding);
  runtime.store.put('finding', project.id, audit.id, { ...finding, id: randomUUID(), jobId: audit.id, title: 'Synthetic heading check', kind: 'heading' });
  await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
  await navigate(page, 'Scans');
  await page.getByRole('textbox', { name: 'Search audited pages' }).fill('does-not-exist');
  await page.getByRole('heading', { name: 'No matching pages', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show all pages', exact: true }).click();
  await page.locator('.audit-pages-table summary').first().click();
  assert.equal(await page.locator('.audit-pages-table details[open] li').first().innerText(), 'Example domain');
  await page.getByRole('button', { name: /^Unavailable/ }).click();
  await page.getByRole('heading', { name: 'No unavailable pages in this audit', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show all pages', exact: true }).click();
  for (const width of [1360, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['Scans', 'Opportunities', 'Content']) {
      await navigate(page, view);
      if (view === 'Opportunities') await page.locator('.improvement-group > summary').getByText(finding.title, { exact: true }).waitFor();
      if (view === 'Scans') await page.getByText('Synthetic heading check', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} populated at ${width}px`);
      await page.screenshot({ path: join(output, `${view.toLowerCase()}-loaded-${width}.png`) });
    }
    await page.getByRole('button', { name: 'Open draft: ' + draft.topic, exact: true }).click();
    await page.getByRole('heading', { name: draft.topic, exact: true }).waitFor();
    await page.screenshot({ path: join(output, `content-editor-${width}.png`) });
  }
  for (const width of [1360, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: width === 1360 ? 'Website' : 'Mobile website', exact: true }).click();
    await page.getByRole('option', { name: /example.org/ }).click();
    for (const view of ['Overview', 'Visibility', 'Campaigns', 'Responses', 'Sources', 'Competitors', 'Scans', 'Opportunities', 'Content', 'Reports']) {
      await navigate(page, view);
      await page.getByRole('heading', { name: view, exact: true }).waitFor();
      await page.locator('.workspace-loading').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} empty at ${width}px`);
      await page.screenshot({ path: join(output, `${view.toLowerCase()}-empty-${width}.png`) });
    }
  }
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify({
      output,
      viewportChecks: 39,
      populatedViewportChecks: 6,
      emptyViewportChecks: 20,
      campaignViewportChecks: 30,
      settingsTabChecks: 9,
      tests:
        "all thirteen screens, campaign list, tabs, lens and grouped prompts, populated audit/opportunities/content, optional measurement details, outcome filters, comparison settings preservation, gaps, zero values, deduplication, source grouping/search/drill-down, question drill-down, keyboard answer drawer/chart, editable questions, empty history and unsaved-draft persistence",
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
