import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { Connections } from '../server/oauth.js';
import { Providers } from '../server/providers.js';
import { Runner, mergePageTasks } from '../server/workflows.js';
import { parsePage } from '../server/audit.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { prompts } from '../server/prompts.js';
import { contentSources } from '../server/evidence-context.js';
import { exportProject } from '../server/export.js';
import { importProject, previewImport } from '../server/import.js';
import { withoutEvidenceList } from '../server/finding-text.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-evidence-')), store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('chatgpt', { active: 'fixture', profiles: [{ id: 'fixture', access_token: 'synthetic-access', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }] });
  const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: ['How can our team organize customer questions?'] }));
  const audit = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'audit');
  const pages = Array.from({length:100}, (_, index) => parsePage('https://example.com/page/' + index, 200,
    '<title>Support workspace</title><h1>Organize customer questions</h1><p>' + 'A shared support workspace keeps customer questions organized. '.repeat(170) + '</p>'));
  for (const page of pages) store.put('page', project.id, audit.id, page);
  store.updateJob(audit.id, {status:'completed'});
  const measurement = store.enqueue(jobInput.parse({projectId:project.id,kind:'measure',provider:'chatgpt'}), 'measurement');
  store.put('observation', project.id, measurement.id, {id:randomUUID(),projectId:project.id,jobId:measurement.id,prompt:project.prompts[0],provider:'chatgpt',platform:'chat_gpt',model:'fixture',locale:'en-US',observedAt:new Date().toISOString(),answer:'A shared support workspace can help.',citations:[],surface:'api',mentioned:false,cited:false,costUsd:0});
  store.updateJob(measurement.id, {status:'completed'});
  return {store,project,pages,audit,measurement,runner,async close(){connections.close();await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});}};
}
const json = (value:unknown) => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
const stream = (text:string) => new Response('data: ' + JSON.stringify({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text}]}]}}) + '\n\n');

test('reader explanations omit only a trailing list of their verified structured evidence references', () => {
  const page = randomUUID(), answer = randomUUID();
  assert.equal(withoutEvidenceList('Explain the supported workflow. Evidence: ' + page + ', ' + answer + '.', [page, answer]), 'Explain the supported workflow.');
  assert.equal(withoutEvidenceList('Sources: ' + page, [page]), '');
  const prose = 'The resource discusses sources and evidence without an identifier list.';
  assert.equal(withoutEvidenceList(prose, [page]), prose);
  const unknown = 'Review the evidence. Evidence: ' + randomUUID();
  assert.equal(withoutEvidenceList(unknown, [page]), unknown);
});

test('related same-page tasks merge evidence and instructions without merging distinct work', () => {
  const task = { targetPageId: 'page-one', title: 'Explain the supported workflow', priority: 'medium' as const, evidenceIds: ['page-one', 'answer-one'], steps: ['Check the current explanation.', 'Add the supported example.'], opportunity: { type: 'page_update' } };
  const merged = mergePageTasks([
    task,
    { ...task, priority: 'high' as const, evidenceIds: ['page-one', 'answer-two'], steps: ['Check the current explanation.', 'Link the relevant instructions.'] },
    { ...task, targetPageId: 'page-two' },
    { ...task, title: 'Explain a different workflow' },
    { ...task, opportunity: { type: 'new_content' } },
  ]);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0].steps, ['Check the current explanation.', 'Add the supported example.', 'Link the relevant instructions.']);
  assert.deepEqual(merged[0].evidenceIds, ['page-one', 'answer-one', 'answer-two']);
  assert.equal(merged[0].priority, 'high');
  assert.deepEqual(task.steps, ['Check the current explanation.', 'Add the supported example.']);
  assert.equal(task.priority, 'medium');
});

test('large audits are fully analyzed in durable batches across quota and later site changes', async () => {
  const f=fixture(), original=globalThis.fetch, reviewed=new Set<string>();
  let calls=0, quota=true;
  globalThis.fetch=(async (url,init) => {
    if(String(url).endsWith('/models')) return json({models:[{slug:'fixture',display_name:'Fixture',visibility:'list',context_window:32768}]});
    calls++;
    if(calls===2 && quota) return new Response('{}',{status:429});
    const request=JSON.parse(init!.body as string), input=JSON.parse(request.input[0].content);
    assert.ok(Buffer.byteLength(request.instructions + request.input[0].content,'utf8')+5096<=32768);
    if(request.instructions===prompts.contentGaps) {
      assert.equal(input.website,undefined,'The same website excerpts must not be included twice');
      assert.equal(input.coverage.pagesAvailable,100);
      assert.equal(input.catalog.length,100);
      assert.ok(input.pages.length>0);
      return stream(JSON.stringify({recommendations:[],uncertainties:[]}));
    }
    if(request.instructions===prompts.opportunityReview) return stream(JSON.stringify({accepted:input.candidates.map((item:any)=>({index:item.index,targetPageId:item.targetPageId,evidenceIds:item.evidenceIds,title:item.title,description:item.description,steps:item.steps,opportunity:{type:'page_update',pageLabel:'Resource',pageTitle:'Support workspace',benefit:'Explain the workflow relevant to the saved customer question.'}}))}));
    if(request.instructions===prompts.consolidate) {
      assert.equal(input.candidates.length,100);
      return stream(JSON.stringify({groups:[{primaryIndex:0,indices:input.candidates.map((item:any)=>item.index)}]}));
    }
    for(const page of input.pages) {assert.ok(!reviewed.has(page.id),'Completed batches cannot replay');reviewed.add(page.id);}
    return stream(JSON.stringify({recommendations:input.pages.map((page:any)=>({title:'Clarify the supported workflow',description:'Confirm whether this page explains how teams organize their questions.',priority:'medium',targetPageId:page.id,evidenceIds:[page.id,input.observations[0].id],steps:['Review the published page and add a supported explanation where needed.']})),uncertainties:[]}));
  }) as typeof fetch;
  try {
    const job=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'analysis');
    assert.equal(f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'analysis').id,job.id);
    assert.throws(()=>f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'diagnose',provider:'chatgpt'}),'duplicate'));
    await f.runner.tick();assert.equal(f.store.job(job.id).error,'quota');
    f.store.updateJob(f.audit.id,{status:'failed'});f.store.updateJob(f.measurement.id,{status:'failed'});
    quota=false;f.runner.resume(job.id,false);await f.runner.tick();
    assert.equal(f.store.job(job.id).status,'completed',f.store.job(job.id).progress);assert.equal(reviewed.size,100);
    assert.equal((f.store.job(job.id).result as any).measurementJobId,f.measurement.id);
    const findings=f.store.findings(f.project.id);
    assert.equal(findings.length,100);
    assert.equal(new Set(findings.map(item=>item.title)).size,1);
    assert.equal(new Set(findings.flatMap(item=>item.evidenceIds)).size,101);
    assert.ok(findings.every(item => item.evidenceIds.includes(f.store.observations(f.project.id, f.measurement.id)[0].id)), 'Every accepted opportunity links its page change to a saved answer');
    assert.equal(findings.reduce((total,item)=>total+item.steps.length,0),100);
    const count=f.store.findings(f.project.id).length;
    await f.runner.execute(f.store.job(job.id),f.project,new AbortController().signal);
    assert.equal(f.store.findings(f.project.id).length,count);
  } finally {globalThis.fetch=original;await f.close();}
});

test('batch analysis can review a supplied context page but rejects a page absent from all supplied evidence', async () => {
  const f = fixture(), original = globalThis.fetch;
  let reviewedContext = false, foreign = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 32768 }] });
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    if (request.instructions === prompts.contentGaps) return stream(JSON.stringify({ recommendations: [], uncertainties: [] }));
    if (request.instructions === prompts.opportunityReview) {
      const candidate = input.candidates[0];
      assert.ok(input.pages.some((page:any) => page.id === candidate.targetPageId && page.text.length > 2000), 'Review receives the full target excerpt, beyond the shorter site context');
      reviewedContext = true;
      return stream(JSON.stringify({ accepted: [{ index: 0, title: candidate.title, description: candidate.description, steps: candidate.steps, opportunity: { type: 'page_update', pageLabel: 'Resource', pageTitle: 'Support workspace', benefit: 'Explain the supported customer workflow.' } }] }));
    }
    assert.equal(request.instructions, prompts.diagnose);
    const contextPage = input.website.sources.find((page:any) => !input.pages.some((target:any) => target.id === page.id));
    return stream(JSON.stringify({ recommendations: contextPage || foreign ? [{ title: 'Explain the supported workflow', description: 'Clarify the workflow covered in the saved answer.', priority: 'medium', targetPageId: foreign ? 'unknown-page' : contextPage.id, evidenceIds: [foreign ? 'unknown-page' : contextPage.id, input.observations[0].id], steps: ['Check the published explanation before editing.'] }] : [], uncertainties: [] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'context-page');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    assert.equal(reviewedContext, true);
    assert.equal(f.store.findings(f.project.id).length, 1);
    foreign = true;
    const invalid = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'foreign-page');
    await f.runner.tick();
    assert.equal(f.store.job(invalid.id).status, 'paused');
    assert.equal(f.store.job(invalid.id).error, 'evidence');
    assert.equal(f.store.findings(f.project.id).filter(finding => finding.jobId === invalid.id).length, 0);
  } finally { globalThis.fetch = original; await f.close(); }
});

test('content uses bounded relevant evidence and revisions preserve every original source', async () => {
  const f=fixture(), original=globalThis.fetch;
  let sourceIds:string[]=[], draft='', editInstructions:unknown[]=[];
  globalThis.fetch=(async (url,init) => {
    if(String(url).endsWith('/models')) return json({models:[{slug:'fixture',display_name:'Fixture',visibility:'list',context_window:200000}]});
    const request=JSON.parse(init!.body as string), input=JSON.parse(request.input[0].content);
    assert.ok(Buffer.byteLength(request.instructions+request.input[0].content,'utf8')+5096<=200000);
    if(request.instructions===prompts.research) {
      if(!sourceIds.length)sourceIds=input.sources.map((page:any)=>page.id);
      else assert.deepEqual(new Set(input.sources.map((page:any)=>page.id)),new Set(sourceIds));
      assert.ok(input.sources.length<100);
      draft='# Organize customer questions\n\nA shared workspace keeps questions organized. [Source: Support workspace]('+input.sources[0].url+')';
      return stream(JSON.stringify({facts:[{claim:'A shared workspace keeps questions organized.',evidenceIds:[input.sources[0].id]}],unknowns:[]}));
    }
    if(request.instructions===prompts.verify || request.instructions===prompts.verifyFinal)return stream(JSON.stringify({issues:[],requiresHumanReview:true}));
    if(request.instructions===prompts.edit)editInstructions.push(input.revisionInstructions);
    return stream(request.instructions===prompts.brief ? '# Brief\n\nExplain the supported workflow.' : draft);
  }) as typeof fetch;
  try {
    const job=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'content',provider:'chatgpt',topic:'Organize customer questions'}),'content');
    await f.runner.tick();assert.equal(f.store.job(job.id).status,'completed');
    const doc=f.store.artifacts<any>(f.project.id,'content')[0];
    assert.equal(doc.sourceCoverage.pagesAvailable,100);assert.equal(doc.sourceCoverage.pagesUsed,sourceIds.length);
    const revision=f.store.enqueue(jobInput.parse({projectId:f.project.id,kind:'revise',provider:'chatgpt',contentId:doc.id,revisionInstructions:'Make the opening clearer.'}),'revision');
    await f.runner.tick();assert.equal(f.store.job(revision.id).status,'completed');
    assert.deepEqual(editInstructions,[undefined,'Make the opening clearer.'],'the final edit keeps the changes a revision asked for');
    assert.deepEqual(new Set(f.store.artifacts<any>(f.project.id,'content')[0].sourceEvidence.map((source:any)=>source.id)),new Set(sourceIds));
    const tiny=contentSources(f.pages,'customer questions',10000);
    assert.ok(Buffer.byteLength(JSON.stringify(tiny.sources),'utf8')<=10000);
  } finally {globalThis.fetch=original;await f.close();}
});

test('a homepage summary is valid target evidence and receives its full excerpt during review', async () => {
  const f = fixture(), original = globalThis.fetch;
  for (const page of f.pages.slice(3)) f.store.db.prepare('DELETE FROM artifacts WHERE id=?').run(page.id);
  const home = parsePage('https://example.com/', 200, '<title>Welcome</title><h1>Welcome</h1><p>' + 'A software business serves organizations with a shared workspace. '.repeat(170) + '</p>');
  f.store.put('page', f.project.id, f.audit.id, home);
  let proposed = false, reviewed = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 50000 }] });
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    if (request.instructions === prompts.contentGaps) return stream(JSON.stringify({ recommendations: [], uncertainties: [] }));
    if (request.instructions === prompts.opportunityReview) {
      assert.ok(input.pages.some((page:any) => page.id === home.id && page.text.length > input.siteOverview.text.length));
      reviewed = true;
      return stream(JSON.stringify({ accepted: [{ index: 0, title: 'Explain the supported workflow', description: 'Clarify how the workspace serves the observed need.', steps: ['Review the current workflow explanation.'], opportunity: { type: 'page_update', pageLabel: 'Homepage', pageTitle: 'Welcome', benefit: 'Help visitors evaluate the supported workflow.' } }] }));
    }
    assert.equal(request.instructions, prompts.diagnose);
    assert.equal(input.siteOverview.id, home.id);
    if (!proposed && !input.pages.some((page:any) => page.id === home.id)) {
      assert.ok(!input.website.sources.some((page:any) => page.id === home.id));
      proposed = true;
      return stream(JSON.stringify({ recommendations: [{ title: 'Explain the supported workflow', description: 'Clarify how the workspace serves the observed need.', priority: 'medium', targetPageId: home.id, evidenceIds: [home.id, input.observations[0].id], steps: ['Review the current workflow explanation.'] }], uncertainties: [] }));
    }
    return stream(JSON.stringify({ recommendations: [], uncertainties: [] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'homepage-context');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed', f.store.job(job.id).progress);
    assert.equal(proposed, true);
    assert.equal(reviewed, true);
    assert.equal(f.store.findings(f.project.id)[0].targetUrl, home.url);
  } finally { globalThis.fetch = original; await f.close(); }
});

test('opportunity drafts freeze their purpose, retain the target page across interruption, and preserve import and revision lineage', async () => {
  const f = fixture(), original = globalThis.fetch;
  const target = f.pages.at(-1)!;
  const finding = { id: randomUUID(), projectId: f.project.id, jobId: f.measurement.id,
    title: 'Explain the supported workflow', description: 'Review the page and clarify how teams can organize their questions.',
    priority: 'medium' as const, targetUrl: target.url, evidenceIds: [target.id],
    steps: ['Add supported steps to the existing page.'], confidence: 'inferred' as const, status: 'open' as const, kind: 'analysis' };
  f.store.put('finding', f.project.id, f.measurement.id, finding);
  let quota = true, researchCalls = 0;
  const inputs: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 200000 }] });
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    inputs.push(input);
    assert.equal(input.task.mode, 'page_update');
    assert.equal(input.task.findingId, finding.id);
    assert.equal(input.task.recommendation.title, finding.title);
    if (request.instructions === prompts.research) {
      researchCalls++;
      assert.equal(input.sources[0].id, target.id);
      return stream(JSON.stringify({ facts: [{ claim: 'A shared workspace keeps questions organized.', evidenceIds: [target.id] }], unknowns: [] }));
    }
    if (request.instructions === prompts.brief && quota) return new Response('{}', { status: 429 });
    if (request.instructions === prompts.verify || request.instructions === prompts.verifyFinal)
      return stream(JSON.stringify({ issues: [], requiresHumanReview: true }));
    return stream(request.instructions === prompts.brief ? '# Page brief\n\nClarify the existing workflow.' : '# Organize customer questions\n\nA shared workspace keeps questions organized. [Source: Support workspace](' + target.url + ')');
  }) as typeof fetch;
  try {
    const input = jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: finding.id });
    const job = f.store.enqueue(input, 'page-copy');
    assert.equal(f.store.enqueue(input, 'page-copy').id, job.id);
    assert.throws(() => f.store.enqueue(input, 'duplicate-page-copy'), /already saved/);
    await f.runner.tick();
    assert.equal(f.store.job(job.id).error, 'quota');
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(JSON.stringify({ ...finding, title: 'A later recommendation', steps: ['A different task.'] }), finding.id);
    f.store.updateJob(f.audit.id, { status: 'failed' });
    quota = false; f.runner.resume(job.id, false); await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    assert.equal(researchCalls, 1);
    const doc = f.store.artifacts<any>(f.project.id, 'content')[0];
    assert.equal(doc.task.mode, 'page_update');
    assert.equal(doc.task.targetUrl, target.url);
    assert.equal(doc.task.recommendation.title, finding.title);
    assert.equal(f.store.findings(f.project.id)[0].status, 'open');
    const revision = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'revise', provider: 'chatgpt', contentId: doc.id, revisionInstructions: 'Make the steps clearer.' }), 'page-copy-revision');
    await f.runner.tick();
    assert.equal(f.store.job(revision.id).status, 'completed');
    assert.deepEqual(f.store.artifacts<any>(f.project.id, 'content')[0].task, doc.task);
    const exported = exportProject(f.store, f.project.id);
    const changedPage = structuredClone(exported);
    changedPage.content[0].task!.targetUrl = 'https://example.com/unrelated';
    assert.throws(() => previewImport(f.store, changedPage), /different target page/);
    const changedOwner = structuredClone(exported);
    changedOwner.content[0].task!.findingId = randomUUID();
    assert.throws(() => previewImport(f.store, changedOwner), /unknown opportunity/);
    const unsafePage = structuredClone(exported);
    unsafePage.content[0].task!.targetUrl = 'http://127.0.0.1/private';
    assert.throws(() => previewImport(f.store, unsafePage));
    const incompleteTask = structuredClone(exported);
    delete incompleteTask.content[0].task!.recommendation;
    assert.throws(() => previewImport(f.store, incompleteTask));
    const restored = importProject(f.store, exported);
    const imported = f.store.artifacts<any>(restored.project.id, 'content');
    assert.equal(imported.length, 2);
    assert.ok(imported.every(item => item.task.findingId === f.store.findings(restored.project.id)[0].id));
    assert.notEqual(imported[0].task.findingId, finding.id);
    assert.equal(imported[0].task.targetUrl, target.url);
    assert.equal(inputs.filter(input => input.previousDraft).length, 1);
  } finally { globalThis.fetch = original; await f.close(); }
});

test('a draft cannot use another project opportunity or silently discard its required page', async () => {
  const f = fixture();
  try {
    const finding = { id: randomUUID(), projectId: f.project.id, jobId: f.measurement.id, title: 'Improve this page', description: 'Clarify its workflow.', priority: 'medium' as const, targetUrl: f.pages[0].url, evidenceIds: [f.pages[0].id], steps: ['Clarify the workflow.'], confidence: 'inferred' as const, status: 'open' as const, kind: 'analysis' };
    f.store.put('finding', f.project.id, f.measurement.id, finding);
    const other = f.store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: other.id, kind: 'content', provider: 'chatgpt', findingId: finding.id }), 'foreign-opportunity'), /this website/);
    assert.throws(() => jobInput.parse({ projectId: f.project.id, kind: 'content', contentMode: 'page_update' }));
    assert.throws(() => contentSources(f.pages, 'customer questions', 100, [finding.targetUrl]), /more room/);
    assert.throws(() => contentSources(f.pages, 'customer questions', 65000, ['https://example.com/missing']), /not available/);
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE id=?').run(JSON.stringify({ ...finding, targetUrl: '' }), finding.id);
    const count = f.store.jobs(f.project.id).length;
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: finding.id }), 'invalid-target'));
    assert.equal(f.store.jobs(f.project.id).length, count);
    assert.equal(f.store.jobs(other.id).length, 0);
  } finally { await f.close(); }
});

test('opportunities review relevance, separate new resources and preserve draft purpose through exports', async () => {
  const f = fixture(), original = globalThis.fetch;
  const answer = f.store.observations(f.project.id, f.measurement.id)[0];
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 200000 }] });
    calls++;
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    if (request.instructions === prompts.diagnose) return stream(JSON.stringify({ recommendations: input.pages.slice(0, 1).map((page:any) => ({
      title: 'Clarify the supported workflow', description: 'Help the reader understand how questions are organized.', priority: 'medium', targetPageId: page.id, evidenceIds: [page.id, answer.id], steps: ['Check the existing explanation.'],
    })), uncertainties: [] }));
    if (request.instructions === prompts.opportunityReview) return stream(JSON.stringify({ accepted: [] }));
    assert.equal(request.instructions, prompts.contentGaps);
    const page = input.pages[0];
    return stream(JSON.stringify({ recommendations: [{ title: 'Write a guide to keeping customer questions organized', description: 'The saved answer covers organizing questions. A guide can explain the supported workflow.', priority: 'medium', targetPageId: page.id, evidenceIds: [page.id, answer.id], steps: ['Check whether an existing guide covers this need.', 'Explain the supported workflow with a clear example.'], opportunity: { type: 'new_content', pageLabel: 'Guide', pageTitle: page.title, benefit: 'Answer the practical question in the saved evidence.', topic: 'How to keep customer questions organized' } }], uncertainties: [] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'reviewed-content-gaps');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed');
    const findings = f.store.findings(f.project.id);
    assert.equal(findings.length, 1, 'Rejected page advice must not survive the independent relevance review');
    assert.equal(findings[0].opportunity?.type, 'new_content');
    assert.deepEqual(findings[0].evidenceIds, [findings[0].targetUrl && f.pages.find(page => page.url === findings[0].targetUrl)!.id, answer.id]);
    const count = calls;
    await f.runner.execute(f.store.job(job.id), f.project, new AbortController().signal);
    assert.equal(calls, count, 'Completed analysis and gap passes must not replay');
    const content = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: findings[0].id }), 'new-resource');
    assert.equal(JSON.parse(f.store.step(content.id, 'content-task')!.body!).mode, 'article');
    assert.throws(() => f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'chatgpt', findingId: findings[0].id, contentMode: 'page_update' }), 'wrong-purpose'), /new resource/);
    const exported = exportProject(f.store, f.project.id), imported = importProject(f.store, exported);
    assert.deepEqual(f.store.findings(imported.project.id)[0].opportunity, findings[0].opportunity);
  } finally { globalThis.fetch = original; await f.close(); }
});

test('an unverifiable suggestion is excluded without discarding supported work or replaying its receipt', async () => {
  const f = fixture(), original = globalThis.fetch;
  let calls = 0, proposed = false;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/models')) return json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list', context_window: 200000 }] });
    calls++;
    const request = JSON.parse(init!.body as string), input = JSON.parse(request.input[0].content);
    if (request.instructions === prompts.contentGaps) return stream(JSON.stringify({ recommendations: [], uncertainties: [] }));
    if (request.instructions === prompts.opportunityReview) return stream(JSON.stringify({ accepted: input.candidates.map((candidate:any) => ({ index: candidate.index, title: candidate.title, description: candidate.description, steps: candidate.steps, opportunity: { type: 'page_update', pageLabel: 'Guide', pageTitle: 'Support workspace', benefit: 'Answer the saved customer question.' } })) }));
    assert.equal(request.instructions, prompts.diagnose);
    if (proposed) return stream(JSON.stringify({ recommendations: [], uncertainties: [] }));
    proposed = true;
    const supported = { title: 'Clarify the supported workflow', description: 'Explain the workspace for the observed customer need.', priority: 'medium', targetPageId: input.pages[0].id, evidenceIds: [input.pages[0].id, input.observations[0].id], steps: ['Check the existing workflow explanation.'] };
    return stream(JSON.stringify({ recommendations: [supported,
      { ...supported, steps: ['Link the verified workflow instructions.'] },
      { ...supported, title: 'Unsupported workflow change', description: 'A proposed change with an unverified reference.', evidenceIds: ['unknown-reference', input.observations[0].id] },
      { ...supported, title: 'A reference without an explanation', description: 'Evidence: ' + supported.evidenceIds.join(', ') },
    ], uncertainties: [] }));
  }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'partial-supported-analysis');
    await f.runner.tick();
    assert.equal(f.store.job(job.id).status, 'completed', f.store.job(job.id).progress);
    const findings = f.store.findings(f.project.id);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].evidenceIds.every(id => id !== 'unknown-reference'));
    assert.deepEqual(findings[0].steps, ['Check the existing workflow explanation.', 'Link the verified workflow instructions.']);
    assert.equal(findings[0].description, 'Explain the workspace for the observed customer need.');
    const result = f.store.job(job.id).result as any;
    assert.equal(result.omittedSuggestions, 2);
    assert.ok(result.uncertainties.some((note:string) => note.includes('supporting evidence could not be verified')));
    const completedCalls = calls;
    await f.runner.execute(f.store.job(job.id), f.project, new AbortController().signal);
    assert.equal(calls, completedCalls);
    assert.equal(f.store.findings(f.project.id).length, 1);
  } finally { globalThis.fetch = original; await f.close(); }
});
